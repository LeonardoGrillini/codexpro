import fs from "node:fs/promises";
import type { CodexProConfig } from "./config.js";
import { CodexProError } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

const CHATGPT_HOME = "https://chatgpt.com/";

type PlaywrightLoader = () => Promise<any>;

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
    if (await visible(login)) return "ChatGPT is logged out. Sign in manually in the visible CodexPro Chrome profile.";
    let body = "";
    try { body = String(await this.page.locator?.("body")?.innerText?.()); } catch {}
    if (/captcha|verify you are human|checking your browser|unusual activity|account restriction/i.test(body)) {
      return "ChatGPT requires manual browser interaction before CodexPro can continue.";
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
  private context?: any;
  private starting?: Promise<any>;
  private readonly pages = new Map<string, { page: any; adapter: ChatGPTPageAdapter }>();

  constructor(
    private readonly config: CodexProConfig,
    private readonly loadPlaywright: PlaywrightLoader = () => import("playwright"),
    private readonly adapterFactory: ChatGPTPageAdapterFactory = (page, timeoutMs) => new ChatGPTWebPageAdapter(page, timeoutMs)
  ) {}

  isRunning(): boolean { return Boolean(this.context); }

  private async ensureContext(): Promise<any> {
    if (this.context) return this.context;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await fs.mkdir(this.config.chatgptBrowserProfilePath, { recursive: true, mode: 0o700 });
      let playwright: any;
      try { playwright = await this.loadPlaywright(); }
      catch { throw new CodexProError("ChatGPT browser subagents require Playwright. Install the packaged Playwright dependency and a Chrome browser."); }
      const launchOptions: Record<string, unknown> = { headless: false };
      if (this.config.chatgptBrowserExecutable) launchOptions.executablePath = this.config.chatgptBrowserExecutable;
      else launchOptions.channel = "chrome";
      try {
        const context = await playwright.chromium.launchPersistentContext(this.config.chatgptBrowserProfilePath, launchOptions);
        context.on?.("close", () => {
          this.context = undefined;
          this.pages.clear();
        });
        this.context = context;
        return context;
      } catch (error) {
        throw new CodexProError(`Could not start the dedicated ChatGPT Chrome profile: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`);
      } finally {
        this.starting = undefined;
      }
    })();
    return this.starting;
  }

  async openOrFocus(): Promise<{ running: true; url: string }> {
    const context = await this.ensureContext();
    let page = context.pages?.().find((candidate: any) => String(candidate.url?.() ?? "").startsWith("https://chatgpt.com/"));
    if (!page) page = context.pages?.()[0] ?? await context.newPage();
    const current = String(page.url?.() ?? "");
    if (!current.startsWith("https://chatgpt.com/")) await page.goto(CHATGPT_HOME, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.bringToFront?.();
    return { running: true, url: String(page.url?.() ?? CHATGPT_HOME) };
  }

  async createAgentPage(id: string): Promise<{ pageId: string; conversationUrl?: string }> {
    if (this.pages.has(id)) throw new CodexProError(`ChatGPT browser page already exists for subagent ${id}`);
    const context = await this.ensureContext();
    const page = await context.newPage();
    const adapter = this.adapterFactory(page, this.config.chatgptBrowserResponseTimeoutMs);
    try {
      await adapter.prepareFreshConversation();
      this.pages.set(id, { page, adapter });
      page.on?.("close", () => this.pages.delete(id));
      return { pageId: id, conversationUrl: conversationUrlFrom(adapter.currentUrl()) };
    } catch (error) {
      try { await page.close?.(); } catch {}
      throw error;
    }
  }

  async send(id: string, prompt: string, signal?: AbortSignal, onConversationUrl?: (url: string) => void): Promise<{ content: string; conversationUrl?: string }> {
    const entry = this.pages.get(id);
    if (!entry) throw new CodexProError(`No ChatGPT browser tab exists for subagent ${id}`);
    return entry.adapter.send(prompt, signal, onConversationUrl);
  }

  async cancel(id: string): Promise<void> {
    await this.pages.get(id)?.adapter.cancel();
  }

  async closeAgentPage(id: string): Promise<void> {
    const entry = this.pages.get(id);
    if (!entry) return;
    this.pages.delete(id);
    try { await entry.page.close?.(); } catch {}
  }

  async closeAll(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.pages.clear();
    if (context) {
      try { await context.close(); } catch {}
    }
  }
}
