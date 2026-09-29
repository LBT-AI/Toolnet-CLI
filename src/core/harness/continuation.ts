/**
 * — continuation policy.
 *
 * One place decides whether the loop continues, finishes, or terminates with a
 * structured failure. All four bounds come from the profile's
 * ContinuationPolicy — no caller may hard-code its own repeat or progress limit.
 *
 * The guards exist to make `while (true)` impossible:
 *
 *   finish            the model produced a final answer
 *   abort-repeat      the same (tool, args) repeated beyond the bound
 *   abort-no-progress no observable progress for N consecutive turns
 *   abort-max-turns   the turn budget was exhausted
 *   continue          otherwise
 *
 * Order matters: a final answer is always accepted, and a stuck tool loop is
 * reported as a loop rather than as an exhausted budget.
 */

import type { ContinuationPolicy } from "./types";

export type ContinuationKind =
  | "continue"
  | "finish"
  | "abort-repeat"
  | "abort-no-progress"
  | "abort-max-turns";

export interface ContinuationInput {
  policy: ContinuationPolicy;
  /** Turns already used, including the one being evaluated. */
  turnsUsed: number;
  /** Resolved turn budget for this run. */
  maxTurns: number;
  /** Consecutive identical (tool, args) invocations, INCLUDING this one. */
  consecutiveRepeats: number;
  /** Consecutive no-progress turns reported by the ProgressTracker. */
  noProgressTurns: number;
  /** The model produced a final (no-tool-call) answer this turn. */
  finalAnswer: boolean;
}

export interface ContinuationDecision {
  kind: ContinuationKind;
  /** Convenience flag: only `continue` keeps looping. */
  shouldContinue: boolean;
  reason?: string;
  /** Message to surface as `HarnessResult.error` on an abort. */
  error?: string;
}

/**
 * The message keeps the historical "Infinite loop detected" prefix: it is the
 * string operators and existing regression tests key on.
 */
export function repeatedToolCallError(toolName: string, repeats: number): string {
  return `Infinite loop detected: tool '${toolName}' was called ${repeats} times consecutively with identical arguments. Aborting loop.`;
}

export function noProgressError(turns: number): string {
  return `No progress detected: ${turns} consecutive turns without a new tool call, mutation, command result, diagnostic or response change. Aborting loop.`;
}

export function maxTurnsError(maxTurns: number): string {
  return `Exceeded maximum turn count (${maxTurns})`;
}

/**
 * True when the repeat bound is reached. Called per tool call, before dispatch,
 * so the offending call never executes. `maxRepeatedToolCalls <= 0` disables.
 */
export function exceedsRepeatedToolCalls(
  policy: ContinuationPolicy,
  consecutiveRepeats: number,
): boolean {
  if (policy.maxRepeatedToolCalls <= 0) return false;
  return consecutiveRepeats >= policy.maxRepeatedToolCalls;
}

/** Full decision, evaluated once per turn. */
export function decideContinuation(input: ContinuationInput): ContinuationDecision {
  // 1. A final answer ends the run regardless of budget.
  if (input.finalAnswer) {
    return { kind: "finish", shouldContinue: false, reason: "final answer produced" };
  }

  // 2. A repeated identical tool call is a stuck loop, not a budget problem.
  if (exceedsRepeatedToolCalls(input.policy, input.consecutiveRepeats)) {
    return {
      kind: "abort-repeat",
      shouldContinue: false,
      reason: "identical tool call repeated beyond bound",
      error: repeatedToolCallError("<tool>", input.consecutiveRepeats),
    };
  }

  // 3. No observable progress for N turns. Disabled when the bound is 0.
  if (
    input.policy.maxConsecutiveNoProgressTurns > 0 &&
    input.noProgressTurns >= input.policy.maxConsecutiveNoProgressTurns
  ) {
    return {
      kind: "abort-no-progress",
      shouldContinue: false,
      reason: "no observable progress",
      error: noProgressError(input.noProgressTurns),
    };
  }

  // 4. Phase 3 soft-budget boundary: the resolved budget may earn bounded
  // extensions while meaningful verified progress exists; otherwise the run
  // stops early (no-progress) rather than reporting a generic max-turns error.
  // The hard cap ALWAYS terminates (never extends), so the loop stays bounded.
  if (input.turnsUsed >= input.maxTurns) {
    return {
      kind: "abort-max-turns",
      shouldContinue: false,
      reason: "turn budget exhausted",
      error: maxTurnsError(input.maxTurns),
    };
  }

  return { kind: "continue", shouldContinue: true };
}

/**
 * Resolve the turn budget for a run: an explicit caller value always wins, then
 * the profile's override, then the harness default.
 */
export function resolveMaxTurns(
  optionMaxTurns: number | undefined,
  profileMaxTurns: number | undefined,
  configMaxTurns: number | undefined,
  fallback: number,
): number {
  return optionMaxTurns || profileMaxTurns || configMaxTurns || fallback;
}

// ═══ Phase 3 — bounded adaptive continuation ═══════════════════════════════
//
// "10 turns then die" is replaced by bounded adaptive continuation. The SOFT
// budget stays exactly what the caller/profile/config resolved (identity for
// existing setups); when the soft budget is exhausted the run may earn bounded
// EXTENSIONS, but only while it keeps producing meaningful observable
// progress. A HARD SAFETY CAP always exists — no infinite agent.
//
// Centralized here: no loop may invent its own increment or cap.

/** Turn chunk granted per meaningful-progress extension. */
export const ADAPTIVE_EXTENSION_CHUNK = 5;
/** Absolute ceiling for one foreground task. Always terminates the run. */
export const ADAPTIVE_HARD_CAP = 35;
/**
 * Meaningful tool executions a run may be granted in total across all
 * extensions. Beyond this, more tool calls are churn, not progress. Sized so
 * a run that legitimately reaches the hard cap (35 turns) still fits.
 */
export const ADAPTIVE_MAX_EXTENSION_TOOL_CALLS = 30;
/**
 * Consecutive failed executions of the SAME tool with SEMANTICALLY equivalent
 * arguments (e.g. "bun --version", "bun -v") that mark a no-progress loop.
 * Failed retries alone never earn budget: distinct retry variants burn the
 * failure credit and stop the run.
 */
export const ADAPTIVE_MAX_EQUIVALENT_FAILED_VARIANTS = 2;
/** Minimum verified progress a run must already hold to earn an extension. */
export const ADAPTIVE_MIN_VERIFIED_FOR_EXTENSION = 2;

/** Terminal stop reasons beyond the historical repeat/no-progress guards. */
export type AdaptiveStopKind = "hard-cap" | "no-progress" | "repeated-loop" | "legacy-budget";

export interface AdaptiveProgressSnapshot {
  /** Distinct (tool, args) signatures that SUCCEEDED this run. */
  distinctSuccessfulToolSigs: number;
  /** Verified mutations this run. */
  verifiedMutations: number;
  /** Tests that PASSED this run. */
  testsPassed: number;
  /** Build/verification checks that PASSED this run. */
  verificationsPassed: number;
  /** Failed tool executions this run (cumulative). */
  failedToolCalls: number;
}

export interface AdaptiveDecision {
  /** True when the budget grows and the run continues. */
  extended: boolean;
  /** The budget to loop against for the next turn. */
  budget: number;
  stopKind?: AdaptiveStopKind;
  reason: string;
}

/**
 * A stable SEMANTIC signature of failed (tool, args): numbers/booleans
 * normalized, whitespace dropped, everything lowercased — so "bun --version",
 * "bun -v" and "bun -V" collapse to equivalent variants (a retry churn loop),
 * while a genuinely changed command ("bun test", "bun test --watch") stays a
 * different variant. Ordering-insensitive for object args.
 */
export function semanticFailureSignature(toolName: string, args: Record<string, unknown>): string {
  const normalize = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof value === "string") return value.replace(/\s+/g, "").toLowerCase();
    if (Array.isArray(value)) return `[${value.map(normalize).join("|")}]`;
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((k) => `${k}:${normalize(record[k])}`)
        .join(",")}}`;
    }
    return String(value);
  };
  const parts = Object.keys(args ?? {})
    .sort()
    .map((k) => `${k}=${normalize((args ?? {})[k])}`);
  return `${String(toolName).toLowerCase()}(${parts.join("&")})`;
}

/** True when the run's verified work clears the meaningfulness bar. */
export function hasMeaningfulProgress(snapshot: AdaptiveProgressSnapshot): boolean {
  return (
    snapshot.distinctSuccessfulToolSigs > 0 ||
    snapshot.verifiedMutations > 0 ||
    snapshot.testsPassed > 0 ||
    snapshot.verificationsPassed > 0
  );
}

/** True when failures dominate the run's useful work (churn, not progress). */
function verifiedBehindFailures(snapshot: AdaptiveProgressSnapshot): boolean {
  const verified =
    snapshot.verifiedMutations +
    snapshot.testsPassed +
    snapshot.verificationsPassed;
  // Successful distinct tool work counts as useful even when it is not a
  // mutation/test/verification (reads, searches, diagnostics): the run is
  // churning only when failures OUTNUMBER all useful work combined.
  return snapshot.failedToolCalls > snapshot.distinctSuccessfulToolSigs + verified;
}

/**
 * Phase 3 soft-budget boundary decision: extend the bounded budget while the
 * run keeps making meaningful verified progress, stop early otherwise. The
 * hard cap ALWAYS terminates — it is not negotiable and not extendable.
 */
export function decideAdaptiveExtension(input: {
  turnsUsed: number;
  softBudget: number;
  hardCap?: number;
  extensionChunk?: number;
  maxExtensionToolCalls?: number;
  snapshot: AdaptiveProgressSnapshot;
}): AdaptiveDecision {
  const hardCap = input.hardCap ?? ADAPTIVE_HARD_CAP;
  const chunk = input.extensionChunk ?? ADAPTIVE_EXTENSION_CHUNK;
  const maxToolCalls = input.maxExtensionToolCalls ?? ADAPTIVE_MAX_EXTENSION_TOOL_CALLS;

  // Hard safety cap: always exists, never extends. This is what makes the
  // adaptive loop bounded.
  if (input.turnsUsed >= hardCap) {
    return {
      extended: false,
      budget: input.softBudget,
      stopKind: "hard-cap",
      reason: `Hard safety cap reached (${hardCap} turns for one task). Stopping to protect resources.`,
    };
  }

  const meaningful = hasMeaningfulProgress(input.snapshot);
  if (!meaningful) {
    return {
      extended: false,
      budget: input.softBudget,
      stopKind: "no-progress",
      reason: noProgressError(input.turnsUsed),
    };
  }

  if (input.snapshot.failedToolCalls > 0 && verifiedBehindFailures(input.snapshot)) {
    return {
      extended: false,
      budget: input.softBudget,
      stopKind: "no-progress",
      reason: `No meaningful progress: ${input.snapshot.failedToolCalls} failed execution(s) outweigh ${input.snapshot.verifiedMutations + input.snapshot.testsPassed + input.snapshot.verificationsPassed} verified result(s). Stopping instead of extending the budget.`,
    };
  }

  if (input.snapshot.distinctSuccessfulToolSigs >= maxToolCalls) {
    return {
      extended: false,
      budget: input.softBudget,
      stopKind: "hard-cap",
      reason: `Tool work ceiling reached (${maxToolCalls} distinct successful tool executions). Stopping to protect resources.`,
    };
  }

  const nextBudget = Math.min(input.softBudget + chunk, hardCap);
  return {
    extended: true,
    budget: nextBudget,
    reason: `Bounded continuation: meaningful verified progress (${input.snapshot.distinctSuccessfulToolSigs} distinct successful tool execution(s), ${input.snapshot.verifiedMutations} verified mutation(s), ${input.snapshot.testsPassed} passed test run(s), ${input.snapshot.verificationsPassed} verification(s)) — extended budget by ${chunk} turns (limit ${nextBudget}).`,
  };
}

/** Distinguishable terminal error for the hard safety cap. */
export function hardCapError(cap: number): string {
  return `Hard safety cap reached (${cap} turns for one task). Stopping to protect resources.`;
}

/** Distinguishable terminal error for equivalent-variant retry loops. */
export function equivalentFailureLoopError(variants: number): string {
  return `No-progress loop detected: the same tool failed with ${variants} equivalent argument variants. Aborting instead of retrying.`;
}
