export type AgentRole = "explorer" | "reviewer" | "tester" | "implementer";

export interface AgentOptions {
  id: string;
  role: AgentRole;
  task: string;
  systemPrompt: string;
  model: string;
}

export interface AgentMessage { role: "system" | "user" | "assistant"; content: string; }

export interface ExternalConversation {
  provider: string;
  url: string;
}

export interface AgentSession {
  id: string;
  backend: string;
  model: string;
  messages: AgentMessage[];
  externalConversation?: ExternalConversation;
}

export interface AgentBackend {
  readonly name: string;
  readonly model: string;
  create(options: AgentOptions): Promise<AgentSession>;
  send(session: AgentSession, message: string, signal?: AbortSignal): Promise<AgentMessage>;
  cancel(sessionId: string): Promise<void>;
}
