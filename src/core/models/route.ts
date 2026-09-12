/**
 * Phase 82 §1 — Canonical ProviderRoute.
 *
 * The distinction this module exists to preserve:
 *
 *   LOGICAL MODEL          anthropic/claude-3.5-sonnet
 *     ├─ ROUTE openrouter :: default
 *     ├─ ROUTE openrouter :: together
 *     └─ ROUTE toolnet    :: default
 *
 * A *model* is what the caller asks for; a *route* is one concrete way to serve
 * it (provider + optional upstream). The catalog stores each model once per
 * provider — Phase 82 does NOT duplicate a model entry per upstream. Routes are
 * a derived, read-only projection over `ModelCatalog` + `ProviderRegistry`.
 *
 * Unknown stays unknown: when a provider does not publish upstream identity
 * (OpenRouter only exposes `top_provider` on the listing endpoint), the route is
 * `providerId::default::apiModelId` rather than a guessed upstream.
 */

import type {
  HealthState,
  ModelCapabilities,
  ModelDefinition,
  ModelPricing,
  ProviderDefinition,
  ProviderHealth,
} from "./types";

/** Default upstream marker — "the provider serves this model itself". */
export const DEFAULT_UPSTREAM = "default";

export function routeIdOf(providerId: string, apiModelId: string, upstreamId?: string): string {
  return `${providerId.toLowerCase()}::${(upstreamId ?? DEFAULT_UPSTREAM).toLowerCase()}::${apiModelId}`;
}

/**
 * Provider-independent identity of a model.
 *
 * Exact, never fuzzy: two routes serve the same logical model only when their
 * provider-native model ids match exactly after trimming/case-folding. There is
 * deliberately no prefix/fuzzy matching — Phase 82 forbids mapping
 * `claude-3.5-sonnet` onto `anthropic/claude-3.5-sonnet` by guesswork.
 */
export function logicalModelKey(apiModelId: string): string {
  return apiModelId.trim().toLowerCase();
}

export interface ProviderRoute {
  /** Stable route identity: `provider::upstream::apiModelId`. */
  routeId: string;
  providerId: string;
  /** Upstream within the provider, when the provider actually declares one. */
  upstreamId?: string;
  /** Canonical catalog id of the logical model (`${providerId}/${apiModelId}`). */
  modelId: string;
  /** Provider-native model id — exactly what the provider API expects. */
  apiModelId: string;
  /** Provider-independent identity, shared across providers serving the model. */
  logicalKey: string;
  displayName?: string;
  capabilities: ModelCapabilities;
  pricing?: ModelPricing;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Provider-declared priority (lower = preferred). */
  priority: number;
  /** Snapshot of provider health at route-resolution time. */
  healthState: HealthState;
  health: ProviderHealth;
  /** Provider kind, for diagnostics only — never a ranking input. */
  kind: ProviderDefinition["kind"];
}

export type RouteRejectionReason =
  | "unknown-model"
  | "unknown-provider"
  | "provider-disabled"
  | "provider-excluded"
  | "provider-not-allowed"
  | "provider-denied"
  | "model-disabled"
  | "missing-capability"
  | "context-insufficient"
  | "price-constraint"
  | "provider-unavailable";

export interface RouteRejection {
  /** Route id when a model was considered; provider id for provider-level skips. */
  routeId: string;
  providerId: string;
  modelId?: string;
  reason: RouteRejectionReason;
  /** Human-readable, secret-free explanation. */
  detail: string;
}

/** Read upstream identity strictly from declared metadata. Never inferred. */
export function declaredUpstream(model: ModelDefinition, provider: ProviderDefinition): string | undefined {
  const meta = (model.metadata ?? {}) as Record<string, unknown>;
  const providerMeta = (provider.metadata ?? {}) as Record<string, unknown>;
  const candidates = [meta.upstream, meta.upstreamId, meta.upstream_id, providerMeta.upstream, providerMeta.upstreamId];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }
  return undefined;
}

/** Project one catalog model served by one provider into a route. */
export function routeFromModel(
  model: ModelDefinition,
  provider: ProviderDefinition,
  health: ProviderHealth,
): ProviderRoute {
  const upstreamId = declaredUpstream(model, provider);
  return {
    routeId: routeIdOf(provider.id, model.apiModelId, upstreamId),
    providerId: provider.id,
    ...(upstreamId ? { upstreamId } : {}),
    modelId: model.id,
    apiModelId: model.apiModelId,
    logicalKey: logicalModelKey(model.apiModelId),
    ...(model.displayName ? { displayName: model.displayName } : {}),
    capabilities: model.capabilities,
    ...(model.pricing ? { pricing: model.pricing } : {}),
    ...(model.contextWindow !== undefined
      ? { contextWindow: model.contextWindow }
      : model.limits?.contextWindow !== undefined
        ? { contextWindow: model.limits.contextWindow }
        : {}),
    ...(model.maxOutputTokens !== undefined
      ? { maxOutputTokens: model.maxOutputTokens }
      : model.limits?.maxOutputTokens !== undefined
        ? { maxOutputTokens: model.limits.maxOutputTokens }
        : {}),
    priority: provider.priority,
    healthState: health.state,
    health,
    kind: provider.kind,
  };
}

/** Compact, secret-free label used by CLI/TUI/decision evidence. */
export function routeLabel(route: ProviderRoute): string {
  return route.upstreamId ? `${route.providerId}:${route.upstreamId}/${route.apiModelId}` : route.modelId;
}

export function sameRoute(a: ProviderRoute, b: ProviderRoute): boolean {
  return a.routeId === b.routeId;
}
