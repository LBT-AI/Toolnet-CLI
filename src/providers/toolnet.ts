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
  ChatRequest,
  ChatResponse,
  ChatChunk,
} from "./types";
import { resolveApiKey } from "./registry";

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

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.v1Url}/models`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: { id: string; object?: string; created?: number; owned_by?: string }[] };
      return (data.data || []).map((m) => ({
        id: m.id,
        object: m.object || "model",
        created: m.created || 0,
        owned_by: m.owned_by || "toolnet",
      }));
    } catch {
      return [];
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
