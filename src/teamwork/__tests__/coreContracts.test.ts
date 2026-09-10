/**
 * Unit tests for the Phase 73 core modules.
 *
 *   §73.1  contracts (ToolResult builders)
 *   §73.4  ToolCallStateStore lifecycle (pending → running → completed/error)
 *   §73.7  capability resolution (native | structured | none)
 *   §73.9  Completion Gate (requirements, evidence, corrective turns)
 */

import { test, expect, describe } from "bun:test";
import {
  okToolResult,
  errToolResult,
  type CompletionEvidence,
  type ToolResult,
} from "../../core/contracts";
import {
  ToolCallStateStore,
  isValidTransition,
} from "../../core/agent/toolCallState";
import {
  resolveToolCalling,
  normalizeCapabilities,
  toolCallingFromLegacy,
  shouldExposeTools,
} from "../../core/llm/capabilities";
import {
  emptyEvidence,
  evaluateCompletionGate,
  parseTaskRequirements,
  recordEvidence,
} from "../../core/agent/completionGate";

// ── §73.1 Contracts ─────────────────────────────────────────────────────────

describe("contracts — ToolResult builders", () => {
  test("okToolResult defaults ok=true and merges partial fields", () => {
    const result = okToolResult({ stdout: "hello", exitCode: 0 });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  test("errToolResult marks ok=false with exitCode 1 and stderr", () => {
    const result = errToolResult("permission denied");
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe("permission denied");
    expect(result.exitCode).toBe(1);
  });

  test("errToolResult allows metadata to be added without losing the error", () => {
    const result = errToolResult("boom", { metadata: { tool: "bash" } });
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe("boom");
    expect(result.metadata).toEqual({ tool: "bash" });
  });
});

// ── §73.4 Tool Call State ───────────────────────────────────────────────────

describe("ToolCallStateStore — lifecycle", () => {
  test("begin starts a call in pending state", () => {
    const store = new ToolCallStateStore();
    const state = store.begin("c1", "write_file", { path: "a.ts" });
    expect(state.status).toBe("pending");
    expect(state.startedAt).toBeUndefined();
    expect(store.get("c1")).toBe(state);
  });

  test("running stamps startedAt and completed stamps endedAt", () => {
    const store = new ToolCallStateStore();
    store.begin("c1", "write_file", {});
    store.markRunning("c1");
    expect(store.get("c1")!.status).toBe("running");
    expect(store.get("c1")!.startedAt).toBeGreaterThan(0);

    const output: ToolResult = okToolResult({ verification: { ok: true } });
    store.complete("c1", output);
    expect(store.get("c1")!.status).toBe("completed");
    expect(store.get("c1")!.endedAt).toBeGreaterThan(0);
    expect(store.get("c1")!.verification).toEqual({ ok: true });
  });

  test("fail records the error and moves to error state", () => {
    const store = new ToolCallStateStore();
    store.begin("c1", "bash", {});
    store.markRunning("c1");
    store.fail("c1", "exit code 1");
    expect(store.get("c1")!.status).toBe("error");
    expect(store.get("c1")!.error).toBe("exit code 1");
  });

  test("permission decisions are recorded without changing status", () => {
    const store = new ToolCallStateStore();
    store.begin("c1", "bash", {});
    store.setPermission("c1", "DENY");
    expect(store.get("c1")!.permission).toBe("DENY");
    expect(store.get("c1")!.status).toBe("pending");
  });

  test("out-of-contract transitions are ignored (completed → running)", () => {
    const store = new ToolCallStateStore();
    store.begin("c1", "bash", {});
    store.markRunning("c1");
    store.complete("c1", okToolResult());
    store.markRunning("c1");
    expect(store.get("c1")!.status).toBe("completed");
  });

  test("operations on unknown call ids are inert (no throw)", () => {
    const store = new ToolCallStateStore();
    expect(() => store.markRunning("missing")).not.toThrow();
    expect(() => store.complete("missing", okToolResult())).not.toThrow();
    expect(store.get("missing")).toBeUndefined();
  });

  test("isValidTransition encodes the documented lifecycle", () => {
    expect(isValidTransition("pending", "running")).toBe(true);
    expect(isValidTransition("running", "completed")).toBe(true);
    expect(isValidTransition("running", "error")).toBe(true);
    expect(isValidTransition("pending", "cancelled")).toBe(true);
    expect(isValidTransition("completed", "running")).toBe(false);
    expect(isValidTransition("error", "completed")).toBe(false);
  });
});

// ── §73.7 Capability resolution ─────────────────────────────────────────────

describe("capability resolution — native | structured | none", () => {
  test("explicit toolCalling mode always wins", () => {
    expect(resolveToolCalling({ tools: true, toolCalling: "none" })).toBe("none");
    expect(resolveToolCalling({ tools: false, toolCalling: "native" })).toBe("native");
  });

  test("tools:false maps to none (model never receives schemas)", () => {
    expect(resolveToolCalling({ tools: false })).toBe("none");
    expect(shouldExposeTools("none")).toBe(false);
  });

  test("nativeToolCalls:true maps to native", () => {
    expect(resolveToolCalling({ nativeToolCalls: true })).toBe("native");
    expect(shouldExposeTools("native")).toBe(true);
  });

  test("nativeToolCalls:false maps to structured (JSON action protocol)", () => {
    expect(resolveToolCalling({ nativeToolCalls: false })).toBe("structured");
    expect(shouldExposeTools("structured")).toBe(true);
  });

  test("unknown metadata is conservative: structured, never native", () => {
    expect(resolveToolCalling({})).toBe("structured");
  });

  test("normalizeCapabilities fills defaults deterministically", () => {
    const caps = normalizeCapabilities({ tools: true, nativeToolCalls: true, reasoning: true });
    expect(caps.toolCalling).toBe("native");
    expect(caps.reasoning).toBe(true);
    // Reasoning models stream their reasoning summary by default.
    expect(caps.reasoningStream).toBe(true);
    expect(caps.streaming).toBe(true);
    expect(caps.vision).toBe(false);
  });

  test("toolCallingFromLegacy mirrors the legacy provider booleans", () => {
    expect(toolCallingFromLegacy(false, undefined)).toBe("none");
    expect(toolCallingFromLegacy(true, true)).toBe("native");
    expect(toolCallingFromLegacy(true, false)).toBe("structured");
    expect(toolCallingFromLegacy(undefined, undefined)).toBe("structured");
  });
});

// ── §73.9 Completion Gate ───────────────────────────────────────────────────

describe("parseTaskRequirements", () => {
  test("create/write prompts require a mutation", () => {
    expect(parseTaskRequirements("Tạo file hello.py").mutationRequired).toBe(true);
    expect(parseTaskRequirements("create test.py and run it").mutationRequired).toBe(true);
    expect(parseTaskRequirements("sửa lỗi trong src/index.ts").mutationRequired).toBe(true);
  });

  test("bare 'test' as a topic does not request a command or mutation", () => {
    const req = parseTaskRequirements("Test session persistence integrity");
    expect(req.testRequired).toBe(false);
    expect(req.executionRequired).toBe(false);
    expect(req.mutationRequired).toBe(false);
  });

  test("explicit test commands request tests", () => {
    expect(parseTaskRequirements("bun test auth").testRequired).toBe(true);
    expect(parseTaskRequirements("run pytest").testRequired).toBe(true);
  });

  test("run/build prompts require execution", () => {
    expect(parseTaskRequirements("chạy thử hello.py").executionRequired).toBe(true);
    expect(parseTaskRequirements("build the project").executionRequired).toBe(true);
  });

  test("typecheck/lint prompts require verification", () => {
    expect(parseTaskRequirements("typecheck the project").verificationRequired).toBe(true);
  });

  test("pure question requires nothing", () => {
    const req = parseTaskRequirements("What language is this project written in?");
    expect(req).toEqual({
      mutationRequired: false,
      executionRequired: false,
      verificationRequired: false,
      testRequired: false,
    });
  });
});

describe("recordEvidence", () => {
  test("only ok=true counts toward evidence", () => {
    const evidence = emptyEvidence();
    recordEvidence(evidence, "mutation", true);
    recordEvidence(evidence, "mutation", false);
    expect(evidence.successfulMutations).toBe(1);
  });

  test("each kind increments its own counter", () => {
    const evidence = emptyEvidence();
    recordEvidence(evidence, "mutation", true);
    recordEvidence(evidence, "execution", true);
    recordEvidence(evidence, "verification", true);
    recordEvidence(evidence, "test", true);
    expect(evidence).toEqual({
      successfulMutations: 1,
      successfulExecutions: 1,
      verificationsPassed: 1,
      testsPassed: 1,
    });
  });
});

describe("evaluateCompletionGate", () => {
  const noRequirements = {
    mutationRequired: false,
    executionRequired: false,
    verificationRequired: false,
    testRequired: false,
  };

  function gate(overrides: Partial<Parameters<typeof evaluateCompletionGate>[0]> = {}) {
    return evaluateCompletionGate({
      requirements: noRequirements,
      evidence: emptyEvidence(),
      proposedAnswer: "",
      turnsRemaining: 3,
      toolCallsExecuted: 0,
      ...overrides,
    });
  }

  test("mutation required + no successful mutation → continue", () => {
    const out = gate({ requirements: { ...noRequirements, mutationRequired: true } });
    expect(out.decision).toBe("continue");
    expect(out.reason).toContain("Mutation required");
    expect(out.correctiveInstruction).toBeTruthy();
  });

  test("mutation required + verified mutation → complete", () => {
    const evidence: CompletionEvidence = { ...emptyEvidence(), successfulMutations: 1 };
    const out = gate({
      requirements: { ...noRequirements, mutationRequired: true },
      evidence,
    });
    expect(out.decision).toBe("complete");
  });

  test("execution required + no shell result → continue", () => {
    const out = gate({ requirements: { ...noRequirements, executionRequired: true } });
    expect(out.decision).toBe("continue");
    expect(out.reason).toContain("Execution required");
  });

  test("tests required + none passed → continue", () => {
    const out = gate({ requirements: { ...noRequirements, testRequired: true } });
    expect(out.decision).toBe("continue");
    expect(out.reason).toContain("Tests required");
  });

  test("a genuine tool attempt may finish honestly, even on failure", () => {
    // The gate exists to stop prose-only success claims — not to trap a model
    // that already ran tools and now needs to report a failure.
    const out = gate({ toolCallsExecuted: 2, requirements: { ...noRequirements, mutationRequired: true } });
    expect(out.decision).toBe("complete");
  });

  test("out of turns yields a continue decision with an honest-report nudge", () => {
    const out = gate({ turnsRemaining: 0, requirements: { ...noRequirements, mutationRequired: true } });
    expect(out.decision).toBe("continue");
    expect(out.correctiveInstruction).toContain("Do NOT claim the task succeeded");
  });

  test("no requirements → complete", () => {
    expect(gate().decision).toBe("complete");
  });
});
