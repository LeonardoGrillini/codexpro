import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { CodexProConfig } from "./config.js";
import { CodexProError } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

const CHATGPT_HOME = "https://chatgpt.com/";

const CDP_HOST = "127.0.0.1";
const DEVTOOLS_ACTIVE_PORT = "DevToolsActivePort";
const DEFAULT_CDP_READY_TIMEOUT_MS = 15_000;

type PlaywrightLoader = () => Promise<any>;
type ProcessSpawner = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
type DebuggingPortReader = (profilePath: string) => Promise<number | undefined>;
type DebuggingPortProbe = (port: number) => Promise<boolean>;

export type ChatGPTBrowserState = "stopped" | "starting" | "running-unattached" | "attached" | "failed";

export interface ChromeDiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isExecutable?: (candidate: string) => boolean;
}

export interface ChatGPTBrowserManagerDependencies {
  discoverChrome?: (override?: string) => string;
  spawnProcess?: ProcessSpawner;
  readDebuggingPort?: DebuggingPortReader;
  probeDebuggingPort?: DebuggingPortProbe;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  cdpReadyTimeoutMs?: number;
}

function envValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[key];
  const match = Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return match ? env[match] : undefined;
}

function defaultExecutableCheck(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isExecutable: (candidate: string) => boolean
): string | undefined {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const rawPath = envValue(env, "PATH", platform) ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  const extensions = platform === "win32"
    ? (envValue(env, "PATHEXT", platform) ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
    : [""];
  const commandHasExtension = platform === "win32" && Boolean(pathApi.extname(command));
  for (const directory of rawPath.split(delimiter).filter(Boolean)) {
    const suffixes = commandHasExtension ? [""] : extensions;
    for (const suffix of suffixes) {
      const candidate = pathApi.join(directory, `${command}${suffix}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function resolveChromeCandidate(
  candidate: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isExecutable: (candidate: string) => boolean
): string | undefined {
  if (isExecutable(candidate)) return candidate;
  if (!candidate.includes("/") && !candidate.includes("\\")) {
    return findOnPath(candidate, platform, env, isExecutable);
  }
  return undefined;
}

export function discoverChromeExecutable(override?: string, options: ChromeDiscoveryOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const isExecutable = options.isExecutable ?? ((candidate) => defaultExecutableCheck(candidate, platform));
  const pathApi = platform === "win32" ? path.win32 : path.posix;

  if (override?.trim()) {
    const resolved = resolveChromeCandidate(override.trim(), platform, env, isExecutable);
    if (resolved) return resolved;
    throw new CodexProError(
      `Configured Chrome executable was not found: ${override.trim()}. Set CODEXPRO_CHROME_PATH to an installed Chrome executable.`
    );
  }

  const candidates: string[] = [];
  if (platform === "win32") {
    for (const base of [
      envValue(env, "ProgramFiles", platform),
      envValue(env, "ProgramFiles(x86)", platform),
      envValue(env, "LocalAppData", platform)
    ]) {
      if (base) candidates.push(pathApi.join(base, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else if (platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      pathApi.join(envValue(env, "HOME", platform) ?? "", "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else {
    candidates.push("google-chrome", "google-chrome-stable", "chromium", "chromium-browser");
  }

  for (const candidate of candidates) {
    const resolved = resolveChromeCandidate(candidate, platform, env, isExecutable);
    if (resolved) return resolved;
  }
  throw new CodexProError(
    "Could not find Google Chrome or Chromium. Install Chrome or set CODEXPRO_CHROME_PATH to the browser executable."
  );
}

async function readDevToolsActivePort(profilePath: string): Promise<number | undefined> {
  try {
    const text = await fsp.readFile(path.join(profilePath, DEVTOOLS_ACTIVE_PORT), "utf8");
    const port = Number(text.split(/\r?\n/, 1)[0]?.trim());
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
  } catch {
    return undefined;
  }
}

async function probeLocalCdpPort(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 750);
  try {
    const response = await fetch(`http://${CDP_HOST}:${port}/json/version`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function errorText(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

export interface ChatGPTPageAdapter {
  prepareFreshConversation(): Promise<void>;
  send(prompt: string, signal?: AbortSignal, onConversationUrl?: (url: string) => void): Promise<{ content: string; conversationUrl?: string }>;
  cancel(): Promise<void>;
  currentUrl(): string;
}

export type ChatGPTPageAdapterFactory = (page: any, timeoutMs: number) => ChatGPTPageAdapter;

async function visible(locator: any): Promise<boolean> {
  if (!locator) return false;
  try { return Boolean(await locator.first().isVisible()); } catch { return false; }
}

async function locatorText(locator: any): Promise<string> {
  if (!locator) return "";
  try { return String(await locator.last().innerText()); } catch { return ""; }
}

function conversationUrlFrom(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.origin !== "https://chatgpt.com") return undefined;
    const path = url.pathname.replace(/\/+$/, "");
    if (!path || path === "/" || path.startsWith("/auth") || path.startsWith("/#settings")) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export class ChatGPTWebPageAdapter implements ChatGPTPageAdapter {
  constructor(private readonly page: any, private readonly timeoutMs = 180_000) {}

  currentUrl(): string { return String(this.page.url?.() ?? ""); }

  private async composer(): Promise<any | undefined> {
    const candidates = [
      this.page.getByRole?.("textbox"),
      this.page.locator?.("#prompt-textarea"),
      this.page.locator?.('[data-testid="prompt-textarea"]'),
      this.page.locator?.('[contenteditable="true"][data-lexical-editor="true"]'),
      this.page.locator?.("textarea")
    ];
    for (const candidate of candidates) if (await visible(candidate)) return candidate.first();
    return undefined;
  }

  private async manualInteractionReason(): Promise<string | undefined> {
    const login = this.page.getByRole?.("button", { name: /log in|sign in/i });
    if (await visible(login)) return "ChatGPT authentication is required.\n\nPress b to open the CodexPro browser and sign in manually.";
    let body = "";
    try { body = String(await this.page.locator?.("body")?.innerText?.()); } catch {}
    if (/captcha|verify you are human|checking your browser|unusual activity|account restriction/i.test(body)) {
      return "ChatGPT requires manual browser interaction.\n\nPress b to open the CodexPro browser and complete the check manually.";
    }
    return undefined;
  }

  private async waitForComposer(timeoutMs = 20_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const composer = await this.composer();
      if (composer) return composer;
      const reason = await this.manualInteractionReason();
      if (reason) throw new CodexProError(reason);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new CodexProError("ChatGPT prompt box was not available. Open the visible browser and resolve any login or page issue manually.");
  }

  async prepareFreshConversation(): Promise<void> {
    try {
      await this.page.goto(CHATGPT_HOME, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await this.page.bringToFront?.();
      await this.waitForComposer();
    } catch (error) {
      if (error instanceof CodexProError) throw error;
      throw new CodexProError(`Could not open ChatGPT in the dedicated browser: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`);
    }
  }

  private assistantMessages(): any {
    return this.page.locator?.('[data-message-author-role="assistant"]');
  }

  private async stopButton(): Promise<any | undefined> {
    const candidates = [
      this.page.getByRole?.("button", { name: /stop generating|stop/i }),
      this.page.locator?.('[data-testid="stop-button"]')
    ];
    for (const candidate of candidates) if (await visible(candidate)) return candidate.first();
    return undefined;
  }

  private async submit(prompt: string): Promise<number> {
    const assistants = this.assistantMessages();
    let before = 0;
    try { before = Number(await assistants?.count?.()) || 0; } catch {}
    const composer = await this.waitForComposer();
    if (typeof composer.fill === "function") await composer.fill(prompt);
    else if (typeof composer.pressSequentially === "function") await composer.pressSequentially(prompt);
    else throw new CodexProError("ChatGPT prompt box no longer supports the expected input interaction.");

    const sendCandidates = [
      this.page.getByRole?.("button", { name: /send|submit/i }),
      this.page.locator?.('[data-testid="send-button"]')
    ];
    for (const candidate of sendCandidates) {
      if (await visible(candidate)) {
        await candidate.first().click();
        return before;
      }
    }
    await composer.press?.("Enter");
    return before;
  }

  async send(prompt: string, signal?: AbortSignal, onConversationUrl?: (url: string) => void): Promise<{ content: string; conversationUrl?: string }> {
    if (!prompt.trim()) throw new CodexProError("ChatGPT browser prompt is empty.");
    const before = await this.submit(prompt);
    const deadline = Date.now() + this.timeoutMs;
    let lastText = "";
    let stableTicks = 0;
    let sawAssistant = false;

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        await this.cancel();
        throw new DOMException("Subagent cancelled", "AbortError");
      }
      const reason = await this.manualInteractionReason();
      if (reason && !sawAssistant) throw new CodexProError(reason);
      const activeConversationUrl = conversationUrlFrom(this.currentUrl());
      if (activeConversationUrl) onConversationUrl?.(activeConversationUrl);

      const assistants = this.assistantMessages();
      let count = 0;
      try { count = Number(await assistants?.count?.()) || 0; } catch {}
      if (count > before) {
        sawAssistant = true;
        const text = (await locatorText(assistants)).trim();
        const stopVisible = Boolean(await this.stopButton());
        if (text && text === lastText && !stopVisible) stableTicks += 1;
        else stableTicks = 0;
        lastText = text;
        if (text && stableTicks >= 3) {
          return { content: redactSensitiveText(text), conversationUrl: conversationUrlFrom(this.currentUrl()) };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new CodexProError("Timed out waiting for ChatGPT to finish generating. Inspect the visible worker tab and retry or cancel the subagent.");
  }

  async cancel(): Promise<void> {
    const stop = await this.stopButton();
    if (stop) {
      try { await stop.click(); } catch {}
    }
  }
}

export class ChatGPTBrowserManager {
  private state: ChatGPTBrowserState = "stopped";
  private chromeProcess?: ChildProcess;
  private chromeProcessError?: unknown;
  private ownsChromeProcess = false;
  private browser?: any;
  private context?: any;
  private debuggingPort?: number;
  private starting?: Promise<void>;
  private attaching?: Promise<any>;
  private readonly pages = new Map<string, { page: any; adapter: ChatGPTPageAdapter }>();
  private readonly manuallyClosedPageIds = new Set<string>();
  private readonly discoverChrome: (override?: string) => string;
  private readonly spawnProcess: ProcessSpawner;
  private readonly readDebuggingPort: DebuggingPortReader;
  private readonly probeDebuggingPort: DebuggingPortProbe;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly cdpReadyTimeoutMs: number;

  constructor(
    private readonly config: CodexProConfig,
    private readonly loadPlaywright: PlaywrightLoader = () => import("playwright"),
    private readonly adapterFactory: ChatGPTPageAdapterFactory = (page, timeoutMs) => new ChatGPTWebPageAdapter(page, timeoutMs),
    dependencies: ChatGPTBrowserManagerDependencies = {}
  ) {
    this.discoverChrome = dependencies.discoverChrome ?? ((override) => discoverChromeExecutable(override));
    this.spawnProcess = dependencies.spawnProcess ?? ((command, args, options) => spawn(command, args, options));
    this.readDebuggingPort = dependencies.readDebuggingPort ?? readDevToolsActivePort;
    this.probeDebuggingPort = dependencies.probeDebuggingPort ?? probeLocalCdpPort;
    this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = dependencies.now ?? Date.now;
    this.cdpReadyTimeoutMs = dependencies.cdpReadyTimeoutMs ?? DEFAULT_CDP_READY_TIMEOUT_MS;
  }

  isRunning(): boolean { return this.state === "attached"; }
  getState(): ChatGPTBrowserState { return this.state; }

  private childIsRunning(): boolean {
    return Boolean(this.chromeProcess && this.chromeProcess.exitCode === null && !this.chromeProcess.killed);
  }

  private clearAttachment(browser?: any): void {
    if (browser && this.browser !== browser) return;
    this.browser = undefined;
    this.context = undefined;
    this.pages.clear();
    this.manuallyClosedPageIds.clear();
    if (this.state !== "stopped" && this.state !== "failed") this.state = "running-unattached";
  }

  private handleChromeExit(child: ChildProcess): void {
    if (this.chromeProcess !== child) return;
    this.chromeProcess = undefined;
    this.chromeProcessError = undefined;
    this.ownsChromeProcess = false;
    this.debuggingPort = undefined;
    this.browser = undefined;
    this.context = undefined;
    this.pages.clear();
    this.manuallyClosedPageIds.clear();
    this.state = "stopped";
  }

  private async waitForCdp(child?: ChildProcess): Promise<number> {
    const deadline = this.now() + this.cdpReadyTimeoutMs;
    while (this.now() < deadline) {
      if (child && this.chromeProcessError) {
        throw new CodexProError(`Chrome failed before its local debugging endpoint became ready: ${errorText(this.chromeProcessError)}`);
      }
      if (child && child.exitCode !== null) {
        throw new CodexProError(`Chrome exited before its local debugging endpoint became ready (exit code ${child.exitCode}).`);
      }
      const port = await this.readDebuggingPort(this.config.chatgptBrowserProfilePath);
      if (port && await this.probeDebuggingPort(port)) return port;
      await this.sleep(100);
    }
    throw new CodexProError(
      "Timed out waiting for Chrome to expose its local debugging endpoint. Close any other Chrome using the CodexPro profile and retry."
    );
  }

  private async startInternal(): Promise<void> {
    await fsp.mkdir(this.config.chatgptBrowserProfilePath, { recursive: true, mode: 0o700 });

    if (this.debuggingPort && await this.probeDebuggingPort(this.debuggingPort)) {
      this.state = this.context ? "attached" : "running-unattached";
      return;
    }

    if (this.childIsRunning()) {
      this.debuggingPort = await this.waitForCdp(this.chromeProcess);
      this.state = "running-unattached";
      return;
    }

    const existingPort = await this.readDebuggingPort(this.config.chatgptBrowserProfilePath);
    if (existingPort && await this.probeDebuggingPort(existingPort)) {
      this.debuggingPort = existingPort;
      this.ownsChromeProcess = false;
      this.state = "running-unattached";
      return;
    }

    await fsp.rm(path.join(this.config.chatgptBrowserProfilePath, DEVTOOLS_ACTIVE_PORT), { force: true }).catch(() => undefined);
    const executable = this.discoverChrome(this.config.chatgptBrowserExecutable);
    const args = [
      `--user-data-dir=${this.config.chatgptBrowserProfilePath}`,
      "--remote-debugging-port=0",
      `--remote-debugging-address=${CDP_HOST}`,
      CHATGPT_HOME
    ];

    let child: ChildProcess;
    try {
      child = this.spawnProcess(executable, args, { detached: false, stdio: "ignore", windowsHide: false });
    } catch (error) {
      throw new CodexProError(`Could not launch the installed Chrome browser: ${errorText(error)}`);
    }
    this.chromeProcess = child;
    this.chromeProcessError = undefined;
    this.ownsChromeProcess = true;
    child.once?.("error", (error) => {
      if (this.chromeProcess === child) this.chromeProcessError = error;
    });
    child.once?.("exit", () => this.handleChromeExit(child));

    try {
      this.debuggingPort = await this.waitForCdp(child);
      this.state = "running-unattached";
    } catch (error) {
      if (this.chromeProcess === child && child.exitCode === null && !child.killed) {
        try { child.kill(); } catch {}
      }
      this.chromeProcess = undefined;
      this.chromeProcessError = undefined;
      this.ownsChromeProcess = false;
      this.debuggingPort = undefined;
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.context && this.browser) {
      this.state = "attached";
      return;
    }
    if (this.starting) return this.starting;
    this.state = "starting";
    this.starting = this.startInternal()
      .catch((error) => {
        this.state = "failed";
        if (error instanceof CodexProError) throw error;
        throw new CodexProError(`Could not start the dedicated ChatGPT Chrome profile: ${errorText(error)}`);
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }

  async attach(): Promise<any> {
    if (this.context && this.browser) return this.context;
    if (this.attaching) return this.attaching;
    this.attaching = (async () => {
      await this.start();
      const port = this.debuggingPort;
      if (!port) throw new CodexProError("Chrome is running but its local debugging port is unavailable.");

      let playwright: any;
      try {
        playwright = await this.loadPlaywright();
      } catch {
        throw new CodexProError("ChatGPT browser subagents require the packaged Playwright dependency and an installed Chrome browser.");
      }

      let browser: any;
      try {
        browser = await playwright.chromium.connectOverCDP(`http://${CDP_HOST}:${port}`);
      } catch (error) {
        this.state = "running-unattached";
        throw new CodexProError(`Could not attach Playwright to the installed Chrome browser over local CDP: ${errorText(error)}`);
      }

      const contexts = browser.contexts?.() ?? [];
      const context = contexts[0];
      if (!context) {
        this.state = "running-unattached";
        throw new CodexProError("Playwright attached to Chrome, but Chrome did not expose a usable browser context.");
      }

      this.browser = browser;
      this.context = context;
      this.state = "attached";
      browser.on?.("disconnected", () => this.clearAttachment(browser));
      return context;
    })().finally(() => {
      this.attaching = undefined;
    });
    return this.attaching;
  }

  async ensureReady(): Promise<any> {
    await this.start();
    return this.attach();
  }

  async openOrFocus(): Promise<{ running: true; url: string }> {
    const context = await this.ensureReady();
    let page = context.pages?.().find((candidate: any) => String(candidate.url?.() ?? "").startsWith("https://chatgpt.com/"));
    if (!page) page = await context.newPage();
    const current = String(page.url?.() ?? "");
    if (!current.startsWith("https://chatgpt.com/")) {
      await page.goto(CHATGPT_HOME, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    await page.bringToFront?.();
    return { running: true, url: String(page.url?.() ?? CHATGPT_HOME) };
  }

  async createAgentPage(id: string): Promise<{ pageId: string; conversationUrl?: string }> {
    const existing = this.pages.get(id);
    if (existing && !existing.page.isClosed?.()) throw new CodexProError(`ChatGPT browser page already exists for subagent ${id}`);
    if (existing) this.pages.delete(id);
    this.manuallyClosedPageIds.delete(id);

    const context = await this.ensureReady();
    const page = await context.newPage();
    const adapter = this.adapterFactory(page, this.config.chatgptBrowserResponseTimeoutMs);
    try {
      await adapter.prepareFreshConversation();
      this.pages.set(id, { page, adapter });
      page.on?.("close", () => {
        if (this.pages.get(id)?.page === page) {
          this.pages.delete(id);
          this.manuallyClosedPageIds.add(id);
        }
      });
      return { pageId: id, conversationUrl: conversationUrlFrom(adapter.currentUrl()) };
    } catch (error) {
      try { await page.close?.(); } catch {}
      throw error;
    }
  }

  async send(id: string, prompt: string, signal?: AbortSignal, onConversationUrl?: (url: string) => void): Promise<{ content: string; conversationUrl?: string }> {
    const entry = this.pages.get(id);
    if (!entry) {
      if (this.manuallyClosedPageIds.has(id)) {
        throw new CodexProError(`The ChatGPT browser tab for subagent ${id} was closed manually.`);
      }
      throw new CodexProError(`No ChatGPT browser tab exists for subagent ${id}`);
    }
    if (entry.page.isClosed?.()) {
      this.pages.delete(id);
      this.manuallyClosedPageIds.add(id);
      throw new CodexProError(`The ChatGPT browser tab for subagent ${id} was closed manually.`);
    }
    return entry.adapter.send(prompt, signal, onConversationUrl);
  }

  async cancel(id: string): Promise<void> {
    const entry = this.pages.get(id);
    if (!entry || entry.page.isClosed?.()) return;
    await entry.adapter.cancel();
  }

  async closeAgentPage(id: string): Promise<void> {
    const entry = this.pages.get(id);
    if (!entry) return;
    this.pages.delete(id);
    this.manuallyClosedPageIds.delete(id);
    try { await entry.page.close?.(); } catch {}
  }

  async shutdown(): Promise<void> {
    const browser = this.browser;
    const child = this.chromeProcess;
    const owned = this.ownsChromeProcess;
    const entries = [...this.pages.values()];

    this.state = "stopped";
    this.browser = undefined;
    this.context = undefined;
    this.debuggingPort = undefined;
    this.chromeProcess = undefined;
    this.chromeProcessError = undefined;
    this.ownsChromeProcess = false;
    this.pages.clear();
    this.manuallyClosedPageIds.clear();

    for (const entry of entries) {
      if (!entry.page.isClosed?.()) {
        try { await entry.page.close?.(); } catch {}
      }
    }

    if (owned && browser) {
      try { await browser.close?.(); } catch {}
    }
    if (owned && child && child.exitCode === null && !child.killed) {
      try { child.kill(); } catch {}
    }
  }

  async closeAll(): Promise<void> {
    await this.shutdown();
  }
}
