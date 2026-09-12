/**
 * Phase 80 §9/§10/§14 — Eval contracts.
 *
 * The eval layer measures models on the SAME execution path production uses:
 *
 *   EvalRunner → AgentHarness → ModelRouter → ProviderRegistry → ModelAdapter
 *              → provider
 *
 * It never calls `provider.chat` itself and never builds its own agent loop. A
 * "forcing a model" request still travels through `ModelRouter` (as an explicit
 * reference), which is exactly the behaviour we want to measure.
 *
 * Grading is DETERMINISTIC. There is no LLM judge in this phase: a model that
 * narrates "I fixed the file" without calling a tool FAILS, because the grader
 * inspects the real filesystem and the real tool-call stream.
 */

import type { CapabilityRequirement } from "../models/types";
import type { EvalDimension } from "../models/performance";

export type EvalCaseType = "TEXT" | "CODE" | "TOOL" | "REASONING" | "STRUCTURED_OUTPUT";

/**
 * Failure taxonomy. The distinction that matters: a provider timeout is NOT a
 * model-quality failure, and a runtime bug is not the model's fault.
 */
export type EvalFailureClass =
  | "CORE_RUNTIME"
  | "MODEL_COMPLIANCE"
  | "PROVIDER_PROTOCOL"
  | "TOOL_FAILURE"
  | "PERMISSION"
  | "TIMEOUT"
  | "CANCELLED"
  | "ENVIRONMENT";

export type GraderKind =
  | "exact"
  | "contains"
  | "regex"
  | "json-schema"
  | "tool-call"
  | "file-mutation"
  | "command-exit"
  | "run-state";

export interface EvalGraderSpec {
  kind: GraderKind;
  // exact
  value?: string;
  /** Case/whitespace-insensitive exact comparison (default true). */
  ignoreCase?: boolean;
  ignoreWhitespace?: boolean;
  // contains
  containsAll?: string[];
  containsAny?: string[];
  notContains?: string[];
  // regex
  pattern?: string;
  flags?: string;
  // json-schema (subset: type, required, properties, items, enum, additionalProperties)
  schema?: unknown;
  // tool-call
  /** Tool names allowed/expected. */
  expectTool?: string | string[];
  minToolCalls?: number;
  maxToolCalls?: number;
  /** Forbid repeating an identical (tool, args) invocation. Default true. */
  allowDuplicateToolCalls?: boolean;
  /** All observed tool calls must have succeeded. Default false. */
  requireSuccessfulTools?: boolean;
  /** Any tool call at all fails the case (§13: narrating without acting). */
  allowNoToolCall?: boolean;
  // file-mutation
  path?: string;
  expectExists?: boolean;
  expectAbsent?: boolean;
  expectContent?: string;
  expectNotContent?: string;
  expectMatches?: string;
  // command-exit
  exitCodes?: number[];
  // run-state
  /** The run must have been cancelled (Phase 80 §12 H). */
  expectCancelled?: boolean;
  /** The run must have completed without a runtime exception (§12 G). */
  expectNoCrash?: boolean;
  /** A runtime exception occurred instead of a graded outcome. */
  expectRuntimeError?: boolean;
}

export interface EvalCase {
  id: string;
  name: string;
  type: EvalCaseType;
  prompt: string;
  /** Fixture tree name under the eval fixtures directory. */
  fixture?: string;
  grader: EvalGraderSpec;
  /**
   * Additional graders — a case passes only when ALL pass. Used when a case
   * must assert more than one independent property (e.g. "the model actually
   * ran the suite" AND "the suite exited 0").
   */
  graders?: EvalGraderSpec[];
  timeoutMs?: number;
  maxTurns?: number;
  requiredCapabilities?: CapabilityRequirement;
  /** Routing profile hint for this case. */
  profile?: string;
  /** Tools the agent may call. When omitted the harness default is used. */
  tools?: string[];
  /** Dimension this case measures for the performance profile. */
  dimension?: EvalDimension;
  /** Execute this command after the turn and record its exit code. */
  postCommand?: { command: string; args: string[]; timeoutMs?: number };
  /** Abort the run after this many milliseconds (cancellation cases). */
  cancelAfterMs?: number;
  /** Paths (relative to the workspace) deleted before the run. */
  cleanupPaths?: string[];
  /** Per-case environment overrides (never secrets). */
  env?: Record<string, string>;
  /**
   * Phase 81 §13 — harness profile for this case. The same model under
   * different harness policies is exactly what a cross-harness comparison
   * measures, so the profile is part of the case, not a global setting.
   */
  harness?: string;
  /**
   * Phase 83 §17 — execution target for this case: `native` (ToolNet's own
   * AgentHarness) or an external harness id (`opencode`, `codex`, …).
   * Deliberately a DIFFERENT dimension from `harness`: a native `coding`
   * profile is not the same thing as the external `codex` harness, and the
   * stored record must never conflate them.
   */
  executionTarget?: string;
}

export interface EvalSuite {
  id: string;
  version: string;
  name: string;
  description: string;
  cases: EvalCase[];
}

// ── Observation + grading ───────────────────────────────────────────────────

export interface ObservedToolCall {
  id: string;
  name: string;
  arguments: unknown;
  ok: boolean;
  reason?: string;
}

export interface EvalObservation {
  /** Final assistant text. */
  output: string;
  toolCalls: ObservedToolCall[];
  workspaceRoot: string;
  /** Files the agent read/wrote, relative to the workspace. */
  filesRead: string[];
  filesWritten: string[];
  /** Exit codes captured from post-commands, in order. */
  exitCodes: number[];
  postCommandOutput: string[];
  cancelled: boolean;
  /** A runtime exception (not a graded failure) escaped the run. */
  runtimeError?: string;
  /**
   * True only when the run THREW. The harness also reports expected failures
   * (for example "no mutation happened") as `success:false`; those are graded
   * outcomes, not runtime crashes.
   */
  threw?: boolean;
  durationMs: number;
}

export interface GraderResult {
  pass: boolean;
  /** 0..1 — a grader may award partial credit. */
  score: number;
  detail: string;
}

export type Grader = (observation: EvalObservation, spec: EvalGraderSpec) => GraderResult;

// ── Results ─────────────────────────────────────────────────────────────────

export interface EvalCaseResult {
  caseId: string;
  name: string;
  type: EvalCaseType;
  pass: boolean;
  score: number;
  detail: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  failedToolCalls: number;
  duplicateToolCalls: number;
  retries: number;
  costUsd?: number;
  failureClass?: EvalFailureClass;
  output?: string;
  /** Phase 81 — the harness profile actually used for this case. */
  harnessId?: string;
  /** Phase 83 §17 — execution target actually used (`native` | external id). */
  executionTarget?: string;
  /** Phase 81 §11 — evidence-derived verdict, when the harness reported one. */
  verdict?: "SUCCESS" | "PARTIAL" | "FAILED" | "CANCELLED" | "TIMEOUT";
  /** Phase 81 — model turns consumed by the case. */
  turns?: number;
}

export interface EvalRunMetrics {
  passRate: number;
  meanDurationMs: number;
  /** Phase 81 §14 — mean turns per case, so harnesses are comparable. */
  meanTurns?: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  totalToolCalls: number;
  totalFailedToolCalls: number;
  totalCostUsd?: number;
  /** Pass rate by case type — the tool-use signal lives here. */
  byType: Record<string, { passed: number; total: number }>;
}

export interface EvalRunRecord {
  schemaVersion: number;
  runId: string;
  suiteId: string;
  suiteVersion: string;
  model: string;
  provider: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  passed: number;
  failed: number;
  metrics: EvalRunMetrics;
  cases: EvalCaseResult[];
  /**
   * Phase 81 §13 — which harness policy contract produced this run.
   *
   * Optional because records written before Phase 81 (and records replayed from
   * the store) legitimately have no harness identity. Every NEW run populates
   * both fields; readers must treat them as "unattributed" when absent rather
   * than assuming `default`.
   */
  harnessId?: string;
  harnessVersion?: string;
  /** Phase 83 §17 — execution target of the run (`native` by definition). */
  executionTarget?: string;
  toolnetVersion?: string;
  commit?: string;
  /** Never contains prompts judged secret; prompts are eval fixtures only. */
  notes?: string[];
}

export { EVAL_RUN_SCHEMA_VERSION } from "./schema";
