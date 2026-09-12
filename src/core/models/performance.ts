/**
 * Phase 80 §16 — Model performance profile.
 *
 * The bridge between the eval layer and routing. Eval runs produce normalized
 * *samples*; this module aggregates them into per-model, per-dimension scores.
 *
 * The load-bearing rule: a score is only produced when there is enough data.
 * `insufficient` lists the dimensions that were measured too few times, and the
 * router treats those as NEUTRAL rather than as a low score. A model that has
 * never been evaluated must not lose to one that has been evaluated badly.
 */

export type EvalDimension =
  | "coding"
  | "reasoning"
  | "toolUse"
  | "structuredOutput"
  | "reliability"
  | "latency"
  | "costEfficiency";

export const EVAL_DIMENSIONS: EvalDimension[] = [
  "coding",
  "reasoning",
  "toolUse",
  "structuredOutput",
  "reliability",
  "latency",
  "costEfficiency",
];

/** Minimum samples before a dimension may be scored. */
export const MIN_SAMPLES = 3;

export interface EvalDimensionScores {
  coding?: number;
  reasoning?: number;
  toolUse?: number;
  structuredOutput?: number;
  reliability?: number;
  latency?: number;
  costEfficiency?: number;
}

export interface ModelPerformanceProfile {
  modelId: string;
  providerId: string;
  /** Total samples folded into this profile. */
  samples: number;
  scores: EvalDimensionScores;
  /** Dimensions that did not reach MIN_SAMPLES — never scored, never guessed. */
  insufficient: EvalDimension[];
  updatedAt: number;
}

/**
 * One evaluated request. `dimension` is the capability the case was designed to
 * exercise; `success` is the deterministic grader verdict.
 */
export interface PerformanceSample {
  modelId: string;
  providerId: string;
  dimension?: EvalDimension;
  success: boolean;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  toolCalls?: number;
  failedToolCalls?: number;
  /** Normalized failure classification (never "model quality" for a timeout). */
  failureClass?: string;
}

/** Clamp a ratio into 0..1, treating non-finite input as 0. */
function ratio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.max(0, Math.min(1, numerator / denominator));
}

/** Round to 3 decimals so profiles are stable and diffable. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Aggregate samples into a profile. Deterministic: scores depend only on the
 * sample multiset, not on order.
 *
 * Dimensions:
 *  - reliability  = success rate (always measurable when samples exist)
 *  - toolUse      = success rate over samples that requested tool calls, minus
 *                   a penalty for failed tool calls
 *  - coding / reasoning / structuredOutput = success rate over cases of that
 *                   dimension
 *  - latency      = inverse-normalized mean duration (< MIN_SAMPLES → unscored)
 *  - costEfficiency = inverse-normalized mean cost when pricing was reported
 */
export function aggregatePerformance(samples: PerformanceSample[]): ModelPerformanceProfile | null {
  if (samples.length === 0) return null;
  const { modelId, providerId } = samples[0];

  const byDimension = new Map<EvalDimension, { success: number; total: number }>();
  let successes = 0;
  let latencySum = 0;
  let latencyCount = 0;
  let costSum = 0;
  let costCount = 0;
  let toolSuccess = 0;
  let toolTotal = 0;
  let toolFailures = 0;

  for (const sample of samples) {
    if (sample.success) successes += 1;
    if (typeof sample.durationMs === "number" && Number.isFinite(sample.durationMs) && sample.durationMs >= 0) {
      latencySum += sample.durationMs;
      latencyCount += 1;
    }
    if (typeof sample.costUsd === "number" && Number.isFinite(sample.costUsd) && sample.costUsd >= 0) {
      costSum += sample.costUsd;
      costCount += 1;
    }
    if ((sample.toolCalls ?? 0) > 0) {
      toolTotal += 1;
      toolFailures += sample.failedToolCalls ?? 0;
      if (sample.success && (sample.failedToolCalls ?? 0) === 0) toolSuccess += 1;
    }
    if (sample.dimension) {
      const entry = byDimension.get(sample.dimension) ?? { success: 0, total: 0 };
      entry.total += 1;
      if (sample.success) entry.success += 1;
      byDimension.set(sample.dimension, entry);
    }
  }

  const scores: EvalDimensionScores = {};
  const insufficient: EvalDimension[] = [];

  const reliability = samples.length >= MIN_SAMPLES ? round(ratio(successes, samples.length)) : undefined;
  if (reliability === undefined) insufficient.push("reliability");
  else scores.reliability = reliability;

  for (const dimension of ["coding", "reasoning", "structuredOutput"] as const) {
    const entry = byDimension.get(dimension);
    if (!entry || entry.total < MIN_SAMPLES) {
      insufficient.push(dimension);
      continue;
    }
    scores[dimension] = round(ratio(entry.success, entry.total));
  }

  if (toolTotal < MIN_SAMPLES) {
    insufficient.push("toolUse");
  } else {
    // A failed tool call within an otherwise "successful" case still costs.
    const clean = ratio(toolSuccess, toolTotal) * (1 - ratio(toolFailures, toolTotal * 2));
    scores.toolUse = round(Math.max(0, clean));
  }

  if (latencyCount < MIN_SAMPLES) {
    insufficient.push("latency");
  } else {
    const mean = latencySum / latencyCount;
    // 250ms → ~0.8, 2s → ~0.33, 10s → ~0.09 (1 / (1 + mean/1000)).
    scores.latency = round(1 / (1 + mean / 1000));
  }

  if (costCount < MIN_SAMPLES) {
    insufficient.push("costEfficiency");
  } else {
    const mean = costSum / costCount;
    // $0.01 → ~0.91, $0.10 → ~0.5, $1.00 → ~0.09 (1 / (1 + cost/0.1)).
    scores.costEfficiency = round(1 / (1 + mean / 0.1));
  }

  return { modelId, providerId, samples: samples.length, scores, insufficient, updatedAt: Date.now() };
}

/** A profile that has no usable score at all. */
export function isProfileEmpty(profile: ModelPerformanceProfile | undefined): boolean {
  if (!profile) return true;
  return Object.keys(profile.scores).length === 0;
}

/** Index a set of profiles by canonical model id for O(1) router lookup. */
export function indexProfiles(profiles: ModelPerformanceProfile[]): Map<string, ModelPerformanceProfile> {
  const map = new Map<string, ModelPerformanceProfile>();
  for (const profile of profiles) {
    const existing = map.get(profile.modelId);
    // Newest profile wins for a given model.
    if (!existing || profile.updatedAt >= existing.updatedAt) map.set(profile.modelId, profile);
  }
  return map;
}
