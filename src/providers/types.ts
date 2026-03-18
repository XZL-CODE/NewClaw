/**
 * Provider abstraction types — unified interface for all LLM providers.
 *
 * Design: one interface to rule them all.
 * Anthropic gets a native provider, everything else goes through OpenAI-compatible.
 */

// ============================================================
// Provider Interface
// ============================================================

export interface LLMProvider {
  readonly name: string;

  /** Non-streaming chat completion. */
  chat(messages: ProviderMessage[], options: ChatOptions): Promise<ChatResponse>;

  /** Streaming chat completion. Yields text deltas and tool calls. */
  chatStream(messages: ProviderMessage[], options: ChatOptions): AsyncGenerator<StreamChunk>;
}

// ============================================================
// Messages
// ============================================================

export interface ProviderMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// ============================================================
// Chat Options & Response
// ============================================================

export interface ChatOptions {
  model: string;
  maxTokens: number;
  tools?: ToolDef[];
  temperature?: number;
  systemPrompt?: string;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
}

// ============================================================
// Tools (OpenAI function calling format as canonical)
// ============================================================

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// ============================================================
// Streaming
// ============================================================

export type StreamChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'done'; response: ChatResponse };

// ============================================================
// Provider Configuration
// ============================================================

export type ProviderType = 'anthropic' | 'openai-compatible';

export interface ProviderConfig {
  /** Provider name key (e.g. 'anthropic', 'deepseek', 'ollama', 'custom') */
  provider: string;
  /** API key */
  apiKey: string;
  /** Model identifier */
  model: string;
  /** Max tokens for responses */
  maxTokens?: number;
  /** Custom base URL (overrides preset) */
  baseUrl?: string;
  /** Optional temperature */
  temperature?: number;
}
