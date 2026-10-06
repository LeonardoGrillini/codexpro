#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-logging-smoke-"));
const home = path.join(tmp, "home");
const root = path.join(tmp, "repo");
fs.mkdirSync(root, { recursive: true });
process.env.CODEXPRO_HOME = home;

try {
  const { createCodexProLogger, withLogContext } = await import("../dist/logging.js");
  const sentinel = "replace-me-logging-smoke-1234";
  const logger = createCodexProLogger({
    workspaceRoot: root,
    runId: "smoke-run",
    maxFileBytes: 64 * 1024,
    maxFilesPerProcess: 3,
    maxRuns: 3,
    maxTotalBytes: 4 * 1024 * 1024
  });

  const agentLogger = logger.child({ agent_id: "agent-1", backend_session_id: "backend-1" });
  withLogContext({ mcp_session_id: "session-1", tool: "spawn_agent", tool_call_id: "call-1" }, () => {
    agentLogger.info("redaction_check", {
      prompt: sentinel,
      context_attached: true,
      response_chars: 42,
      nested: {
        token: sentinel,
        ordinary: "safe"
      }
    });
  });
  await withLogContext({ mcp_session_id: "session-async", tool: "spawn_agent", tool_call_id: "call-async" }, async () => {
    await Promise.resolve();
    agentLogger.info("async_context_check");
  });
  agentLogger.error("exception_check", new Error(`codexpro_token=${sentinel}`), { phase: "send" });

  const child = spawn(process.execPath, ["-e", `process.stdout.write(("codexpro_token=${sentinel}\\n").repeat(512))`], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  logger.captureChildProcess(child, "logging-smoke-child", {}, { maxBytesPerStream: 2048 });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited with ${code}`)));
  });

  const diagnosticSnapshot = logger.snapshot({ maxLines: 1000, maxBytes: 4 * 1024 * 1024 });
  const redaction = diagnosticSnapshot.entries.find((entry) => entry.event === "redaction_check");
  assert.ok(redaction, "redaction event should be readable through tail()");
  assert.equal(redaction.mcp_session_id, "session-1");
  assert.equal(redaction.tool, "spawn_agent");
  assert.equal(redaction.tool_call_id, "call-1");
  assert.equal(redaction.agent_id, "agent-1");
  assert.equal(redaction.workspace_root, path.resolve(root));
  assert.equal(redaction.prompt, "[REDACTED_FIELD]");
  assert.equal(redaction.context_attached, true);
  assert.equal(redaction.response_chars, 42);
  assert.equal(redaction.nested.token, "[REDACTED_FIELD]");
  assert.equal(redaction.nested.ordinary, "safe");

  const asyncContext = diagnosticSnapshot.entries.find((entry) => entry.event === "async_context_check");
  assert.equal(asyncContext?.mcp_session_id, "session-async");
  assert.equal(asyncContext?.tool, "spawn_agent");
  assert.equal(asyncContext?.tool_call_id, "call-async");

  const exception = diagnosticSnapshot.entries.find((entry) => entry.event === "exception_check");
  assert.ok(exception?.error?.stack, "exceptions should retain a redacted stack");
  assert.ok(!JSON.stringify(exception).includes(sentinel), "exception serialization must redact secret assignments");

  assert.ok(diagnosticSnapshot.entries.some((entry) => entry.event === "child_process_exit"), "child exit should be logged");
  assert.ok(diagnosticSnapshot.entries.some((entry) => entry.event === "child_process_output_truncated"), "child output should be bounded");

  const raw = diagnosticSnapshot.files.map((file) => fs.readFileSync(file.path, "utf8")).join("\n");
  assert.ok(!raw.includes(sentinel), "persisted JSONL must not contain redacted values");
  for (const line of raw.split(/\r?\n/).filter(Boolean)) JSON.parse(line);

  for (let index = 0; index < 40; index += 1) {
    logger.debug("rotation_fill", { index, diagnostic: "x".repeat(5000) });
  }
  const rotationSnapshot = logger.snapshot({ maxLines: 1000, maxBytes: 4 * 1024 * 1024 });
  assert.equal(rotationSnapshot.runId, "smoke-run");
  assert.equal(rotationSnapshot.runDir, logger.runDir);
  assert.ok(rotationSnapshot.files.length >= 1 && rotationSnapshot.files.length <= 3, "rotation should keep a bounded number of files");

  createCodexProLogger({ workspaceRoot: root, runId: "old-1", maxRuns: 2, maxTotalBytes: 4 * 1024 * 1024 }).info("retention_seed");
  createCodexProLogger({ workspaceRoot: root, runId: "old-2", maxRuns: 2, maxTotalBytes: 4 * 1024 * 1024 }).info("retention_seed");
  const latest = createCodexProLogger({ workspaceRoot: root, runId: "current", maxRuns: 2, maxTotalBytes: 4 * 1024 * 1024 });
  latest.info("retention_seed");
  const runDirs = fs.readdirSync(latest.baseDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.ok(runDirs.includes("current"), "retention must never prune the current run");
  assert.ok(runDirs.length <= 2, "retention should cap run directories");

  console.log("logging smoke: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
