/**
 * Phase 79 §7 — OpenRouter metadata normalization.
 *
 * Turns OpenRouter's raw `/api/v1/models` records into canonical
 * `ModelDefinition`s. Two disciplines:
 *
 *  - Unknown stays unknown. A field the API does not return is left `undefined`
 *    and never promoted to `true`/0.
 *  - Pricing is converted exactly once (per-token string → USD per 1M tokens).
 *    OpenRouter returns `-1` for "not applicable"; that becomes `undefined`
 *    rather than a negative price that would poison `cheapest` routing.
 */

import { normalizeCapabilities, mergeCapabilities } from "./capabilities";
import { formatModelRef } from "./ref";
import type { ModelCapabilities, ModelDefinition, ModelPricing } from "./types";

interface OpenRouterArchitecture {
  input_modalities?: unknown;
  output_modalities?: unknown;
  modality?: unknown;
}

interface OpenRouterPricing {
  prompt?: unknown;
  completion?: unknown;
  input_cache_read?: unknown;
  request?: unknown;
  [key: string]: unknown;
}

interface OpenRouterTopProvider {
  context_length?: unknown;
  max_completion_tokens?: unknown;
  is_moderated?: unknown;
  /** Present on setups that declare which upstream serves the model. */
  name?: unknown;
  provider_name?: unknown;
  provider_display_name?: unknown;
  slug?: unknown;
  tag?: unknown;
  [key: string]: unknown;
}

/**
 * Phase 82 §8/§9 — declared upstream identity.
 *
 * OpenRouter's listing endpoint usually does NOT name the serving upstream; the
 * endpoints endpoint does. We read ONLY an explicitly declared name and never
 * derive one from the model id or from a provider count. Missing ⇒ `undefined`
 * ⇒ the route stays `provider::default::model`, which is the honest answer.
 */
export function declaredUpstreamName(record: Record<string, unknown>): string | undefined {
  const top = (record.top_provider ?? {}) as OpenRouterTopProvider;
  const candidates: unknown[] = [
    record.upstream,
    record.upstream_id,
    top.name,
    top.provider_name,
    top.provider_display_name,
    top.slug,
    top.tag,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }
  return undefined;
}

/**
 * Phase 82 §8 — normalize an OpenRouter *endpoints* payload into per-upstream
 * route metadata.
 *
 * The caller decides whether to fetch endpoints (this module performs no
 * network I/O). Malformed entries are skipped; a payload that declares nothing
 * yields an empty map rather than invented upstreams.
 *
 * Expected shape: `{ data: { endpoints: [{ name|provider_name, ... }] } }`.
 */
export function normalizeOpenRouterEndpoints(raw: unknown): Map<string, { upstream: string; contextWindow?: number }> {
  const out = new Map<string, { upstream: string; contextWindow?: number }>();
  const data = (raw as { data?: unknown })?.data ?? raw;
  const endpoints = (data as { endpoints?: unknown })?.endpoints;
  if (!Array.isArray(endpoints)) return out;

  for (const entry of endpoints) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = declaredUpstreamName(record);
    if (!name) continue;
    const contextWindow = positive(record.context_length);
    out.set(name, { upstream: name, ...(contextWindow !== undefined ? { contextWindow } : {}) });
  }
  return out;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function positive(value: unknown): number | undefined {
  const n = asNumber(value);
  return n !== undefined && n > 0 ? n : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return out.length > 0 ? out : undefined;
}

/** USD per token → USD per 1M tokens. `-1` (n/a) and non-positive become undefined. */
function perMillion(value: unknown): number | undefined {
  const perToken = asNumber(value);
  if (perToken === undefined || perToken < 0) return undefined;
  return Math.round(perToken * 1_000_000 * 1_000_000) / 1_000_000;
}

export function normalizeOpenRouterPricing(raw: unknown): ModelPricing | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const pricing = raw as OpenRouterPricing;
  const input = perMillion(pricing.prompt);
  const output = perMillion(pricing.completion);
  const cachedInput = perMillion(pricing.input_cache_read);
  if (input === undefined && output === undefined && cachedInput === undefined) return undefined;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cachedInput !== undefined ? { cachedInput } : {}),
    currency: "USD",
    source: "provider",
  };
}

/**
 * Normalize one OpenRouter record.
 *
 * @param providerId  Registry provider id (usually "openrouter").
 * @param defaults    Provider-level declared capabilities (merged underneath
 *                    the model's own declarations, which always win).
 */
export function normalizeOpenRouterModel(
  raw: unknown,
  providerId: string,
  defaults?: ModelCapabilities,
): ModelDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const apiModelId = typeof record.id === "string" ? record.id.trim() : "";
  if (!apiModelId) return null;

  const architecture = (record.architecture ?? {}) as OpenRouterArchitecture;
  const topProvider = (record.top_provider ?? {}) as OpenRouterTopProvider;

  const contextWindow =
    positive(record.context_length) ?? positive(topProvider.context_length);
  const maxOutputTokens = positive(topProvider.max_completion_tokens);

  const modelCaps = normalizeCapabilities(record);
  const capabilities = mergeCapabilities(defaults, modelCaps);

  const inputModalities = stringList(architecture.input_modalities);
  const outputModalities = stringList(architecture.output_modalities);
  // If modalities were declared, vision is only "declared" when the channel
  // actually exists. This is an explicit statement, not a model-id guess.
  if (capabilities.vision === undefined && inputModalities) {
    capabilities.vision = inputModalities.includes("image");
  }

  const pricing = normalizeOpenRouterPricing(record.pricing);

  const metadata: Record<string, unknown> = {};
  if (typeof record.description === "string") metadata.description = record.description;
  if (typeof record.created === "number") metadata.created = record.created;
  if (topProvider.is_moderated !== undefined) metadata.moderated = topProvider.is_moderated;
  // Phase 82 §8 — only a DECLARED upstream becomes route identity.
  const upstream = declaredUpstreamName(record);
  if (upstream) metadata.upstream = upstream;
  if (Array.isArray(record.supported_parameters)) {
    metadata.supportedParameters = record.supported_parameters;
  }
  if (architecture.modality !== undefined) metadata.modality = architecture.modality;

  return {
    id: formatModelRef(providerId, apiModelId),
    providerId,
    apiModelId,
    displayName: typeof record.name === "string" && record.name.trim() ? record.name.trim() : apiModelId,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(outputModalities ? { outputModalities } : {}),
    capabilities,
    ...(pricing ? { pricing } : {}),
    ...(contextWindow !== undefined || maxOutputTokens !== undefined
      ? { limits: { ...(contextWindow !== undefined ? { contextWindow } : {}), ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}) } }
      : {}),
    status: "active",
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

/** Normalize a whole discovery response. Skips malformed rows, keeps the rest. */
export function normalizeOpenRouterModels(
  raw: unknown[],
  providerId: string,
  defaults?: ModelCapabilities,
): ModelDefinition[] {
  const out: ModelDefinition[] = [];
  for (const entry of raw) {
    const model = normalizeOpenRouterModel(entry, providerId, defaults);
    if (model) out.push(model);
  }
  return out;
}
