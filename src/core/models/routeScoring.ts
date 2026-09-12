/**
 * Phase 82 §6 — Canonical route scorer.
 *
 * One scorer, no randomness, deterministic ordering:
 *
 *   1. policy score                 (the policy's weighted components —
 *                                   `cheapest` really is cheapest, `fastest`
 *                                   really is fastest; priority is itself a
 *                                   weighted component, not a trump card)
 *   2. provider health rank
 *   3. declared provider priority   (tie-break within equal score/health)
 *   4. provider id, then upstream, then model id (lexical — total order)
 *
 * Unknown inputs are NEUTRAL, never best and never worst: a route whose price
 * was never declared must not lose to one with a published bad price, and a
 * route with no latency samples must not be treated as fast.
 */

import { NEUTRAL } from "./scoring";
import { healthRank } from "./health";
import type { ProviderRoute } from "./route";
import type { ProviderRoutingPolicy, ProviderRoutingPolicyName } from "./providerPolicy";
import type { RoutePerformanceSnapshot } from "./routePerformance";

/** Blended price (USD/1M tokens) scoring 0.5 on the cost component. */
export const ROUTE_COST_REFERENCE_USD = 10;
/** Latency (ms) scoring 0.5 on the latency component. */
export const ROUTE_LATENCY_REFERENCE_MS = 1000;
/** Declared provider priority scoring 0.5 on the priority component. */
export const ROUTE_PRIORITY_REFERENCE = 100;

export type RouteScoreComponentKey = keyof ProviderRoutingPolicy["weights"];

export interface RouteScoreComponent {
  key: RouteScoreComponentKey;
  /** Normalized 0..1 — higher is better for every component. */
  value: number;
  weight: number;
  /** True when the component fell back to NEUTRAL for missing input. */
  neutral: boolean;
  note?: string;
}

export interface RouteScore {
  routeId: string;
  policy: ProviderRoutingPolicyName;
  /** Weighted mean over positive-weight components, 0..1. */
  total: number;
  components: RouteScoreComponent[];
  /** Human-readable decision evidence, already secret-free. */
  reasons: string[];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return NEUTRAL;
  return Math.max(0, Math.min(1, value));
}

/** Lower declared priority → higher score. Unknown priority is neutral. */
function priorityComponent(route: ProviderRoute): { value: number; neutral: boolean; note?: string } {
  const priority = route.priority;
  if (typeof priority !== "number" || !Number.isFinite(priority) || priority <= 0) {
    return { value: NEUTRAL, neutral: true, note: `priority undeclared for ${route.providerId}` };
  }
  return { value: clamp01(1 / (1 + priority / ROUTE_PRIORITY_REFERENCE)), neutral: false };
}

/** Lower declared price → higher score. Unknown price is neutral. */
function costComponent(route: ProviderRoute): { value: number; neutral: boolean; note?: string } {
  const input = route.pricing?.input;
  const output = route.pricing?.output;
  if (input === undefined && output === undefined) {
    return { value: NEUTRAL, neutral: true, note: `pricing undeclared for ${route.routeId}` };
  }
  const price = (input ?? 0) + (output ?? 0);
  return { value: clamp01(1 / (1 + price / ROUTE_COST_REFERENCE_USD)), neutral: false };
}

/** Lower observed latency → higher score. Insufficient samples are neutral. */
function latencyComponent(performance: RoutePerformanceSnapshot | undefined): {
  value: number;
  neutral: boolean;
  note?: string;
} {
  const latency = performance?.sufficient ? performance.latencyMs : undefined;
  if (latency === undefined) {
    return { value: NEUTRAL, neutral: true, note: "insufficient latency samples" };
  }
  return { value: clamp01(1 / (1 + latency / ROUTE_LATENCY_REFERENCE_MS)), neutral: false };
}

/**
 * Observed reliability. Falls back to the provider's health state when there is
 * not yet enough route-level evidence, so a brand-new route is not punished for
 * having no history while a known-degraded provider still sorts behind.
 */
function reliabilityComponent(
  route: ProviderRoute,
  performance: RoutePerformanceSnapshot | undefined,
): { value: number; neutral: boolean; note?: string } {
  // `successRate` is only populated for fresh records with enough observations;
  // stale or under-sampled records deliberately fall through to health.
  const rate = performance?.successRate;
  if (typeof rate === "number" && Number.isFinite(rate)) {
    return { value: clamp01(rate), neutral: false, note: "observed route outcomes" };
  }
  switch (route.healthState) {
    case "healthy":
      return { value: 1, neutral: false, note: "health: healthy" };
    case "degraded":
      return { value: 0.25, neutral: false, note: "health: degraded" };
    case "unavailable":
      return { value: 0, neutral: false, note: "health: unavailable" };
    case "unknown":
    default:
      return { value: NEUTRAL, neutral: true, note: "no observed outcomes" };
  }
}

export interface RouteScoreInput {
  route: ProviderRoute;
  policy: ProviderRoutingPolicy;
  performance?: RoutePerformanceSnapshot;
}

/** Deterministic: identical inputs always produce an identical score. */
export function scoreRoute(input: RouteScoreInput): RouteScore {
  const { route, policy, performance } = input;
  const reasons: string[] = [];
  const components: RouteScoreComponent[] = [];

  const raw: Array<{ key: RouteScoreComponentKey; value: number; neutral: boolean; note?: string }> = [
    { key: "priority", ...priorityComponent(route) },
    { key: "cost", ...costComponent(route) },
    { key: "latency", ...latencyComponent(performance) },
    { key: "reliability", ...reliabilityComponent(route, performance) },
  ];

  let weightSum = 0;
  let weightedSum = 0;
  for (const entry of raw) {
    const weight = policy.weights[entry.key] ?? 0;
    if (weight <= 0) continue;
    const value = clamp01(entry.value);
    weightedSum += value * weight;
    weightSum += weight;
    components.push({
      key: entry.key,
      value: round3(value),
      weight,
      neutral: entry.neutral,
      ...(entry.note ? { note: entry.note } : {}),
    });
    reasons.push(
      `${entry.key}=${round3(value)}${entry.neutral ? " (neutral)" : ""}${entry.note ? ` — ${entry.note}` : ""}`,
    );
  }

  const total = weightSum > 0 ? clamp01(round3(weightedSum / weightSum)) : 0;
  if (weightSum === 0) reasons.push(`policy '${policy.name}' declares no positive weights; score is 0`);

  return { routeId: route.routeId, policy: policy.name, total, components, reasons };
}

/**
 * Deterministic total ordering.
 * Returns <0 when `a` should be tried before `b`.
 *
 * The POLICY SCORE is the primary key — §3/§6: `cheapest` must actually pick
 * the cheapest route and `fastest` the fastest, regardless of declared
 * provider priority. Priority and health are tie-breakers (a policy with no
 * distinguishing evidence, e.g. all-unknown pricing, still degrades to the
 * declared preference order rather than an arbitrary one).
 */
export function compareRoutes(
  a: ProviderRoute,
  b: ProviderRoute,
  scoreOf: (route: ProviderRoute) => number,
): number {
  const scoreDelta = scoreOf(b) - scoreOf(a);
  if (scoreDelta !== 0) return scoreDelta;

  const healthDelta = healthRank(a.healthState) - healthRank(b.healthState);
  if (healthDelta !== 0) return healthDelta;

  if (a.priority !== b.priority) return a.priority - b.priority;

  if (a.providerId !== b.providerId) return a.providerId.localeCompare(b.providerId);
  if ((a.upstreamId ?? "") !== (b.upstreamId ?? "")) return (a.upstreamId ?? "").localeCompare(b.upstreamId ?? "");
  return a.apiModelId.localeCompare(b.apiModelId);
}

/** Human-readable tie-break explanation, used by `explain`. */
export function tieBreakReasons(a: ProviderRoute, b: ProviderRoute): string[] {
  const reasons: string[] = [];
  if (healthRank(a.healthState) !== healthRank(b.healthState)) {
    reasons.push(`health ${a.healthState} beats ${b.healthState}`);
  }
  if (a.priority !== b.priority) reasons.push(`declared priority ${a.priority} < ${b.priority}`);
  return reasons;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
