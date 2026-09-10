/**
 * ToolNet API Provider (Optional).
 *
 * Wraps the ToolNet Gateway for users who explicitly choose
 * to route through a local or remote ToolNet API gateway.
 *
 * This is NOT loaded unless the user selects it as their provider.
 * Does NOT read ~/.toolnetapi or connect to localhost on startup.
 */

import type {
  Provider,
  ProviderConfig,
  ModelInfo,
  ModelCapabilities,
  ChatRequest,
  ChatResponse,
  ChatChunk,
} from "./types";
import { resolveApiKey } from "./registry";

export const TOOLNET_DEFAULT_MODELS: ModelInfo[] = [
  { id: "alims-intl.llm", name: "Alibaba Intl LLM", object: "model", created: Date.now(), owned_by: "combo" },
  { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", object: "model", created: Date.now(), owned_by: "toolnet" },
  { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet", object: "model", created: Date.now(), owned_by: "toolnet" },
  { id: "gpt-4o", name: "GPT-4o", object: "model", created: Date.now(), owned_by: "toolnet" },
  { id: "deepseek-chat", name: "DeepSeek V3", object: "model", created: Date.now(), owned_by: "toolnet" },
];

/**
 * Normalizes ToolNet baseUrl into rootUrl (for /api/*) and v1Url (for /v1/*).
 */
export function normalizeToolNetBaseUrl(rawUrl: string): { rootUrl: string; v1Url: string } {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new Error("ToolNet provider baseUrl is required and must be a valid URL string.");
  }
  const clean = rawUrl.trim().replace(/\/+$/, "");
  if (!clean) {
    throw new Error("ToolNet provider baseUrl cannot be empty.");
  }
  const rootUrl = clean.endsWith("/v1") ? clean.slice(0, -3) : clean;
  const v1Url = clean.endsWith("/v1") ? clean : `${clean}/v1`;
  return { rootUrl, v1Url };
}

/**
 * Maps gateway capability metadata to ModelCapabilities.
 * reasoningStream/reasoningTokens default to true when the model reasons and
 * the gateway exposes a thinking format; reasoningEffort is only true when
 * the gateway explicitly declares it (never assumed).
 */
function toModelCapabilities(
  c: Record<string, unknown> & { reasoning?: boolean; thinkingFormat?: string | null; thinkingCanDisable?: boolean }
): ModelCapabilities {
  const reasoning = Boolean(c.reasoning);
  return {
    reasoning,
    reasoningStream: reasoning ? true : false,
    reasoningEffort: Boolean(c.reasoningEffort) || false,
    reasoningTokens: reasoning ? true : false,
    // §13 — pass through tool-calling metadata from the gateway. When the
    // gateway explicitly declares tools/nativeToolCalls these drive the agent
    // loop's capability gate; undefined keeps the "assume capable" default.
    ...(c.tools !== undefined ? { tools: Boolean(c.tools) } : {}),
    ...(c.nativeToolCalls !== undefined ? { nativeToolCalls: Boolean(c.nativeToolCalls) } : {}),
    ...(c.vision !== undefined ? { vision: Boolean(c.vision) } : {}),
    ...(c.streaming !== undefined ? { streaming: Boolean(c.streaming) } : {}),
  };
}

export class ToolNetProvider implements Provider {
  readonly id = "toolnet";
  readonly name: string;
  private rootUrl: string;
  private v1Url: string;
  private apiKey: string | null;

  constructor(config: ProviderConfig) {
    if (!config) {
      throw new Error("ProviderConfig is required for ToolNetProvider.");
    }
    this.name = config.name?.trim() || "ToolNet Gateway";
    const { rootUrl, v1Url } = normalizeToolNetBaseUrl(config.baseUrl);
    this.rootUrl = rootUrl;
    this.v1Url = v1Url;
    this.apiKey = resolveApiKey(config);
  }

  private getHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...extraHeaders,
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }


  async validateCredentials(key: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.v1Url}/models`, {
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json"
        }
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.v1Url}/models`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return TOOLNET_DEFAULT_MODELS;
      const data = (await res.json()) as {
        data?: {
          id: string;
          object?: string;
          created?: number;
          owned_by?: string;
          capabilities?: Record<string, unknown> & { reasoning?: boolean; thinkingFormat?: string | null; thinkingCanDisable?: boolean };
        }[];
      };
      const models = (data.data || []).map((m) => ({
        id: m.id,
        object: m.object || "model",
        created: m.created || 0,
        owned_by: m.owned_by || "toolnet",
        // Source of truth: the gateway's own capability metadata when present.
        // Never substring-guess model ids.
        capabilities: m.capabilities ? toModelCapabilities(m.capabilities) : undefined,
      }));
      return models.length > 0 ? models : TOOLNET_DEFAULT_MODELS;
    } catch {
      return TOOLNET_DEFAULT_MODELS;
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!request || !request.model) {
      throw new Error("Model is required for chat completion.");
    }
    if (!Array.isArray(request.messages)) {
      throw new Error("Messages array is required for chat completion.");
    }

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0.1,
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
      body.tool_choice = request.tool_choice ?? "auto";
    }
    if (request.reasoningEffort) {
      body.reasoning_effort = request.reasoningEffort;
    }

    const res = await fetch(`${this.v1Url}/chat/completions`, {
      method: "POST",
      headers: this.getHeaders(request.headers),
      body: JSON.stringify(body),
      signal: request.signal ?? AbortSignal.timeout(120000),
    });

    if (!res.ok) {
      let errText = await res.text();
      if (this.apiKey && errText.includes(this.apiKey)) {
        errText = errText.replaceAll(this.apiKey, "[REDACTED_API_KEY]");
      }
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    // Some ToolNet gateway builds append a "data: [DONE]" stream sentinel to
    // non-streaming responses, so read the raw text and strip it before
    // parsing. Real fetch Response always has .text(); minimal test mocks
    // only expose .json(), so keep that path as a fallback.
    if (typeof (res as any).text === "function") {
      const raw = await res.text();
      const cleaned = raw.replace(/\s*data:\s*\[DONE\]\s*$/, "").trim();
      try {
        return JSON.parse(cleaned) as ChatResponse;
      } catch {
        throw new Error(`Invalid JSON from chat endpoint (status ${res.status})`);
      }
    }
    return (await res.json()) as ChatResponse;
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    if (!request || !request.model) {
      throw new Error("Model is required for streaming chat completion.");
    }
    if (!Array.isArray(request.messages)) {
      throw new Error("Messages array is required for streaming chat completion.");
    }

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream: true,
      temperature: request.temperature ?? 0.1,
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
      body.tool_choice = request.tool_choice ?? "auto";
    }
    if (request.reasoningEffort) {
      body.reasoning_effort = request.reasoningEffort;
    }

    const res = await fetch(`${this.v1Url}/chat/completions`, {
      method: "POST",
      headers: this.getHeaders(request.headers),
      body: JSON.stringify(body),
      signal: request.signal ?? AbortSignal.timeout(300000),
    });

    if (!res.ok) {
      let errText = await res.text();
      if (this.apiKey && errText.includes(this.apiKey)) {
        errText = errText.replaceAll(this.apiKey, "[REDACTED_API_KEY]");
      }
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    if (!res.body || typeof (res.body as any).getReader !== "function") {
      try {
        const json = (await res.json()) as any;
        yield {
          id: json.id,
          object: json.object,
          created: json.created,
          model: json.model,
          choices: json.choices?.map((c: any) => ({
            index: c.index ?? 0,
            delta: { content: c.message?.content || "" },
            finish_reason: c.finish_reason ?? "stop",
          })) || [],
        };
        return;
      } catch {
        throw new Error("No response body for streaming request");
      }
    }

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
        if (!trimmed || trimmed === "data: [DONE]" || trimmed.startsWith(":")) continue;
        if (trimmed.startsWith("data: ")) {
          try {
            const json = JSON.parse(trimmed.slice(6));
            yield json as ChatChunk;
          } catch {}
        }
      }
    }
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.rootUrl}/api/health`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
