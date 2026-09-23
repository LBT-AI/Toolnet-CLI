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
import type { LimitSource, ModelLimits, UsableInput } from "./types";

/** Conservative assumptions for a model with no declared limits. */
export const FALLBACK_CONTEXT_WINDOW = 32_000;
export const FALLBACK_OUTPUT_TOKENS = 4_096;

/**
 * Capacity withheld for the answer when a model declares its input limit.
 *
 * The reservation is capped because reserving a model's full output allowance
 * can withhold more input capacity than the answer will ever need, while
 * reserving nothing guarantees an overflow on the first long reply. This is the
 * ONLY global number in the budget: which rule applies, and how large `usable`
 * is, comes from each model's own declared limits.
 */
export const COMPACTION_BUFFER = 20_000;

/**
 * How much of the newest conversation survives a compaction VERBATIM.
 *
 * This is the `keep` budget, not a threshold: everything older than the newest
 * ~8K tokens is summarized into the checkpoint, while the tail stays in the
 * request untouched so the model keeps the exact context it is working on.
 * Completely independent of `COMPACTION_BUFFER`, which is about the answer.
 */
export const COMPACTION_KEEP_RECENT_TOKENS = 8_000;

interface LegacySpec {
  contextWindow: number;
  maxOutputTokens: number;
}

/** Retained verbatim so previously-working model names keep their capacity. */
const LEGACY_SPECS: Record<string, LegacySpec> = {
  "openai/gpt-4o": { contextWindow: 128_000, maxOutputTokens: 4_096 },
  "openai/gpt-4o-mini": { contextWindow: 128_000, maxOutputTokens: 4_096 },
  "anthropic/claude-3-5-sonnet": { contextWindow: 200_000, maxOutputTokens: 8_192 },
  "anthropic/claude-3-haiku": { contextWindow: 200_000, maxOutputTokens: 4_096 },
  "google/gemini-2.0-flash": { contextWindow: 1_048_576, maxOutputTokens: 8_192 },
  "google/gemini-1.5-pro": { contextWindow: 2_097_152, maxOutputTokens: 8_192 },
  "deepseek/deepseek-chat": { contextWindow: 64_000, maxOutputTokens: 4_096 },
  "deepseek/deepseek-coder": { contextWindow: 64_000, maxOutputTokens: 4_096 },
  default: {
    contextWindow: FALLBACK_CONTEXT_WINDOW,
    maxOutputTokens: FALLBACK_OUTPUT_TOKENS,
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
function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * A declared input limit is only meaningful when it is smaller than the window
 * it belongs to. A value at or above the window says nothing new, so it is
 * treated as undeclared rather than as a third, contradictory number.
 */
function inputLimitFor(
  contextWindow: number,
  declared: unknown,
): number | undefined {
  const input = positiveNumber(declared);
  if (input === undefined) return undefined;
  return input < contextWindow ? input : undefined;
}

export function resolveModelLimits(model: string | undefined, catalog = modelCatalog): ModelLimits {
  const definition = findCatalogModel(model, catalog);
  if (definition) {
    const contextWindow = definition.contextWindow ?? definition.limits?.contextWindow;
    const maxOutputTokens = definition.maxOutputTokens ?? definition.limits?.maxOutputTokens;
    if (typeof contextWindow === "number" && contextWindow > 0) {
      const inputLimit = inputLimitFor(contextWindow, definition.limits?.input);
      return {
        contextWindow,
        ...(inputLimit !== undefined ? { inputLimit } : {}),
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
    };
  }

  return {
    contextWindow: FALLBACK_CONTEXT_WINDOW,
    maxOutputTokens: FALLBACK_OUTPUT_TOKENS,
    source: "fallback",
  };
}

/**
 * Resolve how much of a model's capacity this request may use.
 *
 * Rule selection is metadata-driven, so the trigger is per-model:
 *   - the model declares an input limit → `input - reserved`;
 *   - otherwise → `context - maxOutputTokens`.
 *
 * `configuredReserved` lets a deployment override the withheld amount for the
 * first rule; it never widens capacity past the declared input limit.
 */
export function resolveUsableInput(
  limits: Pick<ModelLimits, "contextWindow" | "maxOutputTokens"> & { inputLimit?: number | undefined },
  configuredReserved?: number,
): UsableInput {
  if (limits.inputLimit !== undefined && limits.inputLimit > 0) {
    const reserved = Math.max(
      1,
      configuredReserved !== undefined
        ? configuredReserved
        : Math.min(COMPACTION_BUFFER, limits.maxOutputTokens),
    );
    return {
      usable: Math.max(0, limits.inputLimit - reserved),
      reserved,
      rule: "input_minus_reserved",
    };
  }

  return {
    usable: Math.max(0, limits.contextWindow - limits.maxOutputTokens),
    reserved: limits.maxOutputTokens,
    rule: "context_minus_output",
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
