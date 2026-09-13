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
  maxOutputTokens: number;
  source: LimitSource;
  /**
   * Compatibility only: the compaction trigger established for a pre-catalog
   * identity. Absent when the catalog declares the model, in which case the
   * canonical budget derives its own threshold from the window.
   */
  compactionThreshold?: number;
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
  /** Context capacity left for transcript after every reservation. */
  usableInput: number;
  /** Estimated size of the transcript that would be sent. */
  estimatedInput: number;
  /** usableInput - estimatedInput (never negative). */
  remaining: number;
  /** Compaction trigger: a frontier strictly below usableInput. */
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
