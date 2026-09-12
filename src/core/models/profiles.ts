/**
 * Phase 80 §3 — Canonical routing profiles.
 *
 * A profile is a NAMED weighting over the deterministic ModelScorer. It never
 * names a concrete model: "coding" means "weight capability and eval evidence
 * for coding", NOT "use Claude". That distinction is what keeps routing
 * data-driven instead of hard-coded to a leaderboard.
 *
 * `ranking` decides how a profile orders candidates:
 *   "policy" — reuse the Phase 79 policy comparator (priority/cheapest/fastest).
 *              `auto` and `balanced` stay here so existing installs keep the
 *              exact ordering they had before this phase.
 *   "score"  — sort by ModelScorer total, with the same deterministic
 *              tie-breakers (health → priority → id).
 */

import type { CapabilityRequirement, RoutingPolicy } from "./types";
import type { EvalDimension } from "./performance";

export type RoutingProfileName =
  | "auto"
  | "quality"
  | "balanced"
  | "fast"
  | "cheap"
  | "coding"
  | "reasoning"
  | "tool-heavy"
  | "long-context";

export const ROUTING_PROFILE_NAMES: RoutingProfileName[] = [
  "auto",
  "quality",
  "balanced",
  "fast",
  "cheap",
  "coding",
  "reasoning",
  "tool-heavy",
  "long-context",
];

export interface ScoreWeights {
  /** Satisfying the profile's preferred capabilities. */
  capability: number;
  /** Satisfying caller-supplied `preferredCapabilities`. */
  preference: number;
  /** Eval evidence for the profile's dimensions (0 when insufficient data). */
  eval: number;
  /** Observed provider health. */
  health: number;
  /** Observed rolling latency. */
  latency: number;
  /** Declared pricing (lower is better). */
  cost: number;
  /** Declared context window against the target. */
  context: number;
}

export interface RoutingProfileDefinition {
  id: RoutingProfileName;
  label: string;
  description: string;
  ranking: "policy" | "score";
  policy: RoutingPolicy;
  weights: ScoreWeights;
  requiredCapabilities?: CapabilityRequirement;
  preferredCapabilities?: CapabilityRequirement;
  /** Models whose declared context window is below this are filtered out. */
  minContextWindow?: number;
  /** Profile dimensions consulted for eval evidence, in priority order. */
  evalDimensions: EvalDimension[];
}

const NEUTRAL_WEIGHTS: ScoreWeights = {
  capability: 0,
  preference: 0,
  eval: 0,
  health: 0,
  latency: 0,
  cost: 0,
  context: 0,
};

/**
 * The default profile is `auto`, which ranks exactly like Phase 79's `priority`
 * policy. Nothing about an existing install changes unless a profile is chosen.
 */
export const ROUTING_PROFILES: Record<RoutingProfileName, RoutingProfileDefinition> = {
  auto: {
    id: "auto",
    label: "Auto",
    description: "Phase 79 priority ordering; capability requirements still filter.",
    ranking: "policy",
    policy: "priority",
    weights: { ...NEUTRAL_WEIGHTS, capability: 1, health: 1 },
    evalDimensions: ["reliability"],
  },
  quality: {
    id: "quality",
    label: "Quality",
    description: "Prefer proven capability and eval evidence over price/latency.",
    ranking: "score",
    policy: "capability-first",
    weights: {
      capability: 2,
      preference: 2,
      eval: 3,
      health: 1.5,
      latency: 0.5,
      cost: 0.25,
      context: 1,
    },
    preferredCapabilities: { reasoning: true, nativeToolCalls: true },
    evalDimensions: ["reliability", "coding", "reasoning", "toolUse"],
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    description: "Capability, health and cost weighted evenly (Phase 79 ordering).",
    ranking: "policy",
    policy: "priority",
    weights: { capability: 1, preference: 1, eval: 1, health: 1, latency: 1, cost: 1, context: 1 },
    evalDimensions: ["reliability"],
  },
  fast: {
    id: "fast",
    label: "Fast",
    description: "Lowest observed latency; unscored when there are too few samples.",
    ranking: "policy",
    policy: "fastest",
    weights: { ...NEUTRAL_WEIGHTS, latency: 3, health: 2 },
    evalDimensions: ["latency"],
  },
  cheap: {
    id: "cheap",
    label: "Cheap",
    description: "Lowest declared blended price; unknown price never counts as free.",
    ranking: "policy",
    policy: "cheapest",
    weights: { ...NEUTRAL_WEIGHTS, cost: 3 },
    evalDimensions: ["costEfficiency"],
  },
  coding: {
    id: "coding",
    label: "Coding",
    description: "Tool-using code edits and debugging.",
    ranking: "score",
    policy: "capability-first",
    weights: {
      capability: 3,
      preference: 2,
      eval: 3,
      health: 1,
      latency: 0.5,
      cost: 0.5,
      context: 1.5,
    },
    requiredCapabilities: { tools: true },
    preferredCapabilities: { nativeToolCalls: true, reasoning: true },
    minContextWindow: 32_000,
    evalDimensions: ["coding", "toolUse", "reliability"],
  },
  reasoning: {
    id: "reasoning",
    label: "Reasoning",
    description: "Explicit reasoning models for analysis and planning.",
    ranking: "score",
    policy: "capability-first",
    weights: {
      capability: 2,
      preference: 1,
      eval: 3,
      health: 1,
      latency: 0.5,
      cost: 0.5,
      context: 2,
    },
    requiredCapabilities: { reasoning: true },
    evalDimensions: ["reasoning", "reliability"],
  },
  "tool-heavy": {
    id: "tool-heavy",
    label: "Tool heavy",
    description: "Many tool calls; tool-use reliability dominates.",
    ranking: "score",
    policy: "capability-first",
    weights: {
      capability: 3,
      preference: 2,
      eval: 3,
      health: 1.5,
      latency: 0.5,
      cost: 0.5,
      context: 1,
    },
    requiredCapabilities: { tools: true },
    preferredCapabilities: { nativeToolCalls: true },
    evalDimensions: ["toolUse", "reliability"],
  },
  "long-context": {
    id: "long-context",
    label: "Long context",
    description: "Large context windows for whole-repo / long-document work.",
    ranking: "score",
    policy: "capability-first",
    weights: {
      capability: 1,
      preference: 1,
      eval: 1,
      health: 1,
      latency: 0.5,
      cost: 0.5,
      context: 4,
    },
    minContextWindow: 128_000,
    evalDimensions: ["reliability", "reasoning"],
  },
};

export const DEFAULT_ROUTING_PROFILE: RoutingProfileName = "auto";

/** Resolve a profile by name, falling back to `auto` for unknown input. */
export function resolveRoutingProfile(name?: string): RoutingProfileDefinition {
  if (!name) return ROUTING_PROFILES[DEFAULT_ROUTING_PROFILE];
  const key = name.trim().toLowerCase() as RoutingProfileName;
  return ROUTING_PROFILES[key] ?? ROUTING_PROFILES[DEFAULT_ROUTING_PROFILE];
}

export function isRoutingProfileName(value: string): value is RoutingProfileName {
  return (ROUTING_PROFILE_NAMES as string[]).includes(value.trim().toLowerCase());
}

/** One-line summary used by `toolnet routing show` and the docs table. */
export function describeProfile(profile: RoutingProfileDefinition): string {
  const weights = Object.entries(profile.weights)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return `${profile.id}: ranking=${profile.ranking} policy=${profile.policy} ${weights}`;
}
