/**
 * Phase 82 §2 — Provider candidate resolution.
 *
 * Turns a model reference + constraints into an ORDERED list of provider
 * routes, plus a complete record of everything rejected and why. Resolution is
 * a sequence of guard clauses — each one removes routes and records a typed
 * rejection — and only then does scoring rank the survivors:
 *
 *   invalid → unknown model → disabled provider → excluded/denied provider
 *   → disabled model → missing capability → context → price
 *   → unavailable → score → tie-break
 *
 * Two deliberate soft relaxations, both explicit rather than silent:
 *  - a route whose metadata is UNKNOWN for a constraint is kept (unknown is not
 *    proof of violation);
 *  - if the hard filters would leave nothing, the unavailable-rejection is
 *    relaxed once and recorded in `relaxed`, so routing degrades observably
 *    instead of failing on a healthy-looking catalog.
 */

import { missingCapabilities } from "./capabilities";
import { ModelCatalog, modelCatalog } from "./catalog";
import { ProviderRegistry, providerRegistry } from "./registry";
import { parseModelRef } from "./ref";
import { routeFromModel, logicalModelKey, routeLabel, type ProviderRoute, type RouteRejection } from "./route";
import type { ProviderDefinition } from "./types";
import {
  mergeConstraints,
  resolveProviderRoutingPolicy,
  type ProviderConstraints,
  type ProviderRoutingPolicy,
} from "./providerPolicy";
import { compareRoutes, scoreRoute, type RouteScore } from "./routeScoring";
import { routePerformance, type RoutePerformanceTracker } from "./routePerformance";

export interface RouteResolutionRequest {
  /** Logical model: a bare provider-native id or a canonical reference. */
  model?: string;
  /** Pin one provider. Combined with `model` this selects a single route. */
  provider?: string;
  requiredCapabilities?: Record<string, boolean>;
  /** Provider routing policy name (`priority`, `cheapest`, `fastest`, ...). */
  policy?: string;
  /** Hard route constraints; merged over the policy's own constraints. */
  constraints?: Partial<ProviderConstraints>;
  /** Providers excluded for this request (merged into the deny list). */
  excludedProviders?: string[];
}

export interface RouteResolutionOptions {
  registry?: ProviderRegistry;
  catalog?: ModelCatalog;
  performance?: RoutePerformanceTracker;
  now?: number;
}

export interface RouteRelaxation {
  constraint: string;
  detail: string;
}

export interface RouteResolution {
  /** Ordered best-first. */
  routes: ProviderRoute[];
  /** Parallel to `routes`. */
  scores: RouteScore[];
  /** Everything that was considered and removed. */
  rejected: RouteRejection[];
  policy: ProviderRoutingPolicy;
  /** Shared provider-independent identity, when one model was requested. */
  logicalKey?: string;
  /** Constraints that had to be relaxed to keep a candidate; empty normally. */
  relaxed: RouteRelaxation[];
}

export function resolveProviderRoutes(
  request: RouteResolutionRequest = {},
  options: RouteResolutionOptions = {},
): RouteResolution {
  const registry = options.registry ?? providerRegistry;
  const catalog = options.catalog ?? modelCatalog;
  const performance = options.performance ?? routePerformance;
  const now = options.now ?? Date.now();

  // Request-level exclusions are just additional deny entries — one code path.
  const constraints = mergeConstraints(
    { allowFallback: true },
    {
      ...request.constraints,
      denyProviders: [
        ...(request.constraints?.denyProviders ?? []),
        ...(request.excludedProviders ?? []),
      ],
    },
  );

  const required = {
    ...(constraints.requiredCapabilities ?? {}),
    ...(request.requiredCapabilities ?? {}),
  };

  const policy = resolveProviderRoutingPolicy(request.policy, {
    ...constraints,
    ...(Object.keys(required).length > 0 ? { requiredCapabilities: required } : {}),
  });

  const rejected: RouteRejection[] = [];
  const relaxed: RouteRelaxation[] = [];

  // ── Guard 1: which providers are even eligible? ───────────────────────────
  const eligibleProviders = new Map<string, ProviderDefinition>();
  for (const provider of registry.list()) {
    const deny = constraints.denyProviders?.includes(provider.id);
    if (deny) {
      rejected.push({
        routeId: provider.id,
        providerId: provider.id,
        reason: "provider-denied",
        detail: "provider is on the deny list for this request",
      });
      continue;
    }
    if (constraints.allowProviders && !constraints.allowProviders.includes(provider.id)) {
      rejected.push({
        routeId: provider.id,
        providerId: provider.id,
        reason: "provider-not-allowed",
        detail: "provider is not on the allow list for this request",
      });
      continue;
    }
    if (!provider.enabled || provider.status === "disabled") {
      // An explicitly requested provider still reports its disabled state.
      rejected.push({
        routeId: provider.id,
        providerId: provider.id,
        reason: "provider-disabled",
        detail: `provider status is ${provider.status}`,
      });
      continue;
    }
    eligibleProviders.set(provider.id, provider);
  }

  // ── Guard 2: which models satisfy the reference? ──────────────────────────
  const modelFilter = resolveModelFilter(request, registry, catalog, rejected);

  // ── Guard 3: build every (provider, model) route, filtering with reasons ───
  const pool: ProviderRoute[] = [];
  const unavailable: ProviderRoute[] = [];

  for (const provider of eligibleProviders.values()) {
    if (request.provider && provider.id !== request.provider.trim().toLowerCase()) continue;

    for (const model of catalog.listByProvider(provider.id)) {
      const route = routeFromModel(model, provider, registry.healthOf(provider.id));

      if (!modelFilter.accepts(model.id, model.apiModelId)) continue;

      if (model.status === "disabled") {
        rejected.push({
          routeId: route.routeId,
          providerId: provider.id,
          modelId: model.id,
          reason: "model-disabled",
          detail: "model is marked disabled in the catalog",
        });
        continue;
      }

      const missing = missingCapabilities(model.capabilities, required);
      if (missing.length > 0) {
        rejected.push({
          routeId: route.routeId,
          providerId: provider.id,
          modelId: model.id,
          reason: "missing-capability",
          detail: `missing required capability: ${missing.join(", ")}`,
        });
        continue;
      }

      if (violatesContext(route, constraints)) {
        rejected.push({
          routeId: route.routeId,
          providerId: provider.id,
          modelId: model.id,
          reason: "context-insufficient",
          detail: `declared context ${route.contextWindow} < required ${constraints.minContextLength}`,
        });
        continue;
      }

      if (violatesPrice(route, constraints)) {
        rejected.push({
          routeId: route.routeId,
          providerId: provider.id,
          modelId: model.id,
          reason: "price-constraint",
          detail: priceDetail(route, constraints),
        });
        continue;
      }

      if (route.healthState === "unavailable") {
        unavailable.push(route);
        continue;
      }

      pool.push(route);
    }
  }

  // ── Soft relaxation: never fail on a fully-unavailable pool ───────────────
  if (pool.length === 0 && unavailable.length > 0) {
    relaxed.push({
      constraint: "provider-unavailable",
      detail: `${unavailable.length} route(s) retained although the provider is marked unavailable`,
    });
    pool.push(...unavailable);
  } else {
    for (const route of unavailable) {
      rejected.push({
        routeId: route.routeId,
        providerId: route.providerId,
        modelId: route.modelId,
        reason: "provider-unavailable",
        detail: "provider is marked unavailable after repeated failures",
      });
    }
  }

  // An explicitly requested provider that produced nothing must say why.
  if (request.provider && !eligibleProviders.has(request.provider.trim().toLowerCase()) && pool.length === 0) {
    const known = registry.get(request.provider);
    if (!known) {
      rejected.push({
        routeId: request.provider,
        providerId: request.provider,
        reason: "unknown-provider",
        detail: "no provider is registered with this id",
      });
    }
  }

  // ── Guard 4: rank survivors deterministically ─────────────────────────────
  const performanceIndex = new Map(
    performance.snapshots(now).map((snapshot) => [snapshot.routeId, snapshot] as const),
  );
  const scores = new Map<string, RouteScore>();
  for (const route of pool) {
    scores.set(route.routeId, scoreRoute({ route, policy, performance: performanceIndex.get(route.routeId) }));
  }

  pool.sort((a, b) => compareRoutes(a, b, (route) => scores.get(route.routeId)?.total ?? 0));

  return {
    routes: pool,
    scores: pool.map((route) => scores.get(route.routeId)!),
    rejected,
    policy,
    ...(modelFilter.logicalKey ? { logicalKey: modelFilter.logicalKey } : {}),
    relaxed,
  };
}

// ── Reference matching ──────────────────────────────────────────────────────

interface ModelFilter {
  accepts: (modelId: string, apiModelId: string) => boolean;
  logicalKey?: string;
}

/**
 * Exact matching only.
 *
 *  - canonical reference (`provider/apiModelId`) → that provider, that model;
 *  - bare reference → every provider serving the identical apiModelId;
 *  - no reference → every model.
 *
 * There is no prefix/fuzzy matching: `claude-3.5-sonnet` does NOT match
 * `anthropic/claude-3.5-sonnet`. §9 forbids guessing.
 */
function resolveModelFilter(
  request: RouteResolutionRequest,
  registry: ProviderRegistry,
  catalog: ModelCatalog,
  rejected: RouteRejection[],
): ModelFilter {
  if (!request.model || !request.model.trim()) return { accepts: () => true };

  const ref = parseModelRef(request.model, {
    knownProviders: registry.ids(),
    ...(request.provider ? { defaultProvider: request.provider } : {}),
  });

  if (ref.providerId) {
    // Canonical id first (exact), then provider-native id within that provider.
    const canonical = catalog.get(`${ref.providerId}/${ref.modelId}`);
    const wanted = canonical ? canonical.apiModelId : ref.modelId;
    const exists = canonical ?? catalog.listByProvider(ref.providerId).find((model) => model.apiModelId === wanted);
    if (!exists) {
      rejected.push({
        routeId: `${ref.providerId}/${ref.modelId}`,
        providerId: ref.providerId,
        modelId: `${ref.providerId}/${ref.modelId}`,
        reason: "unknown-model",
        detail: "model is not present in the catalog for this provider",
      });
      return { accepts: () => false, logicalKey: logicalModelKey(wanted) };
    }
    return {
      accepts: (modelId) => modelId === exists.id,
      logicalKey: logicalModelKey(exists.apiModelId),
    };
  }

  const wanted = logicalModelKey(ref.modelId);
  const matches = catalog.filter((model) => logicalModelKey(model.apiModelId) === wanted);
  if (matches.length === 0) {
    rejected.push({
      routeId: ref.modelId,
      providerId: request.provider ?? "(any)",
      modelId: ref.modelId,
      reason: "unknown-model",
      detail: "no catalog model matches this provider-native id exactly",
    });
    return { accepts: () => false, logicalKey: wanted };
  }

  const ids = new Set(matches.map((model) => model.id));
  return { accepts: (modelId) => ids.has(modelId), logicalKey: wanted };
}

function violatesContext(route: ProviderRoute, constraints: ProviderConstraints): boolean {
  const floor = constraints.minContextLength;
  if (floor === undefined) return false;
  if (route.contextWindow === undefined) return false; // unknown is not a violation
  return route.contextWindow < floor;
}

function violatesPrice(route: ProviderRoute, constraints: ProviderConstraints): boolean {
  const input = route.pricing?.input;
  const output = route.pricing?.output;
  if (constraints.maxInputPrice !== undefined && input !== undefined && input > constraints.maxInputPrice) return true;
  if (constraints.maxOutputPrice !== undefined && output !== undefined && output > constraints.maxOutputPrice) return true;
  return false;
}

function priceDetail(route: ProviderRoute, constraints: ProviderConstraints): string {
  const parts: string[] = [];
  if (constraints.maxInputPrice !== undefined) parts.push(`input ${route.pricing?.input} > ${constraints.maxInputPrice}`);
  if (constraints.maxOutputPrice !== undefined) parts.push(`output ${route.pricing?.output} > ${constraints.maxOutputPrice}`);
  return parts.join("; ");
}

/** Convenience for diagnostics: labels of the ordered routes. */
export function routeLabels(routes: ProviderRoute[]): string[] {
  return routes.map(routeLabel);
}
