export type Role = "user" | "assistant" | "system" | "tool";

export interface ContextMessage {
  role: Role;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  pruned?: boolean;
}

export interface ModelContextSpec {
  modelName: string;
  maxContextTokens: number;
  maxOutputTokens: number;
  /** Per-model usable capacity: the auto-compaction trigger. */
  autoCompactThresholdTokens: number;
  /** Which metadata rule produced `autoCompactThresholdTokens`. */
  usableRule: "input_minus_reserved" | "context_minus_output";
  charsPerTokenEstimate: number;
}

export interface ContextBudget {
  modelName: string;
  maxContextTokens: number;
  currentEstimatedTokens: number;
  currentEstimatedChars: number;
  utilizationPercent: number;
  systemTokens: number;
  memoryTokens: number;
  conversationTokens: number;
  activeToolTokens: number;
  availableTokens: number;
  needsCompaction: boolean;
  /** The per-model capacity the trigger and `availableTokens` are measured against. */
  usableTokens: number;
  /** Which metadata rule produced `usableTokens`. */
  usableRule: "input_minus_reserved" | "context_minus_output";
}

export interface CompactionOptions {
  force?: boolean;
  thresholdTokens?: number;
  thresholdChars?: number;
  /**
   * Explicit turn-count retention. When omitted, retention is TOKEN-based
   * (`keepRecentTokens`), which is what the checkpoint contract requires.
   */
  keepRecentCount?: number;
  /** Token budget for the recent tail kept verbatim. Default 8,000. */
  keepRecentTokens?: number;
  /**
   * The checkpoint being replaced. Normally read from the session context; set
   * explicitly only by callers that own the checkpoint (tests, isolation).
   */
  priorSummary?: string;
  preserveSystemPrompt?: boolean;
  customSummaryPrefix?: string;
  model?: string;
 /** : session binding for memory access. */
  sessionId?: string;
 /** : explicit memory store override (tests, subagent isolation). */
  memory?: any;  /** : summary message role. Default is "user" for provider compatibility. */
  summaryRole?: "user" | "system" | "assistant";
  /**
   * Model-backed summarizer, injected by the caller. The compaction layer never
   * reaches for a provider itself: it builds the prompt and hands it over.
   *
   * Must be called with tools DISABLED and a bounded output budget
   * (`SUMMARY_MAX_TOKENS`). When it is absent, or it fails, the deterministic
   * summary is used instead — a compaction is never lost to a failed summary.
   */
  summarizeWithModel?: (request: {
    prompt: string;
    maxTokens: number;
  }) => Promise<string>;
}

export interface CompactionResult {
  compacted: boolean;
  messages: ContextMessage[];
  originalCount: number;
  newCount: number;
  savedChars: number;
  originalTokens?: number;
  newTokens?: number;
  savedTokens?: number;
  reason?: string;
  /** Which summary produced this checkpoint. */
  summarySource?: "model" | "deterministic";
  /** True when a previous checkpoint was folded into the new summary. */
  chainedFromPriorSummary?: boolean;
}

export interface SessionMemoryData {
  workspaceRoot: string;
  framework?: string;
  projectOverview?: string;
  keyFilesTouched: string[];
  modifiedFiles: string[];
  userGoals: string[];
  discoveredInsights: string[];
  environmentInfo: Record<string, string>;
  lastUpdated: number;
}

export interface PruneOptions {
  maxToolResultChars?: number;
  keepRecentToolsCount?: number;
  alwaysPreserveErrors?: boolean;
}
