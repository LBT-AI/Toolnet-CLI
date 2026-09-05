/**
 * Provider Abstraction Layer for ToolNet CLI.
 *
 * Core agent/TUI only interacts via these interfaces.
 * No direct ToolNet API gateway imports in core runtime.
 */

export interface ModelInfo {
  id: string;
  name?: string;
  object: string;
  created: number;
  owned_by: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "required" | "none";
  temperature?: number;
  max_tokens?: number;
  /** Extra HTTP headers (e.g. bypass headers) */
  headers?: Record<string, string>;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Provider-specific detail fields; never added twice to total_tokens. */
  prompt_tokens_details?: {
    cached_tokens?: number;
    [key: string]: unknown;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    [key: string]: unknown;
  };
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
  [key: string]: unknown;
}

export interface ChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: Usage;
}

export interface ChatChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices: {
    index: number;
    delta: Partial<ChatMessage>;
    finish_reason: string | null;
  }[];
  usage?: Usage;
}

/**
 * Provider interface — all core agent/TUI code uses this.
 * ToolNet API is just one optional implementation.
 */
export interface Provider {
  readonly id: string;
  readonly name: string;

  /** List available models from this provider */
  listModels(): Promise<ModelInfo[]>;

  /** Send a chat completion request */
  chat(request: ChatRequest): Promise<ChatResponse>;

  /** Stream a chat completion request */
  stream?(request: ChatRequest): AsyncIterable<ChatChunk>;

  /** Health check — returns true if provider is reachable */
  health?(): Promise<boolean>;
}

/**
 * Provider configuration stored in ~/.toolnetcli/config.json
 */
export interface ProviderConfig {
  /** Provider ID (e.g. "openai-compatible", "toolnet", "openai") */
  id: string;
  /** Display name */
  name: string;
  /** Base URL for API calls */
  baseUrl: string;
  /** Environment variable name for API key (not the key itself) */
  apiKeyEnv?: string;
  /** API key stored inline (deprecated, prefer env) */
  apiKey?: string;
  /** Default model for this provider */
  defaultModel?: string;
  /** Whether this is the currently active provider */
  active?: boolean;
  /** Provider adapter type (e.g. "openai-compatible", "anthropic", "gemini", "toolnet") */
  type?: string;
}
