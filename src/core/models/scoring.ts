/**
 * Phase 80 §4/§5 — Deterministic ModelScorer.
 *
 * Every weight lives in the RoutingProfile; there are no magic numbers scattered
 * in the comparator. Each component is normalized to 0..1 and combined as a
 * weighted mean of the components the profile actually cares about.
 *
 * The cardinal rule: a model that fails a REQUIRED capability is removed before
 * scoring (the router does that filtering). The scorer only ranks survivors.
 *
 * Unknown values are NEUTRAL, not zero. A model whose provider never published
 * pricing must not be ranked below a model that published a bad price, and a
 * model with no latency samples must not be ranked as slow.
 */

import type { CapabilityRequirement, ModelDefinition, ProviderDefinition, ProviderHealth, RoutingRequest } from "./types";
import { blendedPrice } from "./types";
import type { EvalDimension, ModelPerformanceProfile } from "./performance";
import type { RoutingProfileDefinition, ScoreWeights } from "./profiles";

/** Value substituted for a component whose input is unknown. */
export const NEUTRAL = 0.5;

/** Blended price (USD/1M) that scores 0.5 on the cost component. */
export const COST_REFERENCE_USD = 10;

/** Latency (ms) that scores 0.5 on the latency component. */
export const LATENCY_REFERENCE_MS = 1000;

/** Successful samples required before observed latency is trustworthy. */
export const MIN_LATENCY_SAMPLES = 2;

/** Context window (tokens) used when the request/profile declares no target. */
export const CONTEXT_REFERENCE_TOKENS = 128_000;

export type ScoreComponentKey = keyof ScoreWeights;

export interface ScoreComponent {
  key: ScoreComponentKey;
  /** Normalized 0..1. */
  value: number;
  weight: number;
  weighted: number;
  /** True when the component fell back to NEUTRAL for missing input. */
  neutral: boolean;
  note?: string;
}

export interface ModelScore {
  modelId: string;
  providerId: string;
  profile: string;
  /** Weighted mean over the profile's positive-weight components, 0..1. */
  total: number;
  components: ScoreComponent[];
  notes: string[];
}

export interface ScoreInput {
  model: ModelDefinition;
  provider: ProviderDefinition;
  health: ProviderHealth;
  profile: RoutingProfileDefinition;
  request: RoutingRequest;
  performance?: ModelPerformanceProfile;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return NEUTRAL;
  return Math.max(0, Math.min(1, value));
}

/**
 * Fraction of a requirement set that the model declares `true`.
 * No requirements ⇒ 1 (nothing to satisfy, so nothing to lose).
 */
function requirementScore(
  model: ModelDefinition,
  requirement: CapabilityRequirement | undefined,
): { value: number; note?: string } {
  const required = Object.entries(requirement ?? {}).filter(([, value]) => value === true);
  if (required.length === 0) return { value: 1 };
  let satisfied = 0;
  let unknown = 0;
  for (const [key] of required) {
    const declared = model.capabilities[key as keyof typeof model.capabilities];
    if (declared === true) satisfied += 1;
    else if (declared === undefined) unknown += 1;
  }
  return {
    value: satisfied / required.length,
    ...(unknown > 0 ? { note: `${unknown} preferred capability(ies) undeclared` } : {}),
  };
}

/**
 * Eval evidence for the profile's dimensions. Only dimensions with a real score
 * count; if none are available the component is NEUTRAL so a never-evaluated
 * model is not punished for the absence of data.
 */
export function evalScore(
  performance: ModelPerformanceProfile | undefined,
  dimensions: EvalDimension[],
): { value: number; note?: string; measured: boolean } {
  if (!performance) return { value: NEUTRAL, measured: false, note: "no eval data" };
  const scored: number[] = [];
  const missing: string[] = [];
  for (const dimension of dimensions) {
    const value = performance.scores[dimension];
    if (typeof value === "number" && Number.isFinite(value)) scored.push(value);
    else missing.push(dimension);
  }
  if (scored.length === 0) return { value: NEUTRAL, measured: false, note: "insufficient eval samples" };
  const mean = scored.reduce((sum, value) => sum + value, 0) / scored.length;
  return {
    value: clamp01(mean),
    measured: true,
    ...(missing.length > 0 ? { note: `unmeasured: ${missing.join(",")}` } : {}),
  };
}

function healthScore(state: ProviderHealth["state"]): number {
  switch (state) {
    case "healthy":
      return 1;
    case "unknown":
      return NEUTRAL;
    case "degraded":
      return 0.25;
    case "unavailable":
      return 0;
  }
}

/** Inverse-normalized cost; unknown pricing is NEUTRAL, never free. */
function costScore(model: ModelDefinition): { value: number; neutral: boolean; note?: string } {
  const price = blendedPrice(model);
  if (price === undefined) return { value: NEUTRAL, neutral: true, note: "pricing undeclared" };
  return { value: clamp01(1 / (1 + price / COST_REFERENCE_USD)), neutral: false };
}

/**
 * Observed latency. Requires MIN_LATENCY_SAMPLES successful calls; otherwise the
 * component reports `insufficient_data` and scores NEUTRAL.
 */
export function latencyScore(health: ProviderHealth): {
  value: number;
  neutral: boolean;
  sufficient: boolean;
  note?: string;
} {
  if (health.successCount < MIN_LATENCY_SAMPLES || typeof health.latencyMs !== "number") {
    return { value: NEUTRAL, neutral: true, sufficient: false, note: "insufficient latency samples" };
  }
  return { value: clamp01(1 / (1 + health.latencyMs / LATENCY_REFERENCE_MS)), neutral: false, sufficient: true };
}

function contextScore(model: ModelDefinition, target: number): { value: number; neutral: boolean; note?: string } {
  const context = model.contextWindow ?? model.limits?.contextWindow;
  if (typeof context !== "number" || !Number.isFinite(context) || context <= 0) {
    return { value: NEUTRAL, neutral: true, note: "context window undeclared" };
  }
  return { value: clamp01(context / target), neutral: false };
}

/** Target context window for a request under a profile. */
export function contextTarget(request: RoutingRequest, profile: RoutingProfileDefinition): number {
  const requested = request.minContextWindow;
  if (typeof requested === "number" && requested > 0) return requested;
  if (profile.minContextWindow) return profile.minContextWindow;
  return CONTEXT_REFERENCE_TOKENS;
}

/**
 * Score a single candidate. Purely a function of its inputs — calling it twice
 * with the same arguments yields the same score.
 */
export function scoreModel(input: ScoreInput): ModelScore {
  const { model, provider, health, profile, request, performance } = input;
  const notes: string[] = [];
  const components: ScoreComponent[] = [];

  const preferRequirement = {
    ...(profile.preferredCapabilities ?? {}),
    ...(request.preferredCapabilities ?? {}),
  };

  const capability = requirementScore(model, profile.preferredCapabilities);
  const preference = requirementScore(model, preferRequirement);
  const evaluation = evalScore(performance, profile.evalDimensions);
  const latency = latencyScore(health);
  const cost = costScore(model);
  const context = contextScore(model, contextTarget(request, profile));

  const raw: Array<{ key: ScoreComponentKey; value: number; neutral: boolean; note?: string }> = [
    { key: "capability", value: capability.value, neutral: false, note: capability.note },
    { key: "preference", value: preference.value, neutral: false, note: preference.note },
    { key: "eval", value: evaluation.value, neutral: !evaluation.measured, note: evaluation.note },
    { key: "health", value: healthScore(health.state), neutral: health.state === "unknown" },
    { key: "latency", value: latency.value, neutral: latency.neutral, note: latency.note },
    { key: "cost", value: cost.value, neutral: cost.neutral, note: cost.note },
    { key: "context", value: context.value, neutral: context.neutral, note: context.note },
  ];

  let weightSum = 0;
  let weightedSum = 0;
  for (const entry of raw) {
    const weight = profile.weights[entry.key] ?? 0;
    if (weight <= 0) continue;
    const value = clamp01(entry.value);
    weightedSum += value * weight;
    weightSum += weight;
    components.push({
      key: entry.key,
      value: Math.round(value * 1000) / 1000,
      weight,
      weighted: Math.round(value * weight * 1000) / 1000,
      neutral: entry.neutral,
      ...(entry.note ? { note: entry.note } : {}),
    });
    if (entry.neutral && entry.note) notes.push(`${entry.key}: ${entry.note}`);
  }

  const total = weightSum > 0 ? Math.round((weightedSum / weightSum) * 1000) / 1000 : 0;

  return {
    modelId: model.id,
    providerId: provider.id,
    profile: profile.id,
    total: clamp01(total),
    components,
    notes,
  };
}

/** Convenience: score only the total (used by the router's comparator). */
export function scoreTotal(input: ScoreInput): number {
  return scoreModel(input).total;
}
