/**
 * Native Google Gemini Provider for ToolNet CLI.
 *
 * Direct integration with Google Gemini REST API (/v1beta/models).
 * Translates OpenAI-compatible requests and responses to/from
 * Gemini contents, functionDeclarations, and SSE streams.
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

export const GEMINI_DEFAULT_MODELS: ModelInfo[] = [
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", object: "model", created: Date.now(), owned_by: "google" },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", object: "model", created: Date.now(), owned_by: "google" },
  { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", object: "model", created: Date.now(), owned_by: "google" },
  { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", object: "model", created: Date.now(), owned_by: "google" },
];

export function normalizeGeminiBaseUrl(rawUrl?: string): string {
  if (!rawUrl || typeof rawUrl !== "string") {
    return "https://generativelanguage.googleapis.com/v1beta";
  }
  const clean = rawUrl.trim().replace(/\/+$/, "");
  if (!clean) return "https://generativelanguage.googleapis.com/v1beta";
  if (clean.endsWith("/v1beta")) return clean;
  return `${clean}/v1beta`;
}

export class GeminiProvider implements Provider {
  readonly id: string;
  readonly name: string;
  private baseUrl: string;
  private apiKey: string | null;

  constructor(config: ProviderConfig) {
    if (!config) throw new Error("ProviderConfig is required for GeminiProvider.");
    this.id = config.id || "gemini";
    this.name = config.name?.trim() || "Google Gemini";
    this.baseUrl = normalizeGeminiBaseUrl(config.baseUrl);
    this.apiKey = resolveApiKey(config);
  }

  private getUrl(path: string): string {
    const keyParam = this.apiKey ? `key=${encodeURIComponent(this.apiKey)}` : "";
    const sep = path.includes("?") ? "&" : "?";
    return `${this.baseUrl}${path}${keyParam ? `${sep}${keyParam}` : ""}`;
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const url = this.getUrl("/models");
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return GEMINI_DEFAULT_MODELS;
      const data = (await res.json()) as { models?: Array<{ name: string; displayName?: string }> };
      if (Array.isArray(data.models) && data.models.length > 0) {
        return data.models.map((m) => {
          const id = m.name.replace(/^models\//, "");
          return {
            id,
            name: m.displayName || id,
            object: "model",
            created: Date.now(),
            owned_by: "google",
          };
        });
      }
    } catch {}
    return GEMINI_DEFAULT_MODELS;
  }

  private translatePayload(request: ChatRequest) {
    const contents: any[] = [];
    let systemInstruction: any = null;

    for (const msg of request.messages) {
      if (msg.role === "system") {
        systemInstruction = {
          parts: [{ text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) }],
        };
        continue;
      }

      if (msg.role === "user") {
        contents.push({
          role: "user",
          parts: [{ text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) }],
        });
        continue;
      }

      if (msg.role === "assistant") {
        const parts: any[] = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            let argsObj = {};
            try {
              argsObj = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments;
            } catch {}
            parts.push({
              functionCall: {
                name: tc.function.name,
                args: argsObj,
              },
            });
          }
        }
        contents.push({ role: "model", parts });
        continue;
      }

      if (msg.role === "tool") {
        let responseObj = {};
        try {
          responseObj = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content;
        } catch {
          responseObj = { result: msg.content };
        }
        contents.push({
          role: "function",
          parts: [
            {
              functionResponse: {
                name: msg.name || "tool_result",
                response: responseObj,
              },
            },
          ],
        });
      }
    }

    const payload: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: request.temperature ?? 0.1,
        maxOutputTokens: request.max_tokens,
      },
    };

    if (systemInstruction) {
      payload.systemInstruction = systemInstruction;
    }

    if (request.tools && request.tools.length > 0) {
      payload.tools = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description || "",
            parameters: t.function.parameters || { type: "object", properties: {} },
          })),
        },
      ];
    }

    return payload;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!request || !request.model) throw new Error("Model is required for Gemini chat.");
    const model = request.model.replace(/^google\//, "").replace(/^gemini\//, "");
    const payload = this.translatePayload(request);
    const url = this.getUrl(`/models/${model}:generateContent`);

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (request.signal?.aborted) throw new Error("Request aborted");
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(request.headers || {}) },
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
        const candidate = data.candidates?.[0];
        let text = "";
        const toolCalls: any[] = [];

        if (candidate?.content?.parts) {
          for (let i = 0; i < candidate.content.parts.length; i++) {
            const p = candidate.content.parts[i];
            if (p.text) text += p.text;
            if (p.functionCall) {
              toolCalls.push({
                id: `call_${i}`,
                type: "function",
                function: {
                  name: p.functionCall.name,
                  arguments: JSON.stringify(p.functionCall.args || {}),
                },
              });
            }
          }
        }

        return {
          id: `gemini_${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: request.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: text || null,
                tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
              },
              finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
            },
          ],
          usage: data.usageMetadata
            ? {
                prompt_tokens: data.usageMetadata.promptTokenCount || 0,
                completion_tokens: data.usageMetadata.candidatesTokenCount || 0,
                total_tokens: data.usageMetadata.totalTokenCount || 0,
              }
            : undefined,
        };
      } catch (err: any) {
        lastError = err;
        if (request.signal?.aborted) throw err;
      }
    }

    throw lastError || new Error("Failed to complete Gemini request.");
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    if (!request || !request.model) throw new Error("Model is required for Gemini streaming.");
    const model = request.model.replace(/^google\//, "").replace(/^gemini\//, "");
    const payload = this.translatePayload(request);
    const url = this.getUrl(`/models/${model}:streamGenerateContent?alt=sse`);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(request.headers || {}) },
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
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (trimmed.startsWith("data: ")) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            const candidate = data.candidates?.[0];
            const parts = candidate?.content?.parts;
            if (Array.isArray(parts)) {
              for (let pIdx = 0; pIdx < parts.length; pIdx++) {
                const part = parts[pIdx];
                if (part.text) {
                  yield {
                    choices: [
                      {
                        index: 0,
                        delta: { content: part.text },
                        finish_reason: candidate.finishReason ?? null,
                      },
                    ],
                  };
                }
                if (part.functionCall) {
                  yield {
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index: pIdx,
                              id: `call_${pIdx}`,
                              type: "function",
                              function: {
                                name: part.functionCall.name,
                                arguments: JSON.stringify(part.functionCall.args || {}),
                              },
                            } as any,
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  };
                }
              }
            }
          } catch {}
        }
      }
    }
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(this.getUrl("/models"), {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok || res.status === 400 || res.status === 403;
    } catch {
      return false;
    }
  }
}
