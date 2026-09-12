/**
 * Phase 81 §11 — completion contract.
 *
 * A run's outcome is NOT "the model emitted final text". It is a verdict
 * computed from what actually happened:
 *
 *   SUCCESS    the required work happened and was verified where required
 *   PARTIAL    real work happened, but a required step is still outstanding
 *   FAILED     nothing required happened, or the loop reported failure
 *   CANCELLED  the user (or a parent) aborted the run
 *   TIMEOUT    the run exceeded its budget
 *
 * The two examples from the spec, made concrete:
 *
 *   Model: "Done."   but the task required a file change and none occurred
 *                    → never SUCCESS (PARTIAL when other work happened,
 *                      FAILED when nothing did)
 *   Model: "Tests pass." but no test command was ever executed
 *                    → never SUCCESS when verification was required
 *
 * Guard clauses with early returns; no nested branching.
 */

import type { CompletionPolicy } from "./types";
import type { ExecutionEvidence } from "./evidence";

export type CompletionVerdict = "SUCCESS" | "PARTIAL" | "FAILED" | "CANCELLED" | "TIMEOUT";

export const COMPLETION_VERDICTS: CompletionVerdict[] = [
  "SUCCESS",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
];

export interface RequiredWork {
  mutationRequired: boolean;
  executionRequired: boolean;
  verificationRequired: boolean;
  testRequired: boolean;
}

/** Verified side effects (Phase 73.9 gate counters). */
export interface VerifiedWork {
  mutations: number;
  executions: number;
  tests: number;
  verifications: number;
}

export interface VerdictInput {
  policy: CompletionPolicy;
  requirements: RequiredWork;
  verified: VerifiedWork;
  evidence: ExecutionEvidence;
  /** The loop's own success flag, before evidence is considered. */
  runSucceeded: boolean;
  cancelled: boolean;
  timedOut: boolean;
  /** The model produced final text to show the user. */
  hasOutput: boolean;
}

export interface VerdictResult {
  verdict: CompletionVerdict;
  /** Every unmet requirement, in deterministic order. */
  reasons: string[];
}

function unmetRequirements(input: VerdictInput): string[] {
  const { requirements, verified, policy } = input;
  if (!policy.requireEvidenceForSuccess) return [];
  const unmet: string[] = [];
  if (requirements.mutationRequired && verified.mutations === 0) {
    unmet.push("mutation required but the workspace was never changed");
  }
  if (requirements.executionRequired && verified.executions === 0) {
    unmet.push("execution required but no command succeeded");
  }
  if (requirements.testRequired && verified.tests === 0) {
    unmet.push("tests required but none ran");
  }
  if (requirements.verificationRequired && verified.verifications === 0 && verified.tests === 0) {
    unmet.push("verification required but none passed");
  }
  return unmet;
}

export function computeVerdict(input: VerdictInput): VerdictResult {
  // 1. Terminal run states win: a cancelled or timed-out run is not a
  //    statement about task completion.
  if (input.cancelled) return { verdict: "CANCELLED", reasons: ["run was cancelled"] };
  if (input.timedOut) return { verdict: "TIMEOUT", reasons: ["run exceeded its time budget"] };

  const unmet = unmetRequirements(input);

  // 2. The loop itself failed (network error, loop abort, empty response).
  if (!input.runSucceeded) {
    return {
      verdict: "FAILED",
      reasons: unmet.length > 0 ? unmet : ["the agent loop reported failure"],
    };
  }

  if (unmet.length === 0) {
    return { verdict: "SUCCESS", reasons: [] };
  }

  // 3. Some required work is outstanding. Distinguish "did something useful but
  //    not all of it" from "produced prose and nothing else" — the second is the
  //    fake-success shape the gate exists to stop.
  const didRealWork =
    input.verified.mutations > 0 ||
    input.verified.executions > 0 ||
    input.evidence.toolCalls > 0;

  if (!didRealWork) {
    return {
      verdict: "FAILED",
      reasons: [...unmet, "no tool execution was recorded"],
    };
  }

  return { verdict: "PARTIAL", reasons: unmet };
}

/** Convenience for UIs and eval records. */
export function verdictLabel(verdict: CompletionVerdict): string {
  switch (verdict) {
    case "SUCCESS":
      return "success";
    case "PARTIAL":
      return "partial";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    default:
      return "timeout";
  }
}
