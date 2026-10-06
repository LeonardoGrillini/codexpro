import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { codexProHome, profileIdForRoot } from "./profileStore.js";
import { redactSensitiveText } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface LogFileInfo {
  runId: string;
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
}

export interface LogRecord extends Record<string, unknown> {
  timestamp: string;
  level: LogLevel;
  event: string;
  run_id: string;
  pid: number;
}

export interface LogSnapshot {
  runId: string;
  baseDir: string;
  runDir: string;
  files: LogFileInfo[];
  entries: LogRecord[];
}

export interface LogTailOptions {
  runId?: string;
  maxLines?: number;
  maxBytes?: number;
}

export interface ChildCaptureOptions {
  maxBytesPerStream?: number;
  outputLevel?: "debug" | "info";
}

export interface CodexProLogger {
  readonly runId: string;
  readonly baseDir: string;
  readonly runDir: string;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, error: unknown, fields?: LogFields): void;
  child(context: LogFields): CodexProLogger;
  captureChildProcess(child: ChildProcess, name: string, fields?: LogFields, options?: ChildCaptureOptions): () => void;
  listFiles(limit?: number): LogFileInfo[];
  tail(options?: LogTailOptions): LogRecord[];
  snapshot(options?: LogTailOptions): LogSnapshot;
}

export interface LoggerOptions {
  workspaceRoot: string;
  component?: string;
  runId?: string;
  maxFileBytes?: number;
  maxFilesPerProcess?: number;
  maxRuns?: number;
  maxTotalBytes?: number;
}

const contextStorage = new AsyncLocalStorage<LogFields>();
const RESERVED_FIELDS = new Set(["timestamp", "level", "event", "run_id", "pid", "ppid", "seq"]);
const SENSITIVE_FIELD = /(?:^|[_-])(?:prompt|task|context|content|message|body|headers?|authorization|cookie|set_cookie|token|secret|password|passphrase|api[_-]?key|apikey|private[_-]?key|credentials?|answer|response|raw[_-]?response|file[_-]?(?:content|text))$/i;
const RUN_ID = /^[a-zA-Z0-9._-]{1,120}$/;
const MAX_STRING_CHARS = 16_000;
const MAX_ARRAY_ITEMS = 64;
const MAX_OBJECT_KEYS = 96;
const MAX_DEPTH = 7;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES_PER_PROCESS = 5;
const DEFAULT_MAX_RUNS = 20;
const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const DEFAULT_TAIL_LINES = 200;
const DEFAULT_TAIL_BYTES = 512 * 1024;

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, Math.trunc(numeric))) : fallback;
}

function truncateText(value: string, maxChars = MAX_STRING_CHARS): string {
  const redacted = redactSensitiveText(value);
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}…[truncated ${redacted.length - maxChars} chars]`;
}

function sanitizeValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return truncateText(value);
  if (typeof value === "symbol" || typeof value === "function") return String(value);
  if (depth >= MAX_DEPTH) return "[truncated-depth]";
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return serializeError(value);
  if (Buffer.isBuffer(value)) return `[buffer ${value.byteLength} bytes]`;
  if (typeof value !== "object") return truncateText(String(value));
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[+${value.length - MAX_ARRAY_ITEMS} items]`);
    return items;
  }
  const output: Record<string, unknown> = {};
  let count = 0;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_OBJECT_KEYS) {
      output._truncated_keys = true;
      break;
    }
    count += 1;
    output[key] = SENSITIVE_FIELD.test(key) ? "[REDACTED_FIELD]" : sanitizeValue(child, depth + 1, seen);
  }
  return output;
}

function sanitizeFields(fields: LogFields | undefined): LogFields {
  if (!fields) return {};
  const output: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (RESERVED_FIELDS.has(key)) continue;
    output[key] = SENSITIVE_FIELD.test(key) ? "[REDACTED_FIELD]" : sanitizeValue(value);
  }
  return output;
}

export function serializeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: "NonError", message: truncateText(String(error)) };
  const output: Record<string, unknown> = {
    name: truncateText(error.name || "Error", 256),
    message: truncateText(error.message || String(error)),
    ...(error.stack ? { stack: truncateText(error.stack, 32_000) } : {})
  };
  const candidate = error as Error & { code?: unknown; cause?: unknown };
  if (candidate.code !== undefined) output.code = sanitizeValue(candidate.code);
  if (candidate.cause !== undefined && depth < 3) output.cause = serializeError(candidate.cause, depth + 1);
  return output;
}

export function withLogContext<T>(context: LogFields, fn: () => T): T {
  const current = contextStorage.getStore() ?? {};
  return contextStorage.run({ ...current, ...context }, fn);
}

function directorySize(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) total += directorySize(candidate);
      else if (entry.isFile()) total += fs.statSync(candidate).size;
    }
  } catch {
    return total;
  }
  return total;
}

function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

function pruneRuns(baseDir: string, currentRunId: string, maxRuns: number, maxTotalBytes: number): void {
  let runs: Array<{ name: string; path: string; mtimeMs: number; size: number }> = [];
  try {
    runs = fs.readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name))
      .map((entry) => {
        const runPath = path.join(baseDir, entry.name);
        const stat = fs.statSync(runPath);
        return { name: entry.name, path: runPath, mtimeMs: stat.mtimeMs, size: directorySize(runPath) };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return;
  }
  let total = runs.reduce((sum, run) => sum + run.size, 0);
  const removable = runs.filter((run) => run.name !== currentRunId).sort((a, b) => a.mtimeMs - b.mtimeMs);
  while (runs.length > maxRuns || total > maxTotalBytes) {
    const run = removable.shift();
    if (!run) break;
    try {
      fs.rmSync(run.path, { recursive: true, force: true });
      total -= run.size;
      runs = runs.filter((candidate) => candidate.name !== run.name);
    } catch {}
  }
}

function makeRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-p${process.pid}-${randomUUID().slice(0, 8)}`;
}

function fileNameForPid(pid: number, rotated = 0): string {
  return rotated > 0 ? `codexpro-${pid}.${rotated}.jsonl` : `codexpro-${pid}.jsonl`;
}

class LogSink {
  readonly workspaceId: string;
  readonly baseDir: string;
  readonly runDir: string;
  readonly runId: string;
  private readonly maxFileBytes: number;
  private readonly maxFilesPerProcess: number;
  private readonly filePath: string;
  private bytes = 0;
  private seq = 0;

  constructor(options: LoggerOptions) {
    this.workspaceId = profileIdForRoot(options.workspaceRoot);
    this.baseDir = path.join(codexProHome(), "logs", this.workspaceId);
    const inheritedRunId = options.runId ?? process.env.CODEXPRO_LOG_RUN_ID;
    this.runId = inheritedRunId && RUN_ID.test(inheritedRunId) ? inheritedRunId : makeRunId();
    this.runDir = path.join(this.baseDir, this.runId);
    this.maxFileBytes = boundedInt(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 64 * 1024, 1024 * 1024 * 1024);
    this.maxFilesPerProcess = boundedInt(options.maxFilesPerProcess, DEFAULT_MAX_FILES_PER_PROCESS, 1, 50);
    ensurePrivateDirectory(this.runDir);
    pruneRuns(
      this.baseDir,
      this.runId,
      boundedInt(options.maxRuns, DEFAULT_MAX_RUNS, 1, 500),
      boundedInt(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, this.maxFileBytes, 10 * 1024 * 1024 * 1024)
    );
    this.filePath = path.join(this.runDir, fileNameForPid(process.pid));
    try { this.bytes = fs.statSync(this.filePath).size; } catch { this.bytes = 0; }
  }

  private rotate(): void {
    if (this.maxFilesPerProcess <= 1) {
      try { fs.truncateSync(this.filePath, 0); } catch {}
      this.bytes = 0;
      return;
    }
    for (let index = this.maxFilesPerProcess - 1; index >= 2; index -= 1) {
      const source = path.join(this.runDir, fileNameForPid(process.pid, index - 1));
      const target = path.join(this.runDir, fileNameForPid(process.pid, index));
      try { fs.rmSync(target, { force: true }); } catch {}
      try { fs.renameSync(source, target); } catch {}
    }
    const firstRotated = path.join(this.runDir, fileNameForPid(process.pid, 1));
    try { fs.rmSync(firstRotated, { force: true }); } catch {}
    try { fs.renameSync(this.filePath, firstRotated); } catch {}
    this.bytes = 0;
  }

  write(level: LogLevel, event: string, childContext: LogFields, fields?: LogFields, error?: unknown): void {
    try {
      const context = sanitizeFields({ ...(contextStorage.getStore() ?? {}), ...childContext });
      const data = sanitizeFields(fields);
      const record: LogRecord = {
        ...context,
        ...data,
        ...(error !== undefined ? { error: serializeError(error) } : {}),
        timestamp: new Date().toISOString(),
        level,
        event: truncateText(event, 256),
        run_id: this.runId,
        workspace_id: this.workspaceId,
        pid: process.pid,
        ppid: process.ppid,
        seq: ++this.seq,
        process_uptime_ms: Math.round(process.uptime() * 1000)
      };
      const line = `${JSON.stringify(record)}\n`;
      const lineBytes = Buffer.byteLength(line);
      if (this.bytes > 0 && this.bytes + lineBytes > this.maxFileBytes) this.rotate();
      fs.appendFileSync(this.filePath, line, { encoding: "utf8", mode: 0o600, flag: "a" });
      this.bytes += lineBytes;
      try { fs.chmodSync(this.filePath, 0o600); } catch {}
    } catch (writeError) {
      const detail = writeError instanceof Error ? redactSensitiveText(writeError.message) : redactSensitiveText(String(writeError));
      console.error(`[CodexPro] persistent logging failed: ${detail}`);
    }
  }

  listFiles(limit = 100): LogFileInfo[] {
    const boundedLimit = boundedInt(limit, 100, 1, 1000);
    const files: LogFileInfo[] = [];
    try {
      const runDirs = fs.readdirSync(this.baseDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name))
        .map((entry) => entry.name);
      for (const runId of runDirs) {
        const runDir = path.join(this.baseDir, runId);
        for (const entry of fs.readdirSync(runDir, { withFileTypes: true })) {
          if (!entry.isFile() || !/^codexpro-\d+(?:\.\d+)?\.jsonl$/.test(entry.name)) continue;
          const filePath = path.join(runDir, entry.name);
          const stat = fs.statSync(filePath);
          files.push({ runId, name: entry.name, path: filePath, size: stat.size, modifiedAt: stat.mtime.toISOString() });
        }
      }
    } catch {}
    return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, boundedLimit);
  }

  tail(options: LogTailOptions = {}): LogRecord[] {
    const runId = options.runId && RUN_ID.test(options.runId) ? options.runId : this.runId;
    const maxLines = boundedInt(options.maxLines, DEFAULT_TAIL_LINES, 1, 5000);
    const maxBytes = boundedInt(options.maxBytes, DEFAULT_TAIL_BYTES, 4096, 8 * 1024 * 1024);
    const runDir = path.join(this.baseDir, runId);
    if (path.dirname(runDir) !== this.baseDir) return [];
    let candidates: Array<{ path: string; mtimeMs: number; size: number }> = [];
    try {
      candidates = fs.readdirSync(runDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^codexpro-\d+(?:\.\d+)?\.jsonl$/.test(entry.name))
        .map((entry) => {
          const filePath = path.join(runDir, entry.name);
          const stat = fs.statSync(filePath);
          return { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
      return [];
    }

    const rawLines: string[] = [];
    let remaining = maxBytes;
    for (const file of candidates) {
      if (remaining <= 0 || rawLines.length >= maxLines * 3) break;
      const bytes = Math.min(file.size, remaining);
      if (bytes <= 0) continue;
      const fd = fs.openSync(file.path, "r");
      try {
        const buffer = Buffer.allocUnsafe(bytes);
        fs.readSync(fd, buffer, 0, bytes, file.size - bytes);
        let text = buffer.toString("utf8");
        if (bytes < file.size) text = text.slice(text.indexOf("\n") + 1);
        rawLines.push(...text.split(/\r?\n/).filter(Boolean));
        remaining -= bytes;
      } finally {
        fs.closeSync(fd);
      }
    }

    const records: LogRecord[] = [];
    for (const line of rawLines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") records.push(parsed as LogRecord);
      } catch {}
    }
    records.sort((a, b) => {
      const byTime = String(a.timestamp).localeCompare(String(b.timestamp));
      if (byTime !== 0) return byTime;
      const byPid = Number(a.pid ?? 0) - Number(b.pid ?? 0);
      if (byPid !== 0) return byPid;
      return Number(a.seq ?? 0) - Number(b.seq ?? 0);
    });
    return records.slice(-maxLines);
  }
}

class LoggerImpl implements CodexProLogger {
  constructor(private readonly sink: LogSink, private readonly context: LogFields = {}) {}

  get runId(): string { return this.sink.runId; }
  get baseDir(): string { return this.sink.baseDir; }
  get runDir(): string { return this.sink.runDir; }

  debug(event: string, fields?: LogFields): void { this.sink.write("debug", event, this.context, fields); }
  info(event: string, fields?: LogFields): void { this.sink.write("info", event, this.context, fields); }
  warn(event: string, fields?: LogFields): void { this.sink.write("warn", event, this.context, fields); }
  error(event: string, error: unknown, fields?: LogFields): void { this.sink.write("error", event, this.context, fields, error); }

  child(context: LogFields): CodexProLogger {
    return new LoggerImpl(this.sink, { ...this.context, ...context });
  }

  captureChildProcess(child: ChildProcess, name: string, fields: LogFields = {}, options: ChildCaptureOptions = {}): () => void {
    const logger = this.child({ child_process: name, child_pid: child.pid ?? null, ...fields });
    const maxBytes = boundedInt(options.maxBytesPerStream, 64 * 1024, 1024, 4 * 1024 * 1024);
    const outputLevel = options.outputLevel ?? "debug";
    const seen = { stdout: 0, stderr: 0 };
    const truncated = { stdout: false, stderr: false };
    const listeners: Array<() => void> = [];

    const attachStream = (streamName: "stdout" | "stderr", stream: NodeJS.ReadableStream | null | undefined): void => {
      if (!stream || typeof stream.on !== "function") return;
      const onData = (chunk: unknown) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        const remaining = Math.max(0, maxBytes - seen[streamName]);
        if (remaining > 0) {
          const captured = buffer.subarray(0, remaining);
          seen[streamName] += captured.byteLength;
          const text = truncateText(captured.toString("utf8"), Math.min(MAX_STRING_CHARS, remaining));
          if (text) logger[outputLevel]("child_process_output", { stream: streamName, text });
        }
        if (buffer.byteLength > remaining && !truncated[streamName]) {
          truncated[streamName] = true;
          logger.warn("child_process_output_truncated", { stream: streamName, max_bytes: maxBytes });
        }
      };
      stream.on("data", onData);
      listeners.push(() => stream.off("data", onData));
    };

    attachStream("stdout", child.stdout);
    attachStream("stderr", child.stderr);
    const onError = (error: Error) => logger.error("child_process_error", error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      logger.info("child_process_exit", { exit_code: code, signal, stdout_bytes: seen.stdout, stderr_bytes: seen.stderr, output_truncated: truncated });
    };
    child.on("error", onError);
    child.on("exit", onExit);
    listeners.push(() => child.off("error", onError), () => child.off("exit", onExit));
    logger.info("child_process_observed", { child_pid: child.pid ?? null });

    return () => { for (const remove of listeners) remove(); };
  }

  listFiles(limit?: number): LogFileInfo[] { return this.sink.listFiles(limit); }
  tail(options?: LogTailOptions): LogRecord[] { return this.sink.tail(options); }
  snapshot(options?: LogTailOptions): LogSnapshot {
    return {
      runId: this.runId,
      baseDir: this.baseDir,
      runDir: this.runDir,
      files: this.listFiles(100).filter((file) => file.runId === (options?.runId ?? this.runId)),
      entries: this.tail(options)
    };
  }
}

class NoopLogger implements CodexProLogger {
  readonly runId = "";
  readonly baseDir = "";
  readonly runDir = "";
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): CodexProLogger { return this; }
  captureChildProcess(): () => void { return () => {}; }
  listFiles(): LogFileInfo[] { return []; }
  tail(): LogRecord[] { return []; }
  snapshot(): LogSnapshot { return { runId: "", baseDir: "", runDir: "", files: [], entries: [] }; }
}

export const noopLogger: CodexProLogger = new NoopLogger();

export function createCodexProLogger(options: LoggerOptions): CodexProLogger {
  const sink = new LogSink(options);
  return new LoggerImpl(sink, {
    workspace_root: path.resolve(options.workspaceRoot),
    ...(options.component ? { component: options.component } : {})
  });
}
