import { describe, expect, test } from "bun:test";
import {
  emptyEvidence,
  evaluateCompletionGate,
  recordEvidence,
} from "../completionGate";

const actionable = {
  mutationRequired: true,
  executionRequired: true,
  verificationRequired: true,
  testRequired: true,
};

function gate(
  evidence = emptyEvidence(),
  turnsRemaining = 2,
  toolCallsExecuted = 0,
) {
  return evaluateCompletionGate({
    requirements: actionable,
    evidence,
    proposedAnswer: "I will continue the work",
    turnsRemaining,
    toolCallsExecuted,
  });
}

describe("completion gate — task state, not turn shape", () => {
  test("planning text with no tool calls continues", () => {
    const result = gate(emptyEvidence(), 2, 0);
    expect(result.decision).toBe("continue");
    expect(result.reason).toContain("Mutation required");
  });

  test("planning sentence ending in a colon still continues", () => {
    const result = evaluateCompletionGate({
      requirements: actionable,
      evidence: emptyEvidence(),
      proposedAnswer: "I will now create the project:",
      turnsRemaining: 2,
      toolCallsExecuted: 0,
    });
    expect(result.decision).toBe("continue");
  });

  test("text-only answer without verified criteria continues", () => {
    expect(gate(emptyEvidence(), 2, 0).decision).toBe("continue");
  });

  test("a model asking to continue after authorized work continues", () => {
    const result = evaluateCompletionGate({
      requirements: actionable,
      evidence: emptyEvidence(),
      proposedAnswer: "Bạn muốn tôi tiếp tục không?",
      turnsRemaining: 3,
      toolCallsExecuted: 1,
    });
    expect(result.decision).toBe("continue");
    expect(result.reason).toContain("Mutation required");
  });

  test("all verified requirements terminate cleanly", () => {
    const evidence = emptyEvidence();
    recordEvidence(evidence, "mutation", true);
    recordEvidence(evidence, "execution", true);
    recordEvidence(evidence, "verification", true);
    recordEvidence(evidence, "test", true);
    expect(gate(evidence, 1, 4).decision).toBe("complete");
  });

  test("partial tool work does not masquerade as completion", () => {
    const evidence = emptyEvidence();
    recordEvidence(evidence, "mutation", true);
    recordEvidence(evidence, "execution", true);
    const result = gate(evidence, 2, 2);
    expect(result.decision).toBe("continue");
    expect(result.reason).toContain("Verification required");
  });

  test("approval/missing mandatory information is a blocker, not success", () => {
    const result = evaluateCompletionGate({
      requirements: actionable,
      evidence: emptyEvidence(),
      proposedAnswer: "Approval is required before continuing.",
      turnsRemaining: 2,
      toolCallsExecuted: 1,
    });
    expect(result.decision).toBe("continue");
    expect(result.reason).toContain("Mutation required");
  });

  test("unrecoverable failure is not accepted as a final answer", () => {
    const result = evaluateCompletionGate({
      requirements: actionable,
      evidence: emptyEvidence(),
      proposedAnswer: "The tool failed and cannot be recovered.",
      turnsRemaining: 2,
      toolCallsExecuted: 1,
    });
    expect(result.decision).toBe("continue");
  });

  test("max-turn exhaustion returns a loud continuation reason", () => {
    const result = gate(emptyEvidence(), 0, 1);
    expect(result.decision).toBe("continue");
    expect(result.reason).toContain("Turns remaining exhausted");
    expect(result.correctiveInstruction).toContain("Do NOT claim");
  });
});
