/**
 * Phase 82 §12 — Read-only routing projection.
 *
 * One place that turns a `RoutingDecision` into display rows, so the CLI and the
 * TUI cannot drift apart and neither of them re-implements routing. It reads the
 * router's decision only: it never constructs a provider, never performs I/O,
 * never mutates health and never writes config.
 *
 * Secrets are excluded by construction: a row carries ids, numbers and booleans.
 * Auth env var NAMES are never included here (they belong to diagnostics, and
 * only ever as names).
 */

import { modelRouter, type RoutingDecision } from "./router";
import { providerRegistry } from "./registry";
import { routeLabel, type ProviderRoute, type RouteRejection } from "./route";
import type { ProviderConstraints } from "./providerPolicy";
import type { RoutingRequest } from "./types";
import type { RoutePerformanceSnapshot } from "./routePerformance";

export interface RoutingRouteRow {
  routeId: string;
  providerId: string;
  upstreamId?: string;
  /** Canonical catalog id of the logical model. */
  modelId: string;
  apiModelId: string;
  label: string;
  kind: ProviderRoute["kind"];
  /** Provider connection status vocabulary, from the registry. */
  status: string;
  health: ProviderRoute["healthState"];
  priority: number;
  /** True for the route that would be used first. */
  selected: boolean;
  /** Zero-based position in the bounded fallback chain, when included. */
  fallbackIndex?: number;
  score?: number;
  scoreWeight?: number;
  priceLabel: string;
  contextWindow?: number;
  /** Observed rolling latency, only when samples were sufficient. */
  latencyMs?: number;
  /** Observed success rate, only when samples were sufficient. */
  successRate?: number;
  /** True when the route's metrics were too old to trust. */
  metricsStale: boolean;
  /** True when the route is retained despite being marked unavailable. */
  degraded: boolean;
}

export interface RoutingView {
  request: RoutingRequest;
  profile: string;
  modelPolicy: string;
  providerPolicy: string;
  logicalKey?: string;
  selectedRouteId?: string;
  /** Ordered the way fallback would walk them. */
  rows: RoutingRouteRow[];
  rejected: RouteRejection[];
  relaxed: { constraint: string; detail: string }[];
  reasons: string[];
  fallbackChain: string[];
}

export interface RoutingViewInput {
  model?: string;
  provider?: string;
  /** Provider routing policy override (`priority`, `cheapest`, ...). */
  policy?: string;
  constraints?: Partial<ProviderConstraints>;
  requiredCapabilities?: Record<string, boolean>;
  /** Pre-computed decision (tests/diagnostics). Otherwise the router is asked. */
  decision?: RoutingDecision;
  /** Performance snapshots by route id, for latency/success columns. */
  metrics?: Map<string, RoutePerformanceSnapshot>;
}

export function buildRoutingView(input: RoutingViewInput = {}): RoutingView {
  const decision =
    input.decision ??
    modelRouter.explain({
      ...(input.model ? { model: input.model } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.requiredCapabilities ? { requiredCapabilities: input.requiredCapabilities } : {}),
      ...(input.constraints ? { providerConstraints: input.constraints } : {}),
      // `explicit` keeps an explicitly named model pinned while the provider
      // policy still orders the routes that serve it.
      ...(input.model ? { policy: "explicit" as const } : {}),
    });

  const scoreByRoute = new Map(decision.scores.map((score) => [score.routeId, score]));
  const fallbackIndex = new Map(decision.fallbackChain.map((route, index) => [route.routeId, index]));

  const toRow = (route: ProviderRoute): RoutingRouteRow => {
    const score = scoreByRoute.get(route.routeId);
    const metrics = input.metrics?.get(route.routeId);
    return {
      routeId: route.routeId,
      providerId: route.providerId,
      ...(route.upstreamId ? { upstreamId: route.upstreamId } : {}),
      modelId: route.modelId,
      apiModelId: route.apiModelId,
      label: routeLabel(route),
      kind: route.kind,
      // Connection status comes from the registry (single owner); the health
      // snapshot above is what routing actually ranked on.
      status: providerStatusOf(route.providerId),
      health: route.healthState,
      priority: route.priority,
      selected: decision.selectedRoute?.routeId === route.routeId,
      ...(fallbackIndex.has(route.routeId) ? { fallbackIndex: fallbackIndex.get(route.routeId) } : {}),
      ...(score ? { score: score.total } : {}),
      ...(score?.components[0] ? { scoreWeight: score.components[0].weight } : {}),
      priceLabel: priceLabelOf(route),
      ...(route.contextWindow !== undefined ? { contextWindow: route.contextWindow } : {}),
      ...(metrics?.latencyMs !== undefined ? { latencyMs: metrics.latencyMs } : {}),
      ...(metrics?.successRate !== undefined ? { successRate: metrics.successRate } : {}),
      metricsStale: metrics?.stale === true,
      degraded: route.healthState === "unavailable",
    };
  };

  const rows = decision.candidateRoutes.map(toRow);

  return {
    request: decision.request,
    profile: decision.profile,
    modelPolicy: decision.modelPolicy,
    providerPolicy: decision.providerPolicy.name,
    ...(decision.logicalKey ? { logicalKey: decision.logicalKey } : {}),
    ...(decision.selectedRoute ? { selectedRouteId: decision.selectedRoute.routeId } : {}),
    rows,
    rejected: decision.rejected,
    relaxed: decision.relaxed,
    reasons: decision.reasons,
    fallbackChain: decision.fallbackChain.map(routeLabel),
  };
}

function providerStatusOf(providerId: string): string {
  try {
    return providerRegistry.get(providerId)?.status ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** `—` when the provider declared no price; never rendered as free. */
function priceLabelOf(route: ProviderRoute): string {
  const input = route.pricing?.input;
  const output = route.pricing?.output;
  if (input === undefined && output === undefined) return "—";
  return `${input ?? "?"}/${output ?? "?"}`;
}

/** Compact multi-line rendering shared by the CLI and the TUI panel. */
export function renderRoutingView(view: RoutingView): string[] {
  const lines: string[] = [];
  lines.push(`Model selection:    profile=${view.profile} policy=${view.modelPolicy}`);
  lines.push(`Provider routing:   policy=${view.providerPolicy}`);
  if (view.logicalKey) lines.push(`Logical model:      ${view.logicalKey}`);
  lines.push(
    `Selected route:     ${view.selectedRouteId ?? "(none)"}`,
  );
  lines.push("");
  if (view.rows.length === 0) {
    lines.push("No candidate route.");
  } else {
    lines.push("PROVIDER   UPSTREAM   MODEL                       HEALTH      PRIORITY  SCORE  PRICE        CONTEXT");
    for (const row of view.rows) {
      lines.push(
        [
          row.providerId.padEnd(10),
          (row.upstreamId ?? "default").padEnd(10),
          row.apiModelId.slice(0, 27).padEnd(27),
          row.health.padEnd(11),
          String(row.priority).padEnd(9),
          (row.score === undefined ? "—" : row.score.toFixed(3)).padEnd(6),
          row.priceLabel.padEnd(12),
          row.contextWindow === undefined ? "—" : String(row.contextWindow),
        ].join(" "),
      );
    }
  }

  if (view.fallbackChain.length > 0) {
    lines.push("");
    lines.push(`Fallback chain:     ${view.fallbackChain.join(" → ")}`);
  }
  if (view.rejected.length > 0) {
    lines.push("");
    lines.push("Rejected:");
    for (const entry of view.rejected) {
      lines.push(`  ${entry.modelId ?? entry.routeId}: ${entry.reason} — ${entry.detail}`);
    }
  }
  if (view.relaxed.length > 0) {
    lines.push("");
    lines.push("Relaxed constraints:");
    for (const entry of view.relaxed) lines.push(`  ${entry.constraint}: ${entry.detail}`);
  }
  return lines;
}
