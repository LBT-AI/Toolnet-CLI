/**
 * Phase 81 — Harness compatibility layer.
 *
 * POLICY for the single AgentHarness. Nothing exported here is a runtime, an
 * execution loop, a provider wrapper or a tool executor, and nothing here can
 * change a permission verdict.
 *
 *   Task → AgentHarness → HarnessProfile → AgentEngine → ModelRouter
 *        → ModelAdapter → Provider
 */

export type {
  HarnessProfile,
  HarnessPolicyName,
  HarnessResolution,
  HarnessResolveRequest,
  PromptPolicy,
  ToolPolicy,
  ContinuationPolicy,
  ContextPolicy,
  CompletionPolicy,
} from "./types";
export { HARNESS_POLICY_NAMES } from "./types";

export {
  AUTO_HARNESS_BY_TASK,
  BUILTIN_HARNESS_PROFILES,
  CANONICAL_MAX_CONSECUTIVE_NO_PROGRESS_TURNS,
  CANONICAL_MAX_DUPLICATE_SENSITIVE_TOOL_CALLS,
  CANONICAL_MAX_REPEATED_TOOL_CALLS,
  DEFAULT_HARNESS_PROFILE_ID,
  NO_PROGRESS_BOUND_DISABLED,
  codingProfile,
  defaultProfile,
  isBuiltinProfileId,
  minimalProfile,
  reasoningProfile,
  toolHeavyProfile,
} from "./profiles";

export {
  HarnessError,
  harnessProfileDuplicate,
  harnessProfileInvalid,
  harnessProfileNotFound,
  type HarnessErrorCode,
} from "./errors";

export { HarnessRegistry, harnessRegistry } from "./registry";

export {
  describeHarnessProfile,
  resolveHarnessProfile,
  summarizeHarnessProfile,
  tryResolveHarnessProfile,
} from "./resolver";

export {
  currentHarnessSettings,
  persistHarnessProfile,
  resetPersistedHarness,
  validateHarnessPatch,
  type HarnessValidation,
} from "./store";

export {
  assemblePromptBase,
  composeSystemPrompt,
  isPassthroughPromptPolicy,
  PERMISSION_LIMIT_NOTE,
  type PromptBlocks,
  type PromptBuildInput,
} from "./prompt";

export {
  applyToolOrdering,
  exposedToolNames,
  isPassthroughToolPolicy,
  isToolExposed,
  orderByPreference,
  toolGuidance,
} from "./tools";

export {
  decideContinuation,
  exceedsRepeatedToolCalls,
  maxTurnsError,
  noProgressError,
  repeatedToolCallError,
  resolveMaxTurns,
  type ContinuationDecision,
  type ContinuationInput,
  type ContinuationKind,
} from "./continuation";

export {
  describeContextPolicy,
  ensureDenialsRetained,
  hasRetainedDecisions,
  PERMISSION_DECISIONS_MARKER,
  permissionDecisionsBlock,
  prepareOptionsFor,
  type PermissionDenialRecord,
  type PrepareOptions,
} from "./context";

export {
  detectProgress,
  emptySignals,
  fingerprintResponse,
  ProgressTracker,
  type ProgressObservation,
  type ProgressSignals,
  type ProgressVerdict,
} from "./progress";

export {
  commandFromArgs,
  ExecutionEvidenceCollector,
  emptyExecutionEvidence,
  isMutationTool,
  isReadTool,
  isShellTool,
  looksLikeTestCommand,
  looksLikeVerificationCommand,
  MUTATION_TOOLS,
  READ_TOOLS,
  SHELL_TOOLS,
  toolFileTarget,
  type ExecutionEvidence,
} from "./evidence";

export {
  COMPLETION_VERDICTS,
  computeVerdict,
  verdictLabel,
  type CompletionVerdict,
  type RequiredWork,
  type VerdictInput,
  type VerdictResult,
  type VerifiedWork,
} from "./verdict";
