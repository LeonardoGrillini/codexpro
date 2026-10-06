import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  GuestAgentClient,
  VM_GUEST_FILE_CHUNK_BYTES,
  VM_GUEST_FILE_MAX_BYTES,
  VM_GUEST_OUTPUT_MAX_BYTES,
  VmManager,
  normalizeVmExec,
  runVmDownloadTool,
  runVmUploadTool
} from '../dist/vm/index.js';
import { OutputStore } from '../dist/outputStore.js';
import { redactStructured } from '../dist/redact.js';

assert.throws(() => normalizeVmExec({}), /Exactly one/);
assert.throws(() => normalizeVmExec({ argv: ['echo'], command: 'echo' }), /Exactly one/);
assert.throws(() => normalizeVmExec({ argv: ['echo'], shell: 'sh' }), /shell cannot be used with argv/);
assert.throws(() => normalizeVmExec({ argv: ['echo'], cwd: '/tmp' }), /cwd requires command/);
assert.throws(() => normalizeVmExec({ command: 'echo ok' }), /explicit shell/);
assert.throws(() => normalizeVmExec({ command: 'echo ok', shell: 'cmd', cwd: 'C:\\tmp' }), /not supported/);
assert.throws(() => normalizeVmExec({ argv: ['echo'], timeoutMs: 99 }), /timeout/);
assert.throws(() => normalizeVmExec({ argv: ['echo'], env: { 'BAD-NAME': 'x' } }), /environment variable name/);
assert.throws(() => normalizeVmExec({ command: 'x'.repeat(60_000), shell: 'sh', cwd: '/tmp', env: { PAD: 'y'.repeat(10_000) } }), /64 KiB/);
const direct = normalizeVmExec({ argv: ['/bin/echo', 'hello world'], env: { OK: '1', EMPTY: '' }, timeoutMs: 1000 });
assert.deepEqual(direct.args, ['hello world']);
assert.equal(direct.executable, '/bin/echo');
assert.equal(direct.env.EMPTY, '');
const shell = normalizeVmExec({ command: 'pwd', shell: 'sh', cwd: '/tmp' });
assert.equal(shell.env.CODEXPRO_GUEST_CWD, '/tmp');
assert.match(shell.args.join(' '), /CODEXPRO_GUEST_COMMAND/);
assert.equal(redactStructured({ credential: { username: 'dev', password: 'short-value' } }).credential.password, '[REDACTED_SECRET]');
assert.equal(redactStructured({ tokenCount: 42 }).tokenCount, 42);

const retainedOutput = new OutputStore();
const retainedBase64 = Buffer.alloc(VM_GUEST_FILE_MAX_BYTES, 0x5c).toString('base64');
assert.ok(Buffer.byteLength(retainedBase64) < retainedOutput.captureBytes);
const retainedId = retainedOutput.save('vm-workspace', retainedBase64, '', false);
let retainedOffset = 0;
let reconstructed = '';
for (;;) {
  const page = retainedOutput.read('vm-workspace', retainedId, 'stdout', retainedOffset, 8000);
  reconstructed += page.text;
  if (page.next_offset === null) break;
  retainedOffset = page.next_offset;
}
assert.equal(reconstructed, retainedBase64, 'paged output retention must preserve a maximum-size VM download payload');

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-vm-guest-smoke-'));
const files = new Map();
const handles = new Map();
const requestLog = [];
const writeSizes = [];
let nextHandle = 1;
let nextPid = 100;
const statusPolls = new Map();
const delayedPid = 900;
let dirtyNextSync = false;

function reply(socket, message, value, prefix = false) {
  const line = Buffer.from(JSON.stringify({ id: message.id, return: value }) + '\n', 'utf8');
  socket.write(prefix ? Buffer.concat([Buffer.from([0xff]), line]) : line);
}

const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    const sentinel = buffer.lastIndexOf(0xff);
    if (sentinel >= 0) buffer = buffer.subarray(sentinel + 1);
    for (;;) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = buffer.subarray(0, newline).toString('utf8').trim();
      buffer = buffer.subarray(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      requestLog.push(message.execute);
      const args = message.arguments ?? {};
      if (message.execute === 'guest-sync-delimited') {
        if (dirtyNextSync) {
          socket.write(Buffer.from('{"stale":', 'utf8'));
          dirtyNextSync = false;
        }
        reply(socket, message, args.id, true);
      } else if (message.execute === 'guest-ping') {
        reply(socket, message, {});
      } else if (message.execute === 'guest-info') {
        reply(socket, message, {
          version: 'test',
          supported_commands: [
            { name: 'guest-exec', enabled: true },
            { name: 'guest-file-open', enabled: true },
            { name: 'guest-file-read', enabled: true },
            { name: 'guest-file-write', enabled: true },
            { name: 'guest-file-close', enabled: true }
          ]
        });
      } else if (message.execute === 'guest-exec') {
        assert.equal(args['capture-output'], true);
        assert.ok(Array.isArray(args.arg));
        assert.ok(Array.isArray(args.env));
        if (args.path === '/transport-error') {
          socket.write(JSON.stringify({ id: message.id, error: { class: 'GenericError', desc: 'simulated exec transport error' } }) + '\n');
          continue;
        }
        const pid = args.path === '/delayed-status' ? delayedPid : nextPid++;
        statusPolls.set(pid, { polls: 0, path: args.path });
        reply(socket, message, { pid });
      } else if (message.execute === 'guest-exec-status') {
        const state = statusPolls.get(args.pid) ?? { polls: 0, path: '/bin/unknown' };
        state.polls++;
        statusPolls.set(args.pid, state);
        if (args.pid === delayedPid) {
          dirtyNextSync = true;
          setTimeout(() => reply(socket, message, { exited: false }), 100);
        } else if (state.path === '/status-timeout') {
          setTimeout(() => reply(socket, message, { exited: false }), 250);
        } else if (state.path === '/timeout') {
          reply(socket, message, { exited: false });
        } else if (state.polls === 1) {
          reply(socket, message, { exited: false });
        } else {
          const out = state.path === '/large' ? Buffer.alloc(1024 * 1024, 0x61) : Buffer.from('hello\n');
          reply(socket, message, {
            exited: true,
            exitcode: 7,
            'out-data': out.toString('base64'),
            'err-data': Buffer.from('warning\n').toString('base64'),
            'out-truncated': state.path === '/native-truncated',
            'err-truncated': false
          });
        }
      } else if (message.execute === 'guest-file-open') {
        const handle = nextHandle++;
        if (args.mode === 'wb') files.set(args.path, Buffer.alloc(0));
        if (args.mode === 'rb' && !files.has(args.path)) {
          socket.write(JSON.stringify({ id: message.id, error: { class: 'GenericError', desc: 'file not found' } }) + '\n');
          continue;
        }
        handles.set(handle, { path: args.path, mode: args.mode, position: 0 });
        reply(socket, message, handle);
      } else if (message.execute === 'guest-file-write') {
        const entry = handles.get(args.handle);
        assert.ok(entry && entry.mode === 'wb');
        const chunk = Buffer.from(args['buf-b64'], 'base64');
        assert.equal(chunk.length, args.count);
        if (entry.path === '/tmp/fail-write.bin') {
          socket.write(JSON.stringify({ id: message.id, error: { class: 'GenericError', desc: 'simulated write failure' } }) + '\n');
          continue;
        }
        writeSizes.push(chunk.length);
        files.set(entry.path, Buffer.concat([files.get(entry.path), chunk]));
        reply(socket, message, { count: chunk.length, eof: false });
      } else if (message.execute === 'guest-file-flush') {
        assert.ok(handles.has(args.handle));
        reply(socket, message, {});
      } else if (message.execute === 'guest-file-read') {
        const entry = handles.get(args.handle);
        assert.ok(entry && entry.mode === 'rb');
        const data = files.get(entry.path);
        if (entry.path === '/tmp/zero-read.bin') {
          reply(socket, message, { count: 0, 'buf-b64': '', eof: false });
          continue;
        }
        const chunk = data.subarray(entry.position, entry.position + args.count);
        entry.position += chunk.length;
        reply(socket, message, {
          count: chunk.length,
          'buf-b64': chunk.toString('base64'),
          eof: entry.position >= data.length
        });
      } else if (message.execute === 'guest-file-close') {
        assert.ok(handles.delete(args.handle));
        reply(socket, message, {});
      } else {
        socket.write(JSON.stringify({ id: message.id, error: { class: 'CommandNotFound', desc: message.execute } }) + '\n');
      }
    }
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
const endpoint = { transport: 'tcp', host: '127.0.0.1', port: address.port };

try {
  const directClient = await GuestAgentClient.connect(endpoint, 500);
  const delayed = await directClient.exec('/delayed-status', [], {}, 500);
  assert.equal(delayed, delayedPid);
  await assert.rejects(directClient.execStatus(delayedPid, 20), /timed out/);
  const beforeRecovery = requestLog.length;
  await directClient.ping(500);
  assert.deepEqual(requestLog.slice(beforeRecovery, beforeRecovery + 2), ['guest-sync-delimited', 'guest-ping']);
  directClient.close();

  const manager = new VmManager({ home: root, vmRoot: path.join(root, 'vm'), platform: 'linux' });
  const allocated = await manager.instances.allocate('guest-test', 1, 512, 'tcg', false, undefined, endpoint);
  await manager.instances.update(allocated.record.id, { state: 'running', processId: process.pid });

  const status = await manager.guestStatus(allocated.record.id);
  assert.equal(status.available, true);
  assert.equal(status.canExec, true);
  assert.equal(status.transport, 'qemu-guest-agent');

  const exec = await manager.exec(allocated.record.id, {
    argv: ['/bin/echo', 'hello'],
    env: { TEST_VALUE: 'yes' },
    timeoutMs: 1000
  });
  assert.equal(exec.exitCode, 7);
  assert.equal(exec.stdout, 'hello\n');
  assert.equal(exec.stderr, 'warning\n');
  assert.equal(exec.timedOut, false);

  const oversized = await manager.exec(allocated.record.id, { argv: ['/large'], timeoutMs: 1000 });
  assert.equal(Buffer.byteLength(oversized.stdout), VM_GUEST_OUTPUT_MAX_BYTES);
  assert.equal(oversized.stdoutTruncated, true);

  const nativeTruncated = await manager.exec(allocated.record.id, { argv: ['/native-truncated'], timeoutMs: 1000 });
  assert.equal(nativeTruncated.stdoutTruncated, true);

  const timed = await manager.exec(allocated.record.id, { argv: ['/timeout'], timeoutMs: 120 });
  assert.equal(timed.timedOut, true);
  assert.equal(timed.exitCode, null);
  const statusTimed = await manager.exec(allocated.record.id, { argv: ['/status-timeout'], timeoutMs: 120 });
  assert.equal(statusTimed.timedOut, true);
  assert.equal(statusTimed.exitCode, null);
  await assert.rejects(
    manager.exec(allocated.record.id, { argv: ['/transport-error'], timeoutMs: 1000 }),
    /simulated exec transport error/
  );

  const payload = Buffer.alloc(VM_GUEST_FILE_CHUNK_BYTES * 2 + 17, 0x5a);
  const upload = await runVmUploadTool({
    id: allocated.record.id,
    guestPath: '/tmp/blob.bin',
    dataBase64: payload.toString('base64')
  }, manager);
  assert.equal(upload.bytes, payload.length);
  assert.deepEqual(files.get('/tmp/blob.bin'), payload);
  assert.ok(writeSizes.length >= 3);
  assert.ok(writeSizes.every(size => size <= VM_GUEST_FILE_CHUNK_BYTES));

  const download = await runVmDownloadTool({ id: allocated.record.id, guestPath: '/tmp/blob.bin' }, manager);
  assert.equal(download.bytes, payload.length);
  assert.deepEqual(Buffer.from(download.dataBase64, 'base64'), payload);
  assert.equal(handles.size, 0);
  await assert.rejects(
    manager.upload(allocated.record.id, '/tmp/fail-write.bin', Buffer.from('failure cleanup')),
    /simulated write failure/
  );
  assert.equal(handles.size, 0, 'QGA file handle must close after a write failure');
  files.set('/tmp/zero-read.bin', Buffer.from('not actually returned'));
  await assert.rejects(
    manager.download(allocated.record.id, '/tmp/zero-read.bin'),
    /zero-byte file read before EOF/
  );
  assert.equal(handles.size, 0, 'QGA file handle must close after an invalid read');

  await assert.rejects(
    runVmUploadTool({ id: allocated.record.id, guestPath: '/tmp/bad', dataBase64: 'not base64' }, manager),
    /canonical standard base64/
  );
  await assert.rejects(
    manager.upload(allocated.record.id, '/tmp/too-large', Buffer.alloc(VM_GUEST_FILE_MAX_BYTES + 1)),
    /limited/
  );
  await assert.rejects(manager.exec('../escape', { argv: ['/bin/true'] }), /Invalid VM instance id/);

  const stopped = await manager.instances.allocate('stopped', 1, 512, 'tcg', false, undefined, endpoint);
  await assert.rejects(manager.exec(stopped.record.id, { argv: ['/bin/true'] }), /not running/);

  const noAgent = await manager.instances.allocate('no-agent', 1, 512, 'tcg', false);
  await manager.instances.update(noAgent.record.id, { state: 'running', processId: process.pid });
  const unavailable = await manager.guestStatus(noAgent.record.id);
  assert.equal(unavailable.available, false);
  assert.match(unavailable.reason, /guest agent channel/i);
  await assert.rejects(manager.exec(noAgent.record.id, { argv: ['/bin/true'] }), /guest agent channel/i);

  const hyperv = await manager.instances.allocate(
    'wrong-backend',
    1,
    512,
    undefined,
    false,
    undefined,
    undefined,
    { vmId: '00000000-0000-0000-0000-000000000001', ownershipId: 'a'.repeat(64) }
  );
  await manager.instances.update(hyperv.record.id, { state: 'running' });
  await assert.rejects(manager.exec(hyperv.record.id, { argv: ['/bin/true'] }), /requires the Hyper-V backend/);

  console.log('VM guest smoke passed (validation, QGA sync/recovery, exec polling, output limits, file chunking, cleanup, and backend/state guards).');
} finally {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
