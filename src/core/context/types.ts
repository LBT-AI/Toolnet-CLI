/**
 * Canonical context-intelligence model.
 *
 * Session history is NOT model-visible context. Durable history lives in the
 * session store and is never deleted because it fell out of a request; this
 * module decides only what is sent to the model for one turn, and why.
 *
 * Every number here is an ESTIMATE unless it carries `source: "provider_usage"`.
 * Nothing in this layer may pretend an estimate is exact, because acting on a
 * wrong estimate either truncates a needed file or trips a provider overflow.
 */

export type TokenSource = "provider_usage" | "tokenizer" | "estimated" | "unknown";

export type Confidence = "exact" | "high" | "low";

export interface TokenEstimate {
  tokens: number;
  confidence: Confidence;
  source: TokenSource;
}

export function unknownEstimate(): TokenEstimate {
  return { tokens: 0, confidence: "low", source: "unknown" };
}

/** Where a model's limits came from — surfaced so callers can weigh certainty. */
export type LimitSource = "catalog" | "legacy_table" | "fallback";

export interface ModelLimits {
  contextWindow: number;
  /**
   * Declared input capacity, when the provider declares one separately from the
   * window. Undefined means the model has no separate input limit, which is a
   * different fact from "the input limit equals the window".
   */
  inputLimit?: number;
  maxOutputTokens: number;
  source: LimitSource;
}

/**
 * How much of the model's capacity this request may actually use.
 *
 * Two rules, chosen by what the model's own metadata declares — never by a
 * single hard-coded number:
 *
 *  - the model declares an input limit → `input - reserved`, where `reserved`
 *    is the configured value or `min(COMPACTION_BUFFER, maxOutputTokens)`;
 *  - no input limit → `context - maxOutputTokens`.
 *
 * Auto-compaction fires when the request reaches `usable`, so the trigger is
 * per-model instead of a global threshold, and a model that declares nothing
 * still gets a defensible one.
 */
export interface UsableInput {
  /** Capacity this request may occupy before compaction is required. */
  usable: number;
  /** Capacity withheld from `usable` for the answer. */
  reserved: number;
  /** Which rule produced `usable`; surfaced so callers can report provenance. */
  rule: "input_minus_reserved" | "context_minus_output";
}

export interface ContextBudget {
  model: string;
  contextWindow: number;
  /** Capacity withheld so the model can actually answer. */
  reservedOutput: number;
  /** Capacity withheld for instructions that must always be present. */
  reservedSystem: number;
  /** Capacity withheld for tool schemas/framing. */
  reservedTools: number;
  /**
   * Capacity the request may occupy before compaction is required, derived from
   * this model's own declared limits (see `UsableInput`). System and tool
   * capacity stays inside this number rather than being charged twice.
   */
  usableInput: number;
  /** Which metadata rule produced `usableInput`. */
  usableRule: UsableInput["rule"];
  /** Estimated size of the transcript that would be sent. */
  estimatedInput: number;
  /** Estimated size of the WHOLE request: system + tools + transcript. */
  usedInput: number;
  /** usableInput - usedInput (never negative). */
  remaining: number;
  /**
   * Compaction trigger. Equals `usableInput`: the request is over budget as soon
   * as it reaches the capacity this model's metadata allows for input.
   */
  threshold: number;
  source: LimitSource;
  confidence: Confidence;
  overThreshold: boolean;
  overflow: boolean;
}

// ── Planning ────────────────────────────────────────────────────────────────

/**
 * Why a category is present. Protected categories may only be dropped when the
 * budget is so small that dropping them is the difference between asking and
 * overflowing — and even then a permission decision is carried forward rather
 * than forgotten (see `planner.ts`).
 */
export type ContextCategory =
  | "system_instructions"
  | "permission_decisions"
  | "current_task"
  | "active_error"
  | "execution_evidence"
  | "recent_tool_results"
  | "older_tool_results"
  | "conversation"
  | "attachments";

export interface ContextItem {
  category: ContextCategory;
  role: string;
  tokens: number;
  index: number;
  protected: boolean;
  /** Stable identity when the item represents a file/attachment. */
  ref?: string;
  reason: string;
}

export interface ContextPlan {
  budget: ContextBudget;
  included: ContextItem[];
  excluded: ContextItem[];
  protectedTokens: number;
  prunableTokens: number;
  estimatedTokens: number;
  compactionNeeded: boolean;
  reasons: string[];
}

// ── Compaction records ──────────────────────────────────────────────────────

export type CompactionStrategy = "prune" | "structured_summary" | "combined";

export interface CompactionRecord {
  id: string;
  sessionId?: string;
  /** Journal sequence range this compaction consumed, when known. */
  sourceEventRange?: { from: number; to: number };
  createdAt: number;
  strategy: CompactionStrategy;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  /** Opaque durable reference to the compacted state (summary marker, id). */
  summaryRef?: string;
  protectedState?: string[];
}

// ── Compaction outcome ──────────────────────────────────────────────────────

export type CompactionFailure =
  | "no_reduction"
  | "increased"
  | "insufficient_reduction"
  | "nothing_to_compact"
  | "refused_integrity"
  | "attempt_limit"
  | "cancelled";

export interface CompactionOutcome {
  compacted: boolean;
  messages: unknown[];
  passes: number;
  beforeTokens: number;
  afterTokens: number;
  savedTokens: number;
  record?: CompactionRecord;
  failure?: CompactionFailure;
  reason: string;
}

// ── Overflow ────────────────────────────────────────────────────────────────

export type OverflowKind =
  | "context_overflow"
  | "rate_limit"
  | "auth"
  | "unavailable"
  | "bad_request"
  | "cancelled"
  | "unknown";

export interface OverflowClassification {
  kind: OverflowKind;
  retryable: boolean;
  /** True only for `context_overflow` — the one case compaction can fix. */
  compactionMayHelp: boolean;
  matchedBy: string;
}
