/**
 * Context intelligence.
 *
 * Public surface: the canonical `ContextManager`, token estimation with
 * provenance, model-limit resolution from the model catalog, budgeting,
 * planning, bounded compaction and the bounded context cache.
 */

export * from "./types";
export {
  TokenEstimator,
  tokenEstimator,
  estimateTokens,
  estimateMessages,
  type EstimatableMessage,
} from "./estimator";
export {
  resolveModelLimits,
  findCatalogModel,
  describeLimitSource,
  OUTPUT_RESERVE_CAP,
  FALLBACK_CONTEXT_WINDOW,
  FALLBACK_OUTPUT_TOKENS,
} from "./limits";
export {
  computeContextBudget,
  estimateToolOverhead,
  projectedRequestTokens,
  describeBudget,
  DEFAULT_HEADROOM_RATIO,
  type BudgetInput,
} from "./budget";
export {
  ContextOverflowError,
  classifyContextFailure,
  isContextOverflow,
  asContextOverflow,
  isTerminalWithoutCompaction,
  type FailureInput,
} from "./overflow";
export {
  planContext,
  largestContributors,
  carriesPermissionDecision,
  DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  type PlannerInput,
} from "./planner";
export {
  runBoundedCompaction,
  withCompactionLock,
  isCompactionInFlight,
  observeCompletedRequest,
  DEFAULT_MAX_PASSES,
  DEFAULT_MIN_SAVINGS_TOKENS,
  DEFAULT_MIN_SAVINGS_RATIO,
  type CompactionRunInput,
  type PruneStepResult,
  type SummaryStepResult,
} from "./compaction";
export {
  ContextCache,
  contextCache,
  hashContent,
  tokenCacheKey,
  type CacheStats,
  type ContextCacheOptions,
} from "./cache";
export {
  ContextManager,
  contextManager,
  type ContextManagerOptions,
  type ContextEvent,
  type PrepareInput,
  type PrepareResult,
} from "./manager";
