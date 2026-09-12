/**
 * Phase 79 §7 — OpenRouter provider adapter.
 *
 * Built ON the existing OpenAI-compatible abstraction (OpenRouter's chat
 * surface is OpenAI-shaped), adding only what is genuinely OpenRouter-specific:
 * a `discoverModels()` call against `GET /api/v1/models` that returns the raw
 * capability/pricing records.
 *
 * Normalization into canonical `ModelDefinition`s lives in
 * `src/core/models/openrouter.ts` — a provider adapter reports what the remote
 * said, it does not decide how the catalog represents it.
 *
 * The API key is never logged. Discovery is a public endpoint, but the key is
 * attached when present so a private/proxied deployment still works.
 */

import type { ProviderConfig } from "./types";
import { OpenAICompatibleProvider, normalizeOpenAiBaseUrl } from "./openaiCompatible";
import { resolveApiKey } from "./registry";

export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/** One raw record from OpenRouter's model listing. Shape is remote-owned. */
export interface OpenRouterModelRecord {
  [key: string]: unknown;
  id: string;
}

export interface OpenRouterDiscoveryOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Default discovery budget — model listings are small and cacheable. */
export const OPENROUTER_DISCOVERY_TIMEOUT_MS = 15_000;

export class OpenRouterProvider extends OpenAICompatibleProvider {
  private readonly discoveryBaseUrl: string;
  private readonly discoveryKey: string | null;

  constructor(config: ProviderConfig) {
    // Force the OpenAI-compatible transport; OpenRouter speaks that dialect.
    super({ ...config, type: "openai-compatible" });
    this.discoveryBaseUrl = normalizeOpenAiBaseUrl(config.baseUrl || OPENROUTER_DEFAULT_BASE_URL);
    this.discoveryKey = resolveApiKey(config);
  }

  /**
   * Fetch the remote model catalog.
   *
   * Throws on failure — the caller (refresh) is responsible for preserving the
   * previous catalog rather than being handed a silently-truncated list.
   */
  async discoverModels(options: OpenRouterDiscoveryOptions = {}): Promise<OpenRouterModelRecord[]> {
    const timeout = options.timeoutMs ?? OPENROUTER_DISCOVERY_TIMEOUT_MS;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // OpenRouter uses these for attribution; harmless and never a secret.
      "HTTP-Referer": "https://github.com/LBT-AI/Toolnet-CLI",
      "X-Title": "ToolNet CLI",
    };
    if (this.discoveryKey) headers["Authorization"] = `Bearer ${this.discoveryKey}`;

    const response = await fetch(`${this.discoveryBaseUrl}/models`, {
      method: "GET",
      headers,
      signal: options.signal ?? AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      const text = await safeText(response);
      throw new Error(`OpenRouter model discovery failed: HTTP ${response.status}${text ? ` — ${text}` : ""}`);
    }

    const payload = (await response.json()) as { data?: unknown };
    const data = Array.isArray(payload?.data) ? payload.data : [];
    return data
      .filter((entry): entry is OpenRouterModelRecord =>
        Boolean(entry) && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string",
      )
      .map((entry) => ({ ...entry, id: String(entry.id) }));
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    if (typeof response.text !== "function") return "";
    const text = await response.text();
    return text.slice(0, 300);
  } catch {
    return "";
  }
}
