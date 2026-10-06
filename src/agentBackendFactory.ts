import type { AgentBackend } from "./agentBackend.js";
import type { CodexProConfig } from "./config.js";
import { ChatGPTBrowserBackend } from "./chatgptBrowserBackend.js";
import { ChatGPTBrowserManager } from "./chatgptBrowserManager.js";
import { DeepSeekBackend } from "./deepseekBackend.js";
import type { CodexProLogger } from "./logging.js";

export interface AgentBackendFactoryDependencies {
  chatgptBrowserManager?: ChatGPTBrowserManager;
  logger?: CodexProLogger;
}

export interface AgentBackendSelection {
  backend: AgentBackend;
  chatgptBrowserManager?: ChatGPTBrowserManager;
}

export function subagentBackendAvailable(config: CodexProConfig): boolean {
  if (!config.subagentsEnabled || config.subagentProvider === "off") return false;
  if (config.subagentProvider === "chatgpt-browser") return true;
  return config.subagentProvider === "deepseek" && Boolean(config.deepseekApiKey);
}

export function createAgentBackend(
  config: CodexProConfig,
  dependencies: AgentBackendFactoryDependencies = {}
): AgentBackendSelection | undefined {
  if (!subagentBackendAvailable(config)) return undefined;
  if (config.subagentProvider === "chatgpt-browser") {
    const chatgptBrowserManager = dependencies.chatgptBrowserManager ?? new ChatGPTBrowserManager(config, undefined, undefined, { logger: dependencies.logger });
    return { backend: new ChatGPTBrowserBackend(chatgptBrowserManager), chatgptBrowserManager };
  }
  if (config.subagentProvider === "deepseek" && config.deepseekApiKey) {
    return { backend: new DeepSeekBackend(config.deepseekApiKey, config.deepseekModel) };
  }
  return undefined;
}
