/**
 * Model context limits.
 *
 * Limits come from the canonical model catalog so a model's real capacity is
 * declared once, next to its capabilities and pricing. Two fallbacks exist only
 * for models the catalog has never heard of:
 *
 *   1. a legacy table retained so existing naming conventions keep working;
 *   2. a conservative default marked `source: "fallback"`.
 *
 * Nothing here invents a large capacity. Guessing high is the dangerous
 * direction — it fills a window the provider will reject — so an unknown model
 * is treated as small and flagged, never as 200k.
 */

import { modelCatalog } from "../models/catalog";
import type { ModelDefinition } from "../models/types";
import type { LimitSource, ModelLimits } from "./types";

/** Conservative assumptions for a model with no declared limits. */
export const FALLBACK_CONTEXT_WINDOW = 32_000;
export const FALLBACK_OUTPUT_TOKENS = 4_096;

/**
 * Output reservation is capped: reserving a model's full output allowance can
 * withhold more input capacity than the answer will ever need, while reserving
 * nothing guarantees an overflow on the first long reply.
 */
export const OUTPUT_RESERVE_CAP = 20_000;

interface LegacySpec {
  contextWindow: number;
  maxOutputTokens: number;
  /**
   * The trigger this identity compacted at before the canonical budget existed.
   * Kept so sessions on these names keep their cadence instead of suddenly
   * filling a window they were never measured against.
   */
  compactionThreshold: number;
}

/** Retained verbatim so previously-working model names keep their capacity. */
const LEGACY_SPECS: Record<string, LegacySpec> = {
  "openai/gpt-4o": { contextWindow: 128_000, maxOutputTokens: 4_096, compactionThreshold: 96_000 },
  "openai/gpt-4o-mini": { contextWindow: 128_000, maxOutputTokens: 4_096, compactionThreshold: 96_000 },
  "anthropic/claude-3-5-sonnet": { contextWindow: 200_000, maxOutputTokens: 8_192, compactionThreshold: 150_000 },
  "anthropic/claude-3-haiku": { contextWindow: 200_000, maxOutputTokens: 4_096, compactionThreshold: 150_000 },
  "google/gemini-2.0-flash": { contextWindow: 1_048_576, maxOutputTokens: 8_192, compactionThreshold: 500_000 },
  "google/gemini-1.5-pro": { contextWindow: 2_097_152, maxOutputTokens: 8_192, compactionThreshold: 800_000 },
  "deepseek/deepseek-chat": { contextWindow: 64_000, maxOutputTokens: 4_096, compactionThreshold: 48_000 },
  "deepseek/deepseek-coder": { contextWindow: 64_000, maxOutputTokens: 4_096, compactionThreshold: 48_000 },
  default: {
    contextWindow: FALLBACK_CONTEXT_WINDOW,
    maxOutputTokens: FALLBACK_OUTPUT_TOKENS,
    compactionThreshold: 8_000,
  },
};

function legacySpecFor(model?: string): LegacySpec | null {
  // The placeholder identity an unconfigured session runs under has always been
  // budgeted narrowly, so it keeps its own early trigger.
  if (!model) return LEGACY_SPECS.default;
  const lower = model.toLowerCase();
  if (lower === "default") return LEGACY_SPECS.default;
  for (const [key, spec] of Object.entries(LEGACY_SPECS)) {
    if (key === "default") continue;
    if (lower === key || lower.includes(key.replace(/^[^/]+\//, ""))) return spec;
  }
  if (lower.includes("claude") || lower.includes("sonnet")) {
    return LEGACY_SPECS["anthropic/claude-3-5-sonnet"];
  }
  if (lower.includes("gpt-4") || lower.includes("o1") || lower.includes("o3")) {
    return LEGACY_SPECS["openai/gpt-4o"];
  }
  if (lower.includes("gemini")) return LEGACY_SPECS["google/gemini-2.0-flash"];
  if (lower.includes("deepseek")) return LEGACY_SPECS["deepseek/deepseek-chat"];
  return null;
}

export function findCatalogModel(model: string | undefined, catalog = modelCatalog): ModelDefinition | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  const exact = catalog.get(trimmed);
  if (exact) return exact;
  const bare = trimmed.includes("/") ? trimmed.slice(trimmed.indexOf("/") + 1) : trimmed;
  return catalog.find(
    (candidate) =>
      candidate.apiModelId === trimmed ||
      candidate.apiModelId === bare ||
      candidate.id === trimmed ||
      candidate.id.toLowerCase() === trimmed.toLowerCase(),
  );
}

/**
 * Resolve limits with provenance. A catalog entry that declares only one of the
 * two values is still used for the value it declares; the other falls back.
 */
export function resolveModelLimits(model: string | undefined, catalog = modelCatalog): ModelLimits {
  const definition = findCatalogModel(model, catalog);
  if (definition) {
    const contextWindow = definition.contextWindow ?? definition.limits?.contextWindow;
    const maxOutputTokens = definition.maxOutputTokens ?? definition.limits?.maxOutputTokens;
    if (typeof contextWindow === "number" && contextWindow > 0) {
      return {
        contextWindow,
        maxOutputTokens:
          typeof maxOutputTokens === "number" && maxOutputTokens > 0 ? maxOutputTokens : FALLBACK_OUTPUT_TOKENS,
        source: "catalog",
      };
    }
  }

  const legacy = legacySpecFor(model);
  if (legacy) {
    return {
      contextWindow: legacy.contextWindow,
      maxOutputTokens: legacy.maxOutputTokens,
      source: "legacy_table",
      compactionThreshold: legacy.compactionThreshold,
    };
  }

  return {
    contextWindow: FALLBACK_CONTEXT_WINDOW,
    maxOutputTokens: FALLBACK_OUTPUT_TOKENS,
    source: "fallback",
    // An unknown model was budgeted at three quarters of the conservative
    // window before this layer existed; keep that rather than compacting later.
    compactionThreshold: 24_000,
  };
}

export function describeLimitSource(source: LimitSource): string {
  switch (source) {
    case "catalog":
      return "model catalog";
    case "legacy_table":
      return "legacy model table";
    default:
      return "conservative fallback (model limits unknown)";
  }
}
