/**
 * Phase 80 — eval layer barrel. Import from here, not individual modules.
 */

export { EVAL_RUN_SCHEMA_VERSION } from "./schema";
export type {
  EvalCase,
  EvalCaseResult,
  EvalCaseType,
  EvalFailureClass,
  EvalGraderSpec,
  EvalObservation,
  EvalRunMetrics,
  EvalRunRecord,
  EvalSuite,
  Grader,
  GraderKind,
  GraderResult,
  ObservedToolCall,
} from "./types";

export {
  commandExitGrader,
  containsGrader,
  exactMatchGrader,
  extractJson,
  fileMutationGrader,
  graderFor,
  jsonSchemaGrader,
  regexGrader,
  runStateGrader,
  stableStringify,
  toolCallGrader,
  validateJsonSchema,
} from "./graders";

export { EvalStore, getEvalIndexPath, getEvalsDir } from "./store";

export {
  indexRecords,
  profilesByModelAlias,
  profilesFromRecords,
  profilesFromSamples,
  sampleFromCase,
  samplesFromRecords,
} from "./profile";

export {
  EvalRunner,
  buildMetrics,
  classifyFailure,
  countDuplicateToolCalls,
  resolveFixturesDir,
  type EvalHarness,
  type EvalRunnerOptions,
} from "./runner";

export {
  runLiveCompletionProbe,
  runToolNetProbe,
  type LiveCompletionOptions,
  type LiveCompletionReport,
  type ToolNetProbeEntry,
  type ToolNetProbeReport,
} from "./liveAcceptance";

export {
  BUILTIN_SUITES,
  codingSuite,
  findSuite,
  reasoningSuite,
  structuredSuite,
  suiteIds,
  textSuite,
  toolSuite,
} from "./suites";
