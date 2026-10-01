import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => port ? resolve(port) : reject(new Error('no free port')));
    });
    server.on('error', reject);
  });
}

async function waitForHealth(url, timeoutMs = 15000) {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${url}: ${lastError}`);
}

async function waitForRuntimeRecord(home, timeoutMs = 5000) {
  const dir = path.join(home, 'runtime');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const entries = await fs.readdir(dir);
      if (entries.some((entry) => entry.endsWith('.json'))) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('runtime record was not written');
}

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for launcher exit')), timeoutMs);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-runtime-reuse-root-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-runtime-reuse-home-'));
const port = await getFreePort();
const args = [
  'scripts/codexpro.mjs',
  'start',
  '--root', root,
  '--port', String(port),
  '--tunnel', 'none',
  '--no-auth',
  '--headless',
  '--no-profile'
];
const env = { ...process.env, CODEXPRO_HOME: home };
const first = spawn(process.execPath, args, {
  cwd: path.resolve('.'),
  env,
  stdio: ['ignore', 'pipe', 'pipe']
});
let firstOutput = '';
first.stdout.on('data', (chunk) => { firstOutput += String(chunk); });
first.stderr.on('data', (chunk) => { firstOutput += String(chunk); });

try {
  const healthUrl = `http://127.0.0.1:${port}/healthz`;
  await waitForHealth(healthUrl);
  await waitForRuntimeRecord(home);

  const second = spawnSync(process.execPath, args, {
    cwd: path.resolve('.'),
    env,
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true
  });
  const secondOutput = `${second.stdout ?? ''}${second.stderr ?? ''}`;
  if (second.error) throw second.error;
  if (second.status !== 0) {
    throw new Error(`second launcher failed instead of reusing the runtime (exit ${second.status}):\n${secondOutput}`);
  }
  if (!secondOutput.includes('Reusing existing CodexPro runtime')) {
    throw new Error(`second launcher did not report runtime reuse:\n${secondOutput}`);
  }

  await waitForHealth(healthUrl);
  if (first.exitCode !== null || first.signalCode !== null) {
    throw new Error(`original launcher exited after reuse attempt:\n${firstOutput}`);
  }

  console.log('runtime reuse smoke passed');
} finally {
  if (first.exitCode === null && first.signalCode === null) first.kill('SIGTERM');
  await waitForExit(first).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
}
