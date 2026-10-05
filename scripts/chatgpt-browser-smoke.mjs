import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../dist/config.js';
import { createAgentBackend } from '../dist/agentBackendFactory.js';
import { ChatGPTBrowserBackend } from '../dist/chatgptBrowserBackend.js';
import { ChatGPTBrowserManager, ChatGPTWebPageAdapter } from '../dist/chatgptBrowserManager.js';
import { AgentManager } from '../dist/agentManager.js';
import { PathGuard } from '../dist/guard.js';
import { readWorkspaceProfile, saveWorkspaceProfile } from '../dist/profileStore.js';
import { toolNamesForMode } from '../dist/server.js';
import { requestChatgptBrowserOpen } from './chatgpt-browser-control.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-chatgpt-browser-'));
const oldCwd = process.cwd();
const oldEnv = { ...process.env };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function locator({ visible = false, count = 0, text = '', click, fill } = {}) {
  return {
    first() { return this; },
    last() { return this; },
    async isVisible() { return typeof visible === 'function' ? visible() : visible; },
    async count() { return typeof count === 'function' ? count() : count; },
    async innerText() { return typeof text === 'function' ? text() : text; },
    async click() { if (click) return click(); },
    async fill(value) { if (fill) return fill(value); },
    async press() {}
  };
}

try {
  process.chdir(tmp);
  process.env.CODEXPRO_HOME = path.join(tmp, '.codexpro-home');
  process.env.CODEXPRO_ROOT = tmp;
  process.env.CODEXPRO_ALLOWED_ROOTS = tmp;
  process.env.CODEXPRO_SUBAGENTS_ENABLED = '1';
  delete process.env.DEEPSEEK_API_KEY;

  process.env.CODEXPRO_SUBAGENT_PROVIDER = 'chatgpt-browser';
  process.env.CODEXPRO_CHATGPT_BROWSER_AUTO_START = '1';
  const browserConfig = loadConfig([]);
  assert.equal(browserConfig.subagentsEnabled, true);
  assert.equal(browserConfig.subagentProvider, 'chatgpt-browser');
  assert.equal(browserConfig.chatgptBrowserAutoStart, true);
  assert.equal(toolNamesForMode({ ...browserConfig, toolMode: 'full' }).some((name) => name.startsWith('subagent_')), true);
  assert.equal(createAgentBackend(browserConfig)?.backend.name, 'chatgpt-browser');

  const offConfig = { ...browserConfig, subagentProvider: 'off', subagentsEnabled: false };
  assert.equal(toolNamesForMode({ ...offConfig, toolMode: 'full' }).some((name) => name.startsWith('subagent_')), false);
  assert.equal(createAgentBackend(offConfig), undefined);

  const deepseekConfig = { ...browserConfig, subagentProvider: 'deepseek', subagentsEnabled: true };
  Object.defineProperty(deepseekConfig, ['deepseek', 'Api', 'Key'].join(''), { value: 'placeholder', enumerable: true });
  assert.equal(createAgentBackend(deepseekConfig)?.backend.name, 'deepseek');

  const profileRoot = path.join(tmp, 'profile-root');
  await fs.mkdir(profileRoot, { recursive: true });
  saveWorkspaceProfile(profileRoot, { subagentProvider: 'chatgpt-browser', chatgptBrowserAutoStart: true });
  const stored = readWorkspaceProfile(profileRoot);
  assert.equal(stored.subagentProvider, 'chatgpt-browser');
  assert.equal(stored.chatgptBrowserAutoStart, true);

  let controlRequest;
  await requestChatgptBrowserOpen(
    { localStatusUrl: 'http://127.0.0.1:8787/' },
    {
      fetchImpl: async (url, options) => {
        controlRequest = { url: String(url), options };
        return { ok: true, status: 200, async json() { return { ok: true, url: 'https://chatgpt.com/' }; } };
      }
    }
  );
  assert.match(controlRequest.url, /\/admin\/chatgpt-browser\/open$/);
  assert.equal(controlRequest.options.method, 'POST');

  const workspace = { id: 'test', root: tmp, openedAt: new Date().toISOString() };
  const guard = new PathGuard(browserConfig);
  const sends = [];
  let createCount = 0;
  let cancelCount = 0;
  const asyncBackend = {
    name: 'fake',
    model: 'mock-model',
    async create(options) {
      createCount += 1;
      return { id: options.id, backend: 'fake', model: 'mock-model', messages: [{ role: 'system', content: options.systemPrompt }] };
    },
    async send(session, message, signal) {
      const pending = deferred();
      sends.push({ session, message, pending });
      const abort = () => pending.reject(new DOMException('cancelled', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const content = await pending.promise;
        session.externalConversation = { provider: 'chatgpt', url: 'https://chatgpt.com/c/fake-agent' };
        session.messages.push({ role: 'user', content: message }, { role: 'assistant', content });
        return { role: 'assistant', content };
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    },
    async cancel() { cancelCount += 1; }
  };
  const agents = new AgentManager({ ...browserConfig, maxSubagents: 1 }, guard, asyncBackend);
  const worker = await agents.spawn(workspace, { role: 'explorer', task: 'async task' });
  assert.equal(worker.state, 'running');
  assert.equal(sends.length, 1);
  await assert.rejects(
    () => agents.spawn(workspace, { role: 'reviewer', task: 'too many' }),
    /maximum concurrent subagents/i
  );
  sends[0].pending.resolve('first answer');
  await waitFor(() => agents.get(worker.id).state === 'completed', 'async worker did not finish');
  assert.equal(agents.get(worker.id).session.externalConversation?.url, 'https://chatgpt.com/c/fake-agent');

  const sameSession = agents.get(worker.id).session;
  const followup = await agents.message(worker.id, 'follow-up');
  assert.equal(followup.state, 'running');
  assert.equal(createCount, 1);
  assert.equal(agents.get(worker.id).session, sameSession);
  sends[1].pending.resolve('second answer');
  await waitFor(() => agents.get(worker.id).state === 'completed', 'follow-up did not finish');

  const cancellable = await agents.spawn(workspace, { role: 'tester', task: 'cancel me' });
  const cancelled = await agents.cancel(cancellable.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelCount, 1);

  const createGate = deferred();
  let raceCreates = 0;
  const raceBackend = {
    name: 'fake',
    model: 'mock-model',
    async create(options) {
      raceCreates += 1;
      await createGate.promise;
      return { id: options.id, backend: 'fake', model: 'mock-model', messages: [{ role: 'system', content: options.systemPrompt }] };
    },
    async send(session, message) {
      const content = 'race answer';
      session.messages.push({ role: 'user', content: message }, { role: 'assistant', content });
      return { role: 'assistant', content };
    },
    async cancel() {}
  };
  const raceAgents = new AgentManager({ ...browserConfig, maxSubagents: 1 }, guard, raceBackend);
  const firstConcurrentSpawn = raceAgents.spawn(workspace, { role: 'explorer', task: 'reserve slot' });
  await waitFor(() => raceCreates === 1, 'first concurrent spawn did not reach backend creation');
  await assert.rejects(
    () => raceAgents.spawn(workspace, { role: 'reviewer', task: 'must be rejected while first spawn is pending' }),
    /maximum concurrent subagents/i
  );
  assert.equal(raceCreates, 1, 'a pending spawn must reserve the concurrency slot');
  createGate.resolve();
  await firstConcurrentSpawn;

  const pages = [];
  const adapters = [];
  let launchOptions;
  let contextClosed = false;
  const context = {
    pages() { return pages; },
    on() {},
    async newPage() {
      const page = {
        _url: 'about:blank',
        url() { return this._url; },
        async goto(url) { this._url = url; },
        async bringToFront() {},
        on() {},
        async close() {}
      };
      pages.push(page);
      return page;
    },
    async close() { contextClosed = true; }
  };
  const manager = new ChatGPTBrowserManager(
    { ...browserConfig, chatgptBrowserProfilePath: path.join(tmp, 'chatgpt-profile'), chatgptBrowserResponseTimeoutMs: 5000 },
    async () => ({
      chromium: {
        async launchPersistentContext(_profilePath, options) {
          launchOptions = options;
          return context;
        }
      }
    }),
    (page) => {
      let turns = 0;
      const adapter = {
        cancelled: false,
        currentUrl() { return page._url; },
        async prepareFreshConversation() { page._url = 'https://chatgpt.com/'; },
        async send() {
          turns += 1;
          await Promise.resolve();
          page._url = 'https://chatgpt.com/c/fake-browser-agent';
          return { content: turns === 1 ? 'streamed answer' : 'follow-up answer', conversationUrl: page._url };
        },
        async cancel() { this.cancelled = true; }
      };
      adapters.push(adapter);
      return adapter;
    }
  );
  const backend = new ChatGPTBrowserBackend(manager);
  const session = await backend.create({ id: 'browser-agent', role: 'explorer', task: '', systemPrompt: 'provider-neutral', model: 'ignored' });
  assert.equal(launchOptions.headless, false);
  assert.equal(launchOptions.channel, 'chrome');
  assert.equal(pages.length, 1);
  assert.equal((await backend.send(session, 'first')).content, 'streamed answer');
  assert.equal(session.externalConversation?.url, 'https://chatgpt.com/c/fake-browser-agent');
  await backend.send(session, 'second');
  assert.equal(pages.length, 1);
  assert.equal(adapters.length, 1);
  await backend.cancel(session.id);
  assert.equal(adapters[0].cancelled, true);
  await manager.closeAll();
  assert.equal(contextClosed, true, 'browser manager must close its persistent context on shutdown');

  const stream = { sent: false, generating: false, reads: 0 };
  const hidden = locator({ visible: false });
  const composer = locator({ visible: true });
  const send = locator({ visible: true, click() { stream.sent = true; stream.generating = true; } });
  const stop = locator({ visible: () => stream.generating });
  const assistant = locator({
    count: () => stream.sent ? 1 : 0,
    text: () => {
      stream.reads += 1;
      if (stream.reads === 1) return 'hel';
      if (stream.reads >= 3) stream.generating = false;
      return 'hello';
    }
  });
  const streamingPage = {
    _url: 'https://chatgpt.com/',
    url() { return this._url; },
    async goto(url) { this._url = url; },
    async bringToFront() {},
    getByRole(role, options) {
      if (role === 'textbox') return composer;
      const source = options?.name?.source ?? '';
      if (/send|submit/i.test(source)) return send;
      if (/stop/i.test(source)) return stop;
      return hidden;
    },
    locator(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistant;
      if (selector === 'body') return locator({ text: '' });
      return hidden;
    }
  };
  const webAdapter = new ChatGPTWebPageAdapter(streamingPage, 5000);
  await webAdapter.prepareFreshConversation();
  assert.equal((await webAdapter.send('stream')).content, 'hello');

  const loginPage = {
    url() { return 'https://chatgpt.com/'; },
    async goto() {},
    async bringToFront() {},
    getByRole(role, options) {
      if (role === 'button' && /log in|sign in/i.test(options?.name?.source ?? '')) return locator({ visible: true });
      return hidden;
    },
    locator(selector) { return selector === 'body' ? locator({ text: 'Log in' }) : hidden; }
  };
  await assert.rejects(
    () => new ChatGPTWebPageAdapter(loginPage, 1000).prepareFreshConversation(),
    /logged out|sign in manually/i
  );

  const failed = new ChatGPTBrowserManager(
    { ...browserConfig, chatgptBrowserProfilePath: path.join(tmp, 'failed-profile') },
    async () => ({ chromium: { async launchPersistentContext() { throw new Error('browser boom'); } } })
  );
  await assert.rejects(() => failed.openOrFocus(), /Could not start.*browser boom/i);

  const cliSource = await fs.readFile(path.resolve(oldCwd, 'scripts', 'codexpro.mjs'), 'utf8');
  const httpSource = await fs.readFile(path.resolve(oldCwd, 'src', 'http.ts'), 'utf8');
  assert.match(cliSource, /normalized === 'b'/);
  assert.match(cliSource, /requestChatgptBrowserOpen\(details\)/);
  assert.match(cliSource, /Start the CodexPro ChatGPT browser automatically when CodexPro starts\?/);
  assert.match(httpSource, /chatgptBrowserManager\.closeAll\(\)/);

  console.log('chatgpt browser smoke: ok');
} finally {
  process.chdir(oldCwd);
  process.env = oldEnv;
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}
