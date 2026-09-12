/**
 * Phase 81 §8 — continuation policy.
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

  // 4. Turn budget.
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
