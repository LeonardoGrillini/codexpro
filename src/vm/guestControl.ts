import type { VmBackendKind } from "./types.js";

export const VM_GUEST_DEFAULT_TIMEOUT_MS = 30_000;
export const VM_GUEST_MAX_TIMEOUT_MS = 300_000;
export const VM_GUEST_OUTPUT_MAX_BYTES = 48 * 1024;
export const VM_GUEST_FILE_MAX_BYTES = 1024 * 1024;
export const VM_GUEST_FILE_CHUNK_BYTES = 48 * 1024;

export type VmGuestShell = "powershell" | "cmd" | "sh" | "bash";

export interface VmGuestCredential {
  username: string;
  password: string;
}

export interface VmExecOptions {
  argv?: string[];
  command?: string;
  shell?: VmGuestShell;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  credential?: VmGuestCredential;
}

export interface VmExecPlan {
  executable: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
  credential?: VmGuestCredential;
}

export interface VmExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  transport: "qemu-guest-agent" | "powershell-direct";
}

export interface VmGuestStatus {
  id: string;
  backend: VmBackendKind;
  state: string;
  available: boolean;
  canExec: boolean;
  transport: "qemu-guest-agent" | "powershell-direct";
  reason?: string;
}

function checkedString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string of at most ${max} characters without NUL bytes.`);
  }
  return value;
}

export function validateGuestCredential(value: VmGuestCredential | undefined): VmGuestCredential | undefined {
  if (!value) return undefined;
  return {
    username: checkedString(value.username, "guest username", 256),
    password: checkedString(value.password, "guest password", 4096)
  };
}

export function validateGuestTimeout(value = VM_GUEST_DEFAULT_TIMEOUT_MS): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > VM_GUEST_MAX_TIMEOUT_MS) {
    throw new Error(`guest timeout must be an integer from 100 to ${VM_GUEST_MAX_TIMEOUT_MS} ms.`);
  }
  return value;
}

function assertEnvBudget(env: Record<string, string>): void {
  let bytes = 0;
  for (const [key, value] of Object.entries(env)) {
    bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
    if (bytes > 64 * 1024) throw new Error("Guest environment exceeds the 64 KiB limit.");
  }
}

function validateEnv(input: Record<string, string> | undefined): Record<string, string> {
  const output: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new Error(`Invalid guest environment variable name: ${key}`);
    if (typeof value !== "string" || value.length > 16_384 || value.includes("\0")) {
      throw new Error(`environment variable ${key} must be at most 16384 characters without NUL bytes.`);
    }
    output[key] = value;
  }
  assertEnvBudget(output);
  return output;
}

function common(env: Record<string, string>, timeoutMs: number, credential: VmGuestCredential | undefined) {
  return { env, timeoutMs, ...(credential ? { credential } : {}) };
}

export function normalizeVmExec(options: VmExecOptions): VmExecPlan {
  const hasArgv = options.argv !== undefined;
  const hasCommand = options.command !== undefined;
  if (hasArgv === hasCommand) throw new Error("Exactly one of argv or command is required for vm_exec.");
  const env = validateEnv(options.env);
  const timeoutMs = validateGuestTimeout(options.timeoutMs);
  const credential = validateGuestCredential(options.credential);
  const cwd = options.cwd === undefined ? undefined : checkedString(options.cwd, "guest cwd", 4096);

  if (hasArgv) {
    if (options.shell !== undefined) throw new Error("shell cannot be used with argv; argv executes the program directly.");
    if (cwd !== undefined) throw new Error("cwd requires command plus an explicit shell; direct argv execution has no portable guest-agent cwd primitive.");
    if (!Array.isArray(options.argv) || options.argv.length === 0 || options.argv.length > 256) throw new Error("argv must contain 1-256 strings.");
    const argv = options.argv.map((value, index) => checkedString(value, `argv[${index}]`, 16_384));
    return { executable: argv[0], args: argv.slice(1), ...common(env, timeoutMs, credential) };
  }

  const command = checkedString(options.command, "command", 64 * 1024);
  if (!options.shell) throw new Error("command requires an explicit shell: powershell, cmd, sh, or bash.");
  if (cwd !== undefined && options.shell === "cmd") throw new Error("cwd with shell=cmd is not supported; use PowerShell for a Windows working directory.");

  if (options.shell === "sh" || options.shell === "bash") {
    const executable = options.shell === "bash" ? "/bin/bash" : "/bin/sh";
    if (!cwd) {
      return {
        executable,
        args: options.shell === "bash" ? ["-lc", command] : ["-c", command],
        ...common(env, timeoutMs, credential)
      };
    }
    env.CODEXPRO_GUEST_CWD = cwd;
    env.CODEXPRO_GUEST_COMMAND = command;
    assertEnvBudget(env);
    const wrapper = `cd -- "$CODEXPRO_GUEST_CWD" && exec ${executable} ${options.shell === "bash" ? "-lc" : "-c"} "$CODEXPRO_GUEST_COMMAND"`;
    return { executable, args: ["-c", wrapper], ...common(env, timeoutMs, credential) };
  }

  if (options.shell === "cmd") {
    return { executable: "cmd.exe", args: ["/d", "/s", "/c", command], ...common(env, timeoutMs, credential) };
  }

  if (!cwd) {
    return {
      executable: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      ...common(env, timeoutMs, credential)
    };
  }
  env.CODEXPRO_GUEST_CWD = cwd;
  env.CODEXPRO_GUEST_COMMAND = command;
  assertEnvBudget(env);
  const wrapper = "$ErrorActionPreference='Stop'; Set-Location -LiteralPath $env:CODEXPRO_GUEST_CWD; & ([ScriptBlock]::Create($env:CODEXPRO_GUEST_COMMAND))";
  return {
    executable: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", wrapper],
    ...common(env, timeoutMs, credential)
  };
}

export function boundedUtf8(value: Buffer): { text: string; truncated: boolean } {
  const truncated = value.length > VM_GUEST_OUTPUT_MAX_BYTES;
  return {
    text: value.subarray(0, VM_GUEST_OUTPUT_MAX_BYTES).toString("utf8").replace(/\uFFFD$/, ""),
    truncated
  };
}

export function validateGuestFileData(data: Buffer): Buffer {
  if (data.length > VM_GUEST_FILE_MAX_BYTES) {
    throw new Error(`VM guest file transfer is limited to ${VM_GUEST_FILE_MAX_BYTES} bytes per file.`);
  }
  return data;
}
