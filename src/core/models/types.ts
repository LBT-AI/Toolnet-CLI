/**
 * Phase 79 — Canonical Provider / Model / Routing contracts.
 *
 * One schema for every cross-cutting type in the model layer. The AgentHarness,
 * the ModelAdapter, the CLI and the TUI all speak these shapes; provider
 * dialects (OpenRouter, ToolNet gateway, OpenAI-compatible) exist only inside
 * discovery/adaptation code.
 *
 * Capability tri-state is deliberate and load-bearing: `true` = the provider
 * says yes, `false` = the provider says no, `undefined` = UNKNOWN. Never guess
 * `undefined` into `true` — a model falsely asserted to support native tool
 * calls will narrate fake success instead of emitting real tool calls.
 */

// ── Provider identity ───────────────────────────────────────────────────────

export type ProviderKind =
  | "openrouter"
  | "toolnet"
  | "openai-compatible"
  | "anthropic"
  | "gemini"
  | "custom";

/** Connection/lifecycle status. Mirrors the MCP status vocabulary so the
 *  diagnostics surfaces stay consistent across extensions and providers. */
export type ProviderStatus =
  | "connected"
  | "connecting"
  | "disabled"
  | "failed"
  | "unavailable"
  | "unknown";

/** Coarse health used by routing policy. Derived from request outcomes only —
 *  never from a model-id guess. */
export type HealthState = "healthy" | "degraded" | "unavailable" | "unknown";

// ── Capabilities ────────────────────────────────────────────────────────────

/**
 * The single normalized capability schema.
 *
 * Every field is tri-state (`boolean | undefined`) so "the provider did not
 * tell us" stays distinguishable from "the provider said no".
 */
export interface ModelCapabilities {
  /** Model can act on tool schemas at all (native or structured protocol). */
  tools?: boolean;
  /** Model emits real function/tool calls. `false` ⇒ structured protocol only. */
  nativeToolCalls?: boolean;
  /** Provider streams incremental deltas for this model. */
  streaming?: boolean;
  /** Model performs explicit reasoning before answering. */
  reasoning?: boolean;
  /** Model can process image inputs. */
  vision?: boolean;
  /** Model supports a response-format / JSON-schema constrained output. */
  structuredOutput?: boolean;
  /** Model supports OpenAI-style `response_format: { type: "json_object" }`. */
  jsonMode?: boolean;
  /** Model produces embeddings. */
  embeddings?: boolean;
  /** Model produces images. */
  imageGeneration?: boolean;
}

export const CAPABILITY_KEYS = [
  "tools",
  "nativeToolCalls",
  "streaming",
  "reasoning",
  "vision",
  "structuredOutput",
  "jsonMode",
  "embeddings",
  "imageGeneration",
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** A capability requirement set. Only `true` entries are requirements; an
 *  `undefined` entry means "don't care" (NOT "must be unknown"). */
export type CapabilityRequirement = Partial<ModelCapabilities>;

// ── Models ──────────────────────────────────────────────────────────────────

export interface ModelPricing {
  /** USD per 1M input tokens. */
  input?: number;
  /** USD per 1M output tokens. */
  output?: number;
  /** USD per 1M cached-read input tokens. */
  cachedInput?: number;
  currency?: string;
  source?: "provider" | "catalog" | "unknown";
}

export interface ModelLimits {
  contextWindow?: number;
  maxOutputTokens?: number;
}

export type ModelStatus = "active" | "disabled" | "unknown";

export interface ModelDefinition {
  /** Canonical reference: `${providerId}/${apiModelId}`. */
  id: string;
  providerId: string;
  /** Provider-native model id. MAY contain slashes (OpenRouter). */
  apiModelId: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  capabilities: ModelCapabilities;
  pricing?: ModelPricing;
  limits?: ModelLimits;
  status: ModelStatus;
  metadata?: Record<string, unknown>;
}

// ── Providers ───────────────────────────────────────────────────────────────

export interface ProviderAuthentication {
  /** Environment variable that holds the key. The value is never stored here. */
  apiKeyEnv?: string;
  /** Where the key travels. */
  scheme?: "bearer" | "header" | "none";
  /** Whether a key resolved at registration time. Presence only — never a value. */
  hasApiKey?: boolean;
}

export interface ProviderHealth {
  state: HealthState;
  requestCount: number;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  /** Exponential moving average of successful call latency, milliseconds. */
  latencyMs?: number;
  lastSuccessAt?: number;
  lastErrorAt?: number;
  /** Phase 82 §4 — when the last provider-attributable failure was observed. */
  lastFailureAt?: number;
  /**
   * Phase 82 §4 — successCount / (successCount + failureCount), i.e. availability
   * over provider-attributable outcomes only. Undefined until enough samples.
   */
  availability?: number;
  /** Phase 82 §4 — failure kinds observed, most recent last (bounded). */
  recentFailures?: string[];
  /** Human-readable, already-redacted. Never contains credentials. */
  lastError?: string;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  kind: ProviderKind;
  baseURL: string;
  authentication?: ProviderAuthentication;
  /** Declared provider-level capability defaults (catalog entries win). */
  capabilities?: ModelCapabilities;
  /** Canonical model ids available from this provider. */
  models: string[];
  status: ProviderStatus;
  health: ProviderHealth;
  /** Lower number = higher preference for `priority` routing. */
  priority: number;
  enabled: boolean;
  metadata?: Record<string, unknown>;
}

/** What a caller supplies to `ProviderRegistry.register`. */
export interface ProviderRegistration {
  id: string;
  name?: string;
  kind: ProviderKind;
  baseURL: string;
  authentication?: ProviderAuthentication;
  capabilities?: ModelCapabilities;
  models?: ModelDefinition[];
  priority?: number;
  enabled?: boolean;
  status?: ProviderStatus;
  metadata?: Record<string, unknown>;
}

// ── Model references ────────────────────────────────────────────────────────

/**
 * A parsed `provider/model` reference. `modelId` is the provider-native id and
 * MAY itself contain slashes — `openrouter/anthropic/claude-sonnet` parses to
 * provider `openrouter`, model `anthropic/claude-sonnet`.
 */
export interface ModelRef {
  raw: string;
  /** Undefined when the reference is unqualified (bare model id). */
  providerId?: string;
  modelId: string;
}

// ── Routing ─────────────────────────────────────────────────────────────────

export type RoutingPolicy =
  | "explicit"
  | "priority"
  | "cheapest"
  | "fastest"
  | "capability-first"
  | "fallback";

export interface RoutingRequest {
  /** Explicit model reference (`provider/model`, or a bare model id). */
  model?: string;
  /** Explicit provider id. Combined with `model` this pins the pair. */
  provider?: string;
  /** Models must satisfy every `true` entry. */
  requiredCapabilities?: CapabilityRequirement;
  /** Models satisfying these sort ahead of others. */
  preferredCapabilities?: CapabilityRequirement;
  excludedProviders?: string[];
  policy?: RoutingPolicy;
  /**
   * Phase 80 — named routing profile (`auto`, `quality`, `coding`, ...).
   * A profile supplies the scorer weights and default policy; an explicit
   * `policy` on the request still wins for ordering.
   */
  profile?: string;
  taskType?: string;
  sessionId?: string;
  /** Upper bound on the estimated blended price (USD per 1M tokens). */
  costLimit?: number;
  /**
   * Phase 80 — minimum acceptable context window. Models that DECLARE a
   * smaller window are filtered; models that declare none are kept (unknown is
   * not proof of insufficiency).
   */
  minContextWindow?: number;
  timeout?: number;
  signal?: AbortSignal;
  /**
   * Phase 82 §3 — hard provider/upstream constraints for this request
   * (`allowProviders`, `denyProviders`, price caps, context floor,
   * `allowFallback`). Ordering is chosen by the configured provider policy.
   */
  providerConstraints?: Partial<import("./providerPolicy").ProviderConstraints>;
}

export interface ResolvedModel {
  provider: ProviderDefinition;
  model: ModelDefinition;
  capabilities: ModelCapabilities;
  /** Deterministic, human-readable explanation of the selection. */
  routingReason: string;
  /** The full ordered candidate chain, resolved head first. */
  candidates: ModelDefinition[];
  /** Phase 80 — the routing profile that produced this decision. */
  profile?: string;
  /** Phase 80 — scorer total for the head candidate, when score-ranked. */
  score?: number;
  /**
   * Phase 82 — the same chain expressed as provider ROUTES. `candidates` stays
   * for backward compatibility (it is a model list); `routes` carries the
   * provider/upstream identity that bounded fallback actually needs.
   */
  routes?: import("./route").ProviderRoute[];
  /** Phase 82 — the selected route (head of `routes`). */
  route?: import("./route").ProviderRoute;
}

// ── Usage / cost ────────────────────────────────────────────────────────────

export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  /** Provider-reported cost in USD, when the provider supplies it. */
  costUsd?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function unknownHealth(): ProviderHealth {
  return {
    state: "unknown",
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
  };
}

/** Estimated blended price (USD / 1M tokens) used by `cheapest` routing. */
export function blendedPrice(model: ModelDefinition): number | undefined {
  const input = model.pricing?.input;
  const output = model.pricing?.output;
  if (input === undefined && output === undefined) return undefined;
  return (input ?? 0) + (output ?? 0);
}

/** Capability check: every `true` requirement must be `true` on the model. */
export function satisfiesCapabilities(
  caps: ModelCapabilities,
  requirement: CapabilityRequirement | undefined,
): boolean {
  if (!requirement) return true;
  for (const key of CAPABILITY_KEYS) {
    if (requirement[key] === true && caps[key] !== true) return false;
  }
  return true;
}
