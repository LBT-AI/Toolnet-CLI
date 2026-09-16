/**
 * OpenAI-Compatible Provider Implementation.
 *
 * Works with any endpoint exposing standard OpenAI-compatible routes:
 *   - GET  /v1/models (or /models)
 *   - POST /v1/chat/completions (or /chat/completions)
 *
 * Used for: OpenAI, Anthropic (via proxy), DeepSeek, Groq,
 *           OpenRouter, Together, Mistral, Ollama, LM Studio, custom OpenAI-compat APIs.
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
import { isQuotaExhaustedMessage, isRetryableTransportError } from "../core/models/failureKind";

/**
 * Normalizes any baseUrl to an OpenAI /v1 endpoint root.
 * Supports:
 *   https://api.example.com
 *   https://api.example.com/
 *   https://api.example.com/v1
 *   https://api.example.com/v1/
 *
 * Always produces clean baseUrl ending in /v1 without trailing slash.
 */
export function normalizeOpenAiBaseUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new Error("Provider baseUrl is required and must be a valid URL string.");
  }
  const clean = rawUrl.trim().replace(/\/+$/, "");
  if (!clean) {
    throw new Error("Provider baseUrl cannot be empty.");
  }
  if (clean.endsWith("/v1")) {
    return clean;
  }
  return `${clean}/v1`;
}

const DEFAULT_OPENAI_MODELS: Record<string, ModelInfo[]> = {
  openai: [
    { id: "gpt-4o", name: "GPT-4o", object: "model", created: Date.now(), owned_by: "openai" },
    { id: "gpt-4o-mini", name: "GPT-4o Mini", object: "model", created: Date.now(), owned_by: "openai" },
    { id: "o1", name: "o1", object: "model", created: Date.now(), owned_by: "openai" },
    { id: "o3-mini", name: "o3-mini", object: "model", created: Date.now(), owned_by: "openai" },
  ],
  deepseek: [
    { id: "deepseek-chat", name: "DeepSeek Chat (V3)", object: "model", created: Date.now(), owned_by: "deepseek" },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner (R1)", object: "model", created: Date.now(), owned_by: "deepseek" },
  ],
  groq: [
    { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B", object: "model", created: Date.now(), owned_by: "groq" },
    { id: "mixtral-8x7b-32768", name: "Mixtral 8x7B", object: "model", created: Date.now(), owned_by: "groq" },
  ],
  openrouter: [
    { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", object: "model", created: Date.now(), owned_by: "openrouter" },
    { id: "openai/gpt-4o", name: "GPT-4o", object: "model", created: Date.now(), owned_by: "openrouter" },
  ],
};

export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly name: string;
  private baseUrl: string;
  private apiKey: string | null;

  constructor(config: ProviderConfig) {
    if (!config) {
      throw new Error("ProviderConfig is required.");
    }
    if (!config.id || typeof config.id !== "string" || !config.id.trim()) {
      throw new Error("Provider ID is required.");
    }
    this.id = config.id.trim();
    this.name = config.name?.trim() || this.id;
    this.baseUrl = normalizeOpenAiBaseUrl(config.baseUrl);
    this.apiKey = resolveApiKey(config);
  }

  /** Provider-supplied text is redacted before it can reach a log or an error. */
  private redactBody(text: string): string {
    if (this.apiKey && text.includes(this.apiKey)) return text.replaceAll(this.apiKey, "[REDACTED_API_KEY]");
    return text;
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
    const fallback = DEFAULT_OPENAI_MODELS[this.id.toLowerCase()] || [];
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return fallback;
      const data = (await res.json()) as { data?: { id: string; object?: string; created?: number; owned_by?: string }[] };
      const models = (data.data || []).map((m) => ({
        id: m.id,
        object: m.object || "model",
        created: m.created || 0,
        owned_by: m.owned_by || this.id,
      }));
      return models.length > 0 ? models : fallback;
    } catch {
      return fallback;
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

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (request.signal?.aborted) throw new Error("Request aborted");
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: this.getHeaders(request.headers),
          body: JSON.stringify(body),
          signal: request.signal ?? AbortSignal.timeout(120000),
        });

        if (res.status === 429 || res.status === 503) {
          // A quota-exhausted 429 shares the status with a transient rate limit
          // but never clears on its own: surface it once instead of retrying.
          const bodyText = await res.text().catch(() => "");
          const evidence = this.redactBody(bodyText).slice(0, 500);
          if (res.status === 429 && isQuotaExhaustedMessage(bodyText)) {
            throw new Error(`HTTP 429: ${evidence}`);
          }
          // Keep the failure on record: if every attempt is rejected, the
          // caller must still learn WHICH status and why, otherwise the failure
          // classifier can only report an unclassifiable "unknown".
          lastError = new Error(`HTTP ${res.status}: ${evidence || "transient provider failure"}`);
          // Honor Retry-After when present, bounded to 30s and abort-interruptible.
          const retryAfterHeader = res.headers.get("retry-after");
          let delayMs = Math.min(4_000, Math.pow(2, attempt) * 500) + Math.floor(Math.random() * 250);
          if (retryAfterHeader) {
            const retryAfterSec = Number(retryAfterHeader.trim());
            if (Number.isFinite(retryAfterSec) && retryAfterSec >= 0) {
              delayMs = Math.min(retryAfterSec * 1000, 30_000);
            } else {
              const retryAfterDate = Date.parse(retryAfterHeader);
              if (Number.isFinite(retryAfterDate)) {
                delayMs = Math.min(Math.max(0, retryAfterDate - Date.now()), 30_000);
              }
            }
          }
          // Never sleep before giving up: the delay only buys another attempt.
          if (attempt < 2) {
            if (request.signal) {
              await new Promise<void>((resolve, reject) => {
                const t = setTimeout(resolve, delayMs);
                (t as any).unref?.();
                const onAbort = () => { clearTimeout(t); reject(new Error("Request aborted")); };
                request.signal!.addEventListener("abort", onAbort, { once: true });
              });
            } else {
              await new Promise((r) => setTimeout(r, delayMs));
            }
          }
          continue;
        }

        if (!res.ok) {
          let errText = await res.text();
          if (this.apiKey && errText.includes(this.apiKey)) {
            errText = errText.replaceAll(this.apiKey, "[REDACTED_API_KEY]");
          }
          throw new Error(`HTTP ${res.status}: ${errText}`);
        }

        return (await res.json()) as ChatResponse;
      } catch (err: any) {
        lastError = err;
        if (request.signal?.aborted) throw err;
        if (typeof err?.message === "string" && err.message.startsWith("HTTP 40")) throw err;
        // A classified quota exhaustion is terminal, never a 5xx/network retry.
        if (typeof err?.message === "string" && isQuotaExhaustedMessage(err.message)) throw err;
        // Transient 5xx / transport failure — bounded backoff with jitter before
        // the next attempt. Reset codes live on `err.cause`, so classification
        // goes through the shared transport check rather than message text.
        if (attempt < 2 && isRetryableTransportError(err)) {
          const backoffMs = Math.min(4000, Math.pow(2, attempt) * 500 + Math.floor(Math.random() * 250));
          if (request.signal) {
            try {
              await new Promise<void>((resolve, reject) => {
                const t = setTimeout(resolve, backoffMs);
                (t as any).unref?.();
                const onAbort = () => { clearTimeout(t); reject(new Error("Request aborted")); };
                request.signal!.addEventListener("abort", onAbort, { once: true });
              });
            } catch (abortErr) { throw abortErr; }
          } else {
            await new Promise((r) => setTimeout(r, backoffMs));
          }
        }
      }
    }

    throw lastError || new Error("Failed to complete request after retries.");
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

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.getHeaders(request.headers),
      body: JSON.stringify(body),
      signal: request.signal ?? AbortSignal.timeout(300000),
    });

    if (!res.ok) {
      // Surface Retry-After on streaming failures so callers can honor it.
      const retryAfter = res.headers.get("retry-after");
      let errText = await res.text();
      if (this.apiKey && errText.includes(this.apiKey)) {
        errText = errText.replaceAll(this.apiKey, "[REDACTED_API_KEY]");
      }
      const suffix = retryAfter ? ` Retry-After: ${retryAfter}` : "";
      throw new Error(`HTTP ${res.status}: ${errText}${suffix}`);
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
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
