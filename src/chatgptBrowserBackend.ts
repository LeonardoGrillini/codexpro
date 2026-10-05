import type { AgentBackend, AgentMessage, AgentOptions, AgentSession } from "./agentBackend.js";
import { ChatGPTBrowserManager } from "./chatgptBrowserManager.js";
import { CodexProError } from "./guard.js";

export interface ChatGPTAgentSession extends AgentSession {
  pageId: string;
}

export class ChatGPTBrowserBackend implements AgentBackend {
  readonly name = "chatgpt-browser";
  readonly model = "chatgpt-web";

  constructor(readonly browser: ChatGPTBrowserManager) {}

  async create(options: AgentOptions): Promise<ChatGPTAgentSession> {
    const created = await this.browser.createAgentPage(options.id);
    const session: ChatGPTAgentSession = {
      id: options.id,
      pageId: created.pageId,
      backend: this.name,
      model: this.model,
      messages: [{ role: "system", content: options.systemPrompt }]
    };
    if (created.conversationUrl) {
      session.externalConversation = { provider: "chatgpt", url: created.conversationUrl };
    }
    return session;
  }

  async send(session: AgentSession, message: string, signal?: AbortSignal): Promise<AgentMessage> {
    const typed = session as ChatGPTAgentSession;
    if (!typed.pageId) throw new CodexProError("ChatGPT browser session is missing its page mapping.");
    const firstTurn = !session.messages.some((entry) => entry.role === "assistant");
    const systemPrompt = session.messages.find((entry) => entry.role === "system")?.content ?? "";
    const prompt = firstTurn && systemPrompt
      ? `CODEXPRO DELEGATED SUBAGENT INSTRUCTIONS\n\n${systemPrompt}\n\nDELEGATED TASK\n\n${message}`
      : message;
    const result = await this.browser.send(typed.pageId, prompt, signal, (url) => {
      session.externalConversation = { provider: "chatgpt", url };
    });
    const assistant: AgentMessage = { role: "assistant", content: result.content };
    session.messages.push({ role: "user", content: message }, assistant);
    if (result.conversationUrl) {
      session.externalConversation = { provider: "chatgpt", url: result.conversationUrl };
    }
    return assistant;
  }

  async cancel(sessionId: string): Promise<void> {
    await this.browser.cancel(sessionId);
  }
}
