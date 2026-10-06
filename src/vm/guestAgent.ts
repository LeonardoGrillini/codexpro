import { randomBytes } from "node:crypto";
import net from "node:net";
import type { LocalChannelEndpoint } from "./types.js";
import { VM_GUEST_FILE_CHUNK_BYTES } from "./guestControl.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface GuestAgentInfo {
  version?: string;
  supported_commands?: Array<{ name: string; enabled: boolean; "success-response"?: boolean }>;
}

export interface GuestExecStatus {
  exited: boolean;
  exitcode?: number;
  signal?: number;
  "out-data"?: string;
  "err-data"?: string;
  "out-truncated"?: boolean;
  "err-truncated"?: boolean;
}

// guest-exec may return large base64 capture fields; keep the wire buffer bounded below QEMU's JSON parser ceiling.
const QGA_BUFFER_MAX_BYTES = 48 * 1024 * 1024;

function windowsPipePath(name: string): string {
  return `\\\\.\\pipe\\${name}`;
}

function socketForEndpoint(endpoint: LocalChannelEndpoint): net.Socket {
  if (endpoint.transport === "unix") return net.createConnection({ path: endpoint.path });
  if (endpoint.transport === "pipe") return net.createConnection({ path: windowsPipePath(endpoint.name) });
  return net.createConnection({ host: endpoint.host, port: endpoint.port });
}

async function connectSocket(endpoint: LocalChannelEndpoint, timeoutMs: number): Promise<net.Socket> {
  const socket = socketForEndpoint(endpoint);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`Timed out connecting to QEMU Guest Agent after ${timeoutMs} ms.`));
    }, timeoutMs);
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
  return socket;
}

export class GuestAgentClient {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private nextId = 1;
  private needsSync = true;
  private readonly pending = new Map<number, PendingRequest>();

  private constructor(private readonly socket: net.Socket) {
    socket.on("data", (chunk) => this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("QEMU Guest Agent connection closed.")));
  }

  static async connect(endpoint: LocalChannelEndpoint, timeoutMs = 1_000): Promise<GuestAgentClient> {
    const socket = await connectSocket(endpoint, timeoutMs);
    const client = new GuestAgentClient(socket);
    try {
      await client.syncDelimited(Math.max(100, timeoutMs));
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    const sentinel = this.buffer.lastIndexOf(0xff);
    if (sentinel >= 0) {
      this.buffer = this.buffer.subarray(sentinel + 1);
    }

    if (this.buffer.length > QGA_BUFFER_MAX_BYTES) {
      this.fail(new Error("QEMU Guest Agent response exceeded the protocol buffer limit."));
      this.socket.destroy();
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.buffer.subarray(0, newline).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line) continue;
      let message: any;
      try { message = JSON.parse(line); } catch { continue; }
      if (typeof message?.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`QEMU Guest Agent command failed: ${String(message.error.desc ?? message.error.class ?? "unknown error")}`));
      } else {
        pending.resolve(message.return);
      }
    }
  }

  private fail(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private request(command: string, args?: Record<string, unknown>, timeoutMs = 1_500): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.needsSync = true;
        reject(new Error(`QEMU Guest Agent command ${command} timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = args === undefined ? { execute: command, id } : { execute: command, arguments: args, id };
      this.socket.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  private async syncDelimited(timeoutMs: number): Promise<void> {
    const token = randomBytes(6).readUIntBE(0, 6);
    this.buffer = Buffer.alloc(0);
    this.socket.write(Buffer.from([0xff]));
    const result = await this.request("guest-sync-delimited", { id: token }, timeoutMs);
    if (result !== token) throw new Error("QEMU Guest Agent synchronization returned an unexpected token.");
    this.needsSync = false;
  }

  private async command<T>(name: string, args?: Record<string, unknown>, timeoutMs = 1_500): Promise<T> {
    if (this.needsSync) await this.syncDelimited(timeoutMs);
    return this.request(name, args, timeoutMs) as Promise<T>;
  }

  async ping(timeoutMs = 1_500): Promise<void> {
    await this.command("guest-ping", undefined, timeoutMs);
  }

  info(timeoutMs = 1_500): Promise<GuestAgentInfo> {
    return this.command<GuestAgentInfo>("guest-info", undefined, timeoutMs);
  }

  async exec(path: string, args: string[], env: Record<string, string>, timeoutMs = 1_500): Promise<number> {
    const result = await this.command<{ pid: number }>("guest-exec", {
      path,
      arg: args,
      env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      "capture-output": true
    }, timeoutMs);
    if (!Number.isSafeInteger(result?.pid) || result.pid <= 0) throw new Error("QEMU Guest Agent returned an invalid guest process id.");
    return result.pid;
  }

  execStatus(pid: number, timeoutMs = 1_500): Promise<GuestExecStatus> {
    return this.command<GuestExecStatus>("guest-exec-status", { pid }, timeoutMs);
  }

  fileOpen(path: string, mode: string, timeoutMs = 1_500): Promise<number> {
    return this.command<number>("guest-file-open", { path, mode }, timeoutMs);
  }

  fileClose(handle: number, timeoutMs = 1_500): Promise<void> {
    return this.command<void>("guest-file-close", { handle }, timeoutMs);
  }

  fileFlush(handle: number, timeoutMs = 1_500): Promise<void> {
    return this.command<void>("guest-file-flush", { handle }, timeoutMs);
  }

  fileRead(handle: number, count = VM_GUEST_FILE_CHUNK_BYTES, timeoutMs = 1_500): Promise<{ count: number; "buf-b64": string; eof: boolean }> {
    return this.command("guest-file-read", { handle, count }, timeoutMs);
  }

  fileWrite(handle: number, data: Buffer, timeoutMs = 1_500): Promise<{ count: number; eof: boolean }> {
    return this.command("guest-file-write", { handle, "buf-b64": data.toString("base64"), count: data.length }, timeoutMs);
  }

  close(): void {
    this.socket.destroy();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForGuestAgent(endpoint: LocalChannelEndpoint, timeoutMs = 12_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let client: GuestAgentClient | undefined;
    try {
      client = await GuestAgentClient.connect(endpoint, Math.min(750, Math.max(100, deadline - Date.now())));
      await client.ping(Math.min(1_500, Math.max(100, deadline - Date.now())));
      client.close();
      return true;
    } catch {
      client?.close();
      await sleep(300);
    }
  }
  return false;
}
