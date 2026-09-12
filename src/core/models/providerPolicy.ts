/**
 * Phase 82 §3 — Canonical ProviderRoutingPolicy.
 *
 * This is the *route* policy layer: it decides WHICH provider/upstream serves a
 * model. It is deliberately separate from the Phase 79/80 model-selection policy
 * (`RoutingPolicy` / `RoutingProfile`), which decides WHICH model to use:
 *
 *   ModelRouter
 *     ├─ model selection          → RoutingProfile        (Phase 80)
 *     └─ provider/upstream choice → ProviderRoutingPolicy (Phase 82)
 *
 * No policy here names a concrete vendor. `priority` reads the provider's
 * declared priority, `cheapest` reads declared pricing, `fastest` reads observed
 * latency, `reliability-first` reads observed outcomes. Unknown data is neutral
 * and is never treated as "free" or "fast".
 */

export type ProviderRoutingPolicyName =
  | "priority"
  | "cheapest"
  | "fastest"
  | "balanced"
  | "reliability-first";

export const PROVIDER_ROUTING_POLICIES: ProviderRoutingPolicyName[] = [
  "priority",
  "cheapest",
  "fastest",
  "balanced",
  "reliability-first",
];

export interface ProviderRoutingWeights {
  /** Lower declared provider priority wins. */
  priority: number;
  /** Lower declared price wins. */
  cost: number;
  /** Lower observed latency wins. */
  latency: number;
  /** Better observed reliability wins. */
  reliability: number;
}

/**
 * Hard constraints applied BEFORE scoring. Every one is a guard clause: a route
 * that violates a constraint is removed and its rejection is recorded, never
 * silently ranked last.
 */
export interface ProviderConstraints {
  /** Only these provider ids may serve the request. */
  allowProviders?: string[];
  /** These provider ids may never serve the request (wins over allow). */
  denyProviders?: string[];
  /** Maximum declared input price, USD per 1M tokens. */
  maxInputPrice?: number;
  /** Maximum declared output price, USD per 1M tokens. */
  maxOutputPrice?: number;
  /** Minimum declared context window (unknown context is NOT filtered out). */
  minContextLength?: number;
  /** Capabilities the model must declare `true`. */
  requiredCapabilities?: Record<string, boolean>;
  /**
   * Whether a retryable failure may fall through to the next route. `false`
   * pins the decision to a single route.
   */
  allowFallback: boolean;
}

export interface ProviderRoutingPolicy {
  name: ProviderRoutingPolicyName;
  weights: ProviderRoutingWeights;
  constraints: ProviderConstraints;
}

const ZERO: ProviderRoutingWeights = { priority: 0, cost: 0, latency: 0, reliability: 0 };

/** Default constraints: no restriction, fallback allowed. */
export const DEFAULT_PROVIDER_CONSTRAINTS: ProviderConstraints = {
  allowFallback: true,
};

export const PROVIDER_ROUTING_POLICY_DEFINITIONS: Record<ProviderRoutingPolicyName, ProviderRoutingPolicy> = {
  priority: {
    name: "priority",
    weights: { ...ZERO, priority: 1 },
    constraints: { ...DEFAULT_PROVIDER_CONSTRAINTS },
  },
  cheapest: {
    name: "cheapest",
    weights: { ...ZERO, cost: 1 },
    constraints: { ...DEFAULT_PROVIDER_CONSTRAINTS },
  },
  fastest: {
    name: "fastest",
    weights: { ...ZERO, latency: 1 },
    constraints: { ...DEFAULT_PROVIDER_CONSTRAINTS },
  },
  balanced: {
    name: "balanced",
    weights: { priority: 1, cost: 1, latency: 1, reliability: 1 },
    constraints: { ...DEFAULT_PROVIDER_CONSTRAINTS },
  },
  "reliability-first": {
    name: "reliability-first",
    weights: { ...ZERO, reliability: 3, latency: 1 },
    constraints: { ...DEFAULT_PROVIDER_CONSTRAINTS },
  },
};

export const DEFAULT_PROVIDER_ROUTING_POLICY: ProviderRoutingPolicyName = "priority";

export function isProviderRoutingPolicyName(value: string): value is ProviderRoutingPolicyName {
  return (PROVIDER_ROUTING_POLICIES as string[]).includes(value.trim().toLowerCase());
}

/** Resolve a policy by name; unknown input resolves to the default. */
export function resolveProviderRoutingPolicy(
  name?: string,
  constraints?: Partial<ProviderConstraints>,
): ProviderRoutingPolicy {
  const key = typeof name === "string" ? name.trim().toLowerCase() : "";
  const base =
    PROVIDER_ROUTING_POLICY_DEFINITIONS[
      isProviderRoutingPolicyName(key) ? (key as ProviderRoutingPolicyName) : DEFAULT_PROVIDER_ROUTING_POLICY
    ];
  return {
    name: base.name,
    weights: { ...base.weights },
    constraints: mergeConstraints(base.constraints, constraints),
  };
}

export function mergeConstraints(
  base: ProviderConstraints,
  patch?: Partial<ProviderConstraints>,
): ProviderConstraints {
  if (!patch) return { ...base };
  const merged: ProviderConstraints = { ...base };

  if (patch.allowProviders !== undefined) {
    const list = normalizeIdList(patch.allowProviders);
    if (list.length > 0) merged.allowProviders = list;
    else delete merged.allowProviders;
  }
  if (patch.denyProviders !== undefined) {
    const list = normalizeIdList(patch.denyProviders);
    if (list.length > 0) merged.denyProviders = list;
    else delete merged.denyProviders;
  }
  if (isPositiveNumber(patch.maxInputPrice)) merged.maxInputPrice = patch.maxInputPrice;
  if (isPositiveNumber(patch.maxOutputPrice)) merged.maxOutputPrice = patch.maxOutputPrice;
  if (isPositiveNumber(patch.minContextLength)) merged.minContextLength = Math.floor(patch.minContextLength);
  if (patch.requiredCapabilities !== undefined) {
    merged.requiredCapabilities = Object.fromEntries(
      Object.entries(patch.requiredCapabilities).filter(([, value]) => value === true),
    );
  }
  if (typeof patch.allowFallback === "boolean") merged.allowFallback = patch.allowFallback;

  return merged;
}

/** Validate a policy name coming from config/CLI. Unknown names are rejected. */
export function validateProviderRoutingPolicy(
  name: string,
): { ok: true; name: ProviderRoutingPolicyName } | { ok: false; error: string } {
  const key = name.trim().toLowerCase();
  if (!isProviderRoutingPolicyName(key)) {
    return {
      ok: false,
      error: `Unknown provider routing policy '${name}'. Known: ${PROVIDER_ROUTING_POLICIES.join(", ")}.`,
    };
  }
  return { ok: true, name: key as ProviderRoutingPolicyName };
}

/** One-line summary for the CLI/docs table. */
export function describeProviderRoutingPolicy(policy: ProviderRoutingPolicy): string {
  const parts = Object.entries(policy.weights)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `${key}=${value}`);
  const constraints: string[] = [];
  if (policy.constraints.allowProviders?.length) constraints.push(`allow=${policy.constraints.allowProviders.join(",")}`);
  if (policy.constraints.denyProviders?.length) constraints.push(`deny=${policy.constraints.denyProviders.join(",")}`);
  if (policy.constraints.maxInputPrice !== undefined) constraints.push(`maxInput=${policy.constraints.maxInputPrice}`);
  if (policy.constraints.maxOutputPrice !== undefined) constraints.push(`maxOutput=${policy.constraints.maxOutputPrice}`);
  if (policy.constraints.minContextLength !== undefined) constraints.push(`minContext=${policy.constraints.minContextLength}`);
  if (!policy.constraints.allowFallback) constraints.push("no-fallback");
  return `${policy.name}: ${parts.join(" ") || "(no weights)"}${constraints.length ? ` [${constraints.join(" ")}]` : ""}`;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeIdList(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}
