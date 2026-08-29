/**
 * Native Anthropic Provider for ToolNet CLI.
 *
 * Direct integration with Anthropic Messages API (/v1/messages).
 * Converts OpenAI-compatible ChatRequest and ChatResponse structures
 * to/from Anthropic native format with streaming and tool calling support.
 */

import type {
  Provider,
  ProviderConfig,
  ModelInfo,
  ChatRequest,
  ChatResponse,
  ChatChunk,
  ChatMessage,
} from "./types";
import { resolveApiKey } from "./registry";

export const ANTHROPIC_DEFAULT_MODELS: ModelInfo[] = [
  { id: "claude-3-7-sonnet-20250219", name: "Claude 3.7 Sonnet (Thinking)", object: "model", created: Date.now(), owned_by: "anthropic" },
  { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet v2", object: "model", created: Date.now(), owned_by: "anthropic" },
  { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", object: "model", created: Date.now(), owned_by: "anthropic" },
  { id: "claude-3-opus-20240229", name: "Claude 3 Opus", object: "model", created: Date.now(), owned_by: "anthropic" },
  { id: "claude-3-haiku-20240307", name: "Claude 3 Haiku", object: "model", created: Date.now(), owned_by: "anthropic" },
];

/**
 * Normalizes Anthropic base URL.
 * e.g. "https://api.anthropic.com" -> "https://api.anthropic.com/v1"
 */
export function normalizeAnthropicBaseUrl(rawUrl?: string): string {
  if (!rawUrl || typeof rawUrl !== "string") {
    return "https://api.anthropic.com/v1";
  }
  const clean = rawUrl.trim().replace(/\/+$/, "");
  if (!clean) return "https://api.anthropic.com/v1";
  if (clean.endsWith("/v1")) return clean;
  return `${clean}/v1`;
}

export class AnthropicProvider implements Provider {
  readonly id: string;
  readonly name: string;
  private baseUrl: string;
  private apiKey: string | null;

  constructor(config: ProviderConfig) {
    if (!config) throw new Error("ProviderConfig is required for AnthropicProvider.");
    this.id = config.id || "anthropic";
    this.name = config.name?.trim() || "Anthropic";
    this.baseUrl = normalizeAnthropicBaseUrl(config.baseUrl);
    this.apiKey = resolveApiKey(config);
  }

  private getHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...extraHeaders,
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }
    return headers;
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return ANTHROPIC_DEFAULT_MODELS;
      const data = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
      if (Array.isArray(data.data) && data.data.length > 0) {
        return data.data.map((m) => ({
          id: m.id,
          name: m.display_name || m.id,
          object: "model",
          created: Date.now(),
          owned_by: "anthropic",
        }));
      }
    } catch {}
    return ANTHROPIC_DEFAULT_MODELS;
  }

  /**
   * Translates OpenAI chat messages into Anthropic { system, messages } payload.
   */
  private translatePayload(request: ChatRequest) {
    let systemPrompt = "";
    const anthropicMessages: Array<{ role: "user" | "assistant"; content: any }> = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        systemPrompt += (systemPrompt ? "\n\n" : "") + (typeof msg.content === "string" ? msg.content : "");
        continue;
      }

      if (msg.role === "user") {
        anthropicMessages.push({ role: "user", content: msg.content || "" });
        continue;
      }

      if (msg.role === "assistant") {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const contentBlocks: any[] = [];
          if (msg.content) {
            contentBlocks.push({ type: "text", text: msg.content });
          }
          for (const tc of msg.tool_calls) {
            let inputArgs = {};
            try {
              inputArgs = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments;
            } catch {}
            contentBlocks.push({
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
              input: inputArgs,
            });
          }
          anthropicMessages.push({ role: "assistant", content: contentBlocks });
        } else {
          anthropicMessages.push({ role: "assistant", content: msg.content || "" });
        }
        continue;
      }

      if (msg.role === "tool") {
        anthropicMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.tool_call_id || "call_0",
              content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
            },
          ],
        });
      }
    }

    const payload: Record<string, unknown> = {
      model: request.model.replace(/^anthropic\//, ""),
      messages: anthropicMessages,
      max_tokens: request.max_tokens || 4096,
      temperature: request.temperature ?? 0.1,
    };

    if (systemPrompt) {
      payload.system = systemPrompt;
    }

    if (request.tools && request.tools.length > 0) {
      payload.tools = request.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description || "",
        input_schema: t.function.parameters || { type: "object", properties: {} },
      }));
    }

    return payload;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!request || !request.model) throw new Error("Model is required for chat completion.");
    const payload = this.translatePayload(request);

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (request.signal?.aborted) throw new Error("Request aborted");
      try {
        const res = await fetch(`${this.baseUrl}/messages`, {
          method: "POST",
          headers: this.getHeaders(request.headers),
          body: JSON.stringify(payload),
          signal: request.signal ?? AbortSignal.timeout(120000),
        });

        if (res.status === 429 || res.status === 503) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        if (!res.ok) {
          let errText = await res.text();
          if (this.apiKey && errText.includes(this.apiKey)) {
            errText = errText.replaceAll(this.apiKey, "[REDACTED_API_KEY]");
          }
          throw new Error(`HTTP ${res.status}: ${errText}`);
        }

        const data = (await res.json()) as any;
        const toolCalls: any[] = [];
        let textContent = "";

        if (Array.isArray(data.content)) {
          for (const block of data.content) {
            if (block.type === "text") {
              textContent += block.text;
            } else if (block.type === "tool_use") {
              toolCalls.push({
                id: block.id,
                type: "function",
                function: {
                  name: block.name,
                  arguments: JSON.stringify(block.input || {}),
                },
              });
            }
          }
        }

        return {
          id: data.id || `msg_${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: request.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: textContent || null,
                tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
              },
              finish_reason: data.stop_reason === "tool_use" ? "tool_calls" : "stop",
            },
          ],
          usage: data.usage
            ? {
                prompt_tokens: data.usage.input_tokens || 0,
                completion_tokens: data.usage.output_tokens || 0,
                total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
              }
            : undefined,
        };
      } catch (err: any) {
        lastError = err;
        if (request.signal?.aborted) throw err;
      }
    }

    throw lastError || new Error("Failed to complete request after retries.");
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    if (!request || !request.model) throw new Error("Model is required for streaming.");
    const payload = {
      ...this.translatePayload(request),
      stream: true,
    };

    const res = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: this.getHeaders(request.headers),
      body: JSON.stringify(payload),
      signal: request.signal ?? AbortSignal.timeout(300000),
    });

    if (!res.ok) {
      let errText = await res.text();
      if (this.apiKey && errText.includes(this.apiKey)) {
        errText = errText.replaceAll(this.apiKey, "[REDACTED_API_KEY]");
      }
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    if (!res.body) throw new Error("No response body for streaming request");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("event:") || trimmed.startsWith(":")) continue;
        if (trimmed.startsWith("data: ")) {
          try {
            const event = JSON.parse(trimmed.slice(6));
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
              yield {
                choices: [
                  {
                    index: 0,
                    delta: { content: event.delta.text },
                    finish_reason: null,
                  },
                ],
              };
            } else if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
              yield {
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: event.index ?? 0,
                          function: { arguments: event.delta.partial_json },
                        } as any,
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
            } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
              yield {
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: event.index ?? 0,
                          id: event.content_block.id,
                          type: "function",
                          function: { name: event.content_block.name, arguments: "" },
                        } as any,
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
            } else if (event.type === "message_delta" && event.usage) {
              yield {
                choices: [{ index: 0, delta: {}, finish_reason: event.delta?.stop_reason || null }],
                usage: {
                  prompt_tokens: 0,
                  completion_tokens: event.usage.output_tokens || 0,
                  total_tokens: event.usage.output_tokens || 0,
                },
              };
            }
          } catch {}
        }
      }
    }
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok || res.status === 401; // Reachable endpoint
    } catch {
      return false;
    }
  }
}
