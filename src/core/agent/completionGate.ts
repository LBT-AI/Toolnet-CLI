/**
 * Completion Gate
 *
 * The agent loop must NOT treat "the model stopped calling tools" as success.
 * A task that requires a mutation, execution, verification, or test run is only
 * complete when the corresponding side effect actually happened and was
 * verified. Assistant prose is never evidence.
 */

import type {
  CompletionDecision,
  CompletionEvidence,
  TaskRequirement,
} from "../contracts";

export interface GateInput {
  requirements: TaskRequirement;
  evidence: CompletionEvidence;
  /** The assistant's proposed final text (used to tailor the nudge). */
  proposedAnswer: string;
  /** Remaining model turns allowed before giving up. */
  turnsRemaining: number;
  /** Number of tool calls actually executed so far. 0 = pure prose run. */
  toolCallsExecuted: number;
  /**
   * Tool calls that ended in a hard failure (non-zero exit, executor error) or
   * were denied by policy. A run that genuinely TRIED and was blocked may
   * report the failure honestly instead of looping until the budget runs out.
   */
  failedToolCalls?: number;
}

export interface GateOutput {
  decision: CompletionDecision;
  reason?: string;
  /** Corrective instruction to append as the next user turn (continue only). */
  correctiveInstruction?: string;
}

const EMPTY_EVIDENCE: CompletionEvidence = {
  successfulMutations: 0,
  successfulExecutions: 0,
  verificationsPassed: 0,
  testsPassed: 0,
};

export function emptyEvidence(): CompletionEvidence {
  return { ...EMPTY_EVIDENCE };
}

/** True when no tool has produced any verified side effect yet. */
export function isEvidenceEmpty(evidence: CompletionEvidence): boolean {
  return (
    evidence.successfulMutations === 0 &&
    evidence.successfulExecutions === 0 &&
    evidence.verificationsPassed === 0 &&
    evidence.testsPassed === 0
  );
}

function firstUnmetRequirement(
  requirements: TaskRequirement,
  evidence: CompletionEvidence,
): { reason: string; correctiveInstruction: string } | null {
  // A successful command (shell, delegation) is a real action on the workspace
  // too — the model may have created the file through it. What must NOT pass is
  // prose-only, which is why BOTH counters have to be zero to keep looping.
  if (
    requirements.mutationRequired &&
    evidence.successfulMutations === 0 &&
    evidence.successfulExecutions === 0
  ) {
    return {
      reason: "Mutation required but none succeeded",
      correctiveInstruction:
        "The task requires modifying the workspace, but no write/edit/apply_patch tool has succeeded yet. Call write_file, edit_file, or apply_patch now — or, if you only provided code, say you provided code and do NOT claim a file was created.",
    };
  }

  if (requirements.executionRequired && evidence.successfulExecutions === 0) {
    return {
      reason: "Execution required but none succeeded",
      correctiveInstruction:
        "The task requires running a command, but no shell command has exited 0 yet. Run the command with the shell tool, read stderr if it fails, fix, and re-run — then report the real exit code.",
    };
  }

  if (requirements.verificationRequired && evidence.verificationsPassed === 0 && evidence.testsPassed === 0) {
    return {
      reason: "Verification required but none passed",
      correctiveInstruction:
        "The task requires verification (e.g. typecheck, lint, or file content check), but none passed. Run the relevant verification command and report its real result.",
    };
  }

  if (requirements.testRequired && evidence.testsPassed === 0) {
    return {
      reason: "Tests required but none passed",
      correctiveInstruction:
        "The task requires passing tests, but no test run has passed yet. Run the test command, read the failure, fix the relevant code, and re-run until they pass — or state clearly which tests are still failing.",
    };
  }

  return null;
}

/**
 * Pure decision function. Tool calls are progress, not proof of completion.
 * The loop therefore continues after planning text, partial execution, or a
 * model that asks to continue until every required evidence category is met.
 */
export function evaluateCompletionGate(input: GateInput): GateOutput {
  const unmet = firstUnmetRequirement(input.requirements, input.evidence);
  if (!unmet) {
    return { decision: "complete" };
  }

  // 1. A tool that FAILED or was DENIED is a genuine dead end: the model must
  //    be allowed to report it honestly instead of being trapped in the loop.
  if ((input.failedToolCalls ?? 0) > 0) {
    return { decision: "complete" };
  }

  // 2. Out of turns. With verified side effects on record the model has done
  //    real work and may report honestly; with NONE it is a prose run that
  //    must not be allowed to claim success.
  if (input.turnsRemaining <= 0) {
    if (!isEvidenceEmpty(input.evidence)) return { decision: "complete" };
    return {
      decision: "continue",
      reason: `Turns remaining exhausted before requirements met: ${unmet.reason}`,
      correctiveInstruction:
        "You are out of turns. Do NOT claim the task succeeded. Report exactly which tools ran and what remains.",
    };
  }

  // 3. Repeated tool attempts that produced NO verifiable outcome are a real
  //    failure too. A single call does NOT qualify: one stray/planning call must
  //    never end an unfinished task, which is exactly what this gate prevents.
  if (input.toolCallsExecuted >= 2 && isEvidenceEmpty(input.evidence)) {
    return { decision: "complete" };
  }

  // 4. Partial progress with budget left, or a prose-only answer: continue.
  return {
    decision: "continue",
    reason: unmet.reason,
    correctiveInstruction: unmet.correctiveInstruction,
  };
}

/**
 * Record a verified mutation/execution/verification/test outcome into a
 * mutable evidence object. Guard clauses keep out-of-contract inputs inert.
 */
export function recordEvidence(
  evidence: CompletionEvidence,
  kind: "mutation" | "execution" | "verification" | "test",
  ok: boolean
): void {
  if (!ok) return;
  switch (kind) {
    case "mutation":
      evidence.successfulMutations++;
      break;
    case "execution":
      evidence.successfulExecutions++;
      break;
    case "verification":
      evidence.verificationsPassed++;
      break;
    case "test":
      evidence.testsPassed++;
      break;
  }
}

/**
 * Parse a user prompt into task requirements. Conservative: any signal of a
 * mutation/execution/test request flips the flag so the gate blocks text-only
 * answers to actionable requests.
 */
export function parseTaskRequirements(prompt: string): TaskRequirement {
  const p = prompt.toLowerCase();

  // Mutation: explicit create/write/edit verbs or a concrete file path with a
  // known source extension. Words like "test" used as a topic ("Test session
  // persistence") do NOT imply a mutation.
  const mutationRequired =
    /\b(tạo|create|sửa|fix|edit|update|thay đổi|change|viết|write|thêm|add|patch|refactor|implement)\b/.test(p) ||
    /\b[\w\-./]+?\.(py|ts|js|go|rs|java|cs|php|rb|swift|kt|scala|sh)\b/.test(p);

  // Execution: a run/execute/build verb. A bare "test" as a topic is not a
  // command; only explicit test-command patterns count below.
  const executionRequired =
    /\b(chạy|run|execute|build|typecheck|lint|compile)\b/.test(p) ||
    /\b(chạy thử|run it|run the|chạy file|để nó chạy)\b/.test(p);

  // Test: only concrete test invocations, never the word "test" as a topic.
  const testRequired =
    /\b(bun test|npm test|yarn test|pnpm test|pytest|jest|vitest|go test|cargo test|mvn test|dotnet test|gradlew test|rspec|phpunit|chạy test|run tests|run the tests)\b/.test(p);

  const verificationRequired =
    testRequired ||
    /\b(typecheck|tsc --noemit|tsc -b|lint|ruff check|mypy|go vet|shellcheck)\b/.test(p);

  return {
    mutationRequired,
    executionRequired,
    verificationRequired,
    testRequired,
  };
}
