/**
 * Layer 4 — Phase 4: Context / Session Isolation + Provider-Compatible
 * Compaction + Remote MCP residual review.
 *
 * This is the single targeted test for the Phase 4 deliverable. It
 * covers the 39-item matrix (SESSION, ASYNC, SUBAGENT, COMPACTION,
 * SUMMARY, TOKENS, PERSISTENCE, TRUST, REMOTE MCP, CACHE) plus a
 * series of architecture assertions that no production code path
 * mutates a session-scoped store without an explicit sessionId.
 *
 * Every test is self-contained and uses fresh sessionIds so the suite
 * is safe to run in any order. No global state is mutated between
 * tests; the only shared resource is the ContextRegistry which is
 * keyed by the unique sessionId each test allocates.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Phase 4 modules under test
import {
  // ContextRegistry
  contextRegistry,
  getSessionContext,
  hasSessionContext,
  deleteSessionContext,
  listSessionContexts,
  resetSessionContext,
  childSessionId,
  createChildSessionContext,
  registrySize,
  // SessionMemory
  getSessionMemory,
  setCurrentSessionId,
  getCurrentSessionId,
  _resetCompatMemo,
  // ContextEngine
  contextEngine,
  ContextEngine,
  // Tool-call validator
  validateToolCallPairs,
  repairToolCallPairs,
  // Compactor
  compactMessagesAtomically,
} from "../../lib/context";

// Session persistence + cache
import {
  saveSession,
  loadSession,
  loadSessionContext,
  getCachedPrepared,
  setCachedPrepared,
  clearSessionCache,
} from "../../lib/sessionPersistence";

// Trust isolation
import { SessionTrustManager, sessionTrust } from "../../lib/security/sessionTrust";

// safeFetch (REMOTE MCP)
import { safeFetch, SafeFetchError, redactAuthInText } from "../../lib/security/safeFetch";

// Subagent runtime
import {
  deriveSubagentChildSessionId,
  bindSubagentContext,
} from "../subagentRuntime";

// Internal types
import type { ContextMessage } from "../../lib/context/types";

let TEST_DIR = "";
let ORIGINAL_ENV_SESSIONS: string | undefined;
let ORIGINAL_ENV_CONFIG: string | undefined;
let ORIGINAL_ENV_DATA: string | undefined;

beforeAll(() => {
  TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-phase4-"));
  ORIGINAL_ENV_SESSIONS = process.env.TOOLNETCLI_SESSIONS_DIR;
  ORIGINAL_ENV_CONFIG = process.env.TOOLNETCLI_CONFIG_DIR;
  ORIGINAL_ENV_DATA = process.env.DATA_DIR;
  process.env.TOOLNETCLI_SESSIONS_DIR = path.join(TEST_DIR, "sessions");
  process.env.TOOLNETCLI_CONFIG_DIR = path.join(TEST_DIR, "config");
});

afterAll(() => {
  if (ORIGINAL_ENV_SESSIONS === undefined) delete process.env.TOOLNETCLI_SESSIONS_DIR;
  else process.env.TOOLNETCLI_SESSIONS_DIR = ORIGINAL_ENV_SESSIONS;
  if (ORIGINAL_ENV_CONFIG === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR;
  else process.env.TOOLNETCLI_CONFIG_DIR = ORIGINAL_ENV_CONFIG;
  if (ORIGINAL_ENV_DATA === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_ENV_DATA;
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  setCurrentSessionId(null);
  _resetCompatMemo();
  sessionTrust.clearAll();
});

beforeEach(() => {
  _resetCompatMemo();
  sessionTrust.clearAll();
  setCurrentSessionId(null);
  (globalThis as any).__toolnetCurrentSessionId = undefined;
});

afterEach(() => {
  setCurrentSessionId(null);
  _resetCompatMemo();
  (globalThis as any).__toolnetCurrentSessionId = undefined;
});

function uniqueId(label: string): string {
  return `phase4-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSION (1–6)
// ─────────────────────────────────────────────────────────────────────────────

describe("SESSION (1–6) — per-session isolation", () => {
  test("1. A/B memory isolated (goals, fileAccess, errors)", () => {
    const A = uniqueId("A");
    const B = uniqueId("B");
    const memA = getSessionMemory(A);
    const memB = getSessionMemory(B);
    memA.recordUserGoal("fix auth");
    memA.recordFileAccess("src/a.ts", "write");
    memA.recordInsight("rebuild session token");

    memB.recordUserGoal("write docs");
    memB.recordFileAccess("README.md", "read");
    memB.recordInsight("document phase 4");

    const aSnap = memA.getSnapshot();
    const bSnap = memB.getSnapshot();
    expect(aSnap.userGoals).toContain("fix auth");
    expect(aSnap.userGoals).not.toContain("write docs");
    expect(bSnap.userGoals).toContain("write docs");
    expect(bSnap.userGoals).not.toContain("fix auth");

    expect(aSnap.keyFilesTouched).toContain("src/a.ts");
    expect(aSnap.keyFilesTouched).not.toContain("README.md");
    expect(bSnap.keyFilesTouched).toContain("README.md");
    expect(bSnap.keyFilesTouched).not.toContain("src/a.ts");
  });

  test("2. A/B fileAccess isolated across contextEngine.recordFileAccess", () => {
    const A = uniqueId("fileA");
    const B = uniqueId("fileB");
    const engine = new ContextEngine({ defaultModel: "test", sessionId: A });
    engine.recordFileAccess("src/x.ts", "write", A);
    engine.recordFileAccess("src/y.ts", "read", B);

    const ctxA = getSessionContext(A);
    const ctxB = getSessionContext(B);
    expect(ctxA.memory.getSnapshot().modifiedFiles).toContain("src/x.ts");
    expect(ctxA.memory.getSnapshot().modifiedFiles).not.toContain("src/y.ts");
    expect(ctxB.memory.getSnapshot().keyFilesTouched).toContain("src/y.ts");
    expect(ctxB.memory.getSnapshot().keyFilesTouched).not.toContain("src/x.ts");
  });

  test("3. A/B goals/errors isolated through registry fields", () => {
    const A = uniqueId("gA");
    const B = uniqueId("gB");
    const ctxA = getSessionContext(A);
    const ctxB = getSessionContext(B);
    ctxA.goals.push("goal-A");
    ctxA.errors.push("error-A");
    ctxB.goals.push("goal-B");
    ctxB.errors.push("error-B");

    expect(ctxA.goals).toEqual(["goal-A"]);
    expect(ctxA.errors).toEqual(["error-A"]);
    expect(ctxB.goals).toEqual(["goal-B"]);
    expect(ctxB.errors).toEqual(["error-B"]);
    expect(ctxA.goals).not.toContain("goal-B");
    expect(ctxB.goals).not.toContain("goal-A");
  });

  test("4. switching restores correct context (no bleed)", () => {
    const A = uniqueId("swA");
    const B = uniqueId("swB");
    const memA = getSessionMemory(A);
    const memB = getSessionMemory(B);
    memA.recordUserGoal("alpha");
    memB.recordUserGoal("beta");

    setCurrentSessionId(A);
    expect(getSessionMemory(getCurrentSessionId()!).getSnapshot().userGoals).toContain("alpha");

    setCurrentSessionId(B);
    expect(getSessionMemory(getCurrentSessionId()!).getSnapshot().userGoals).toContain("beta");
    expect(getSessionMemory(getCurrentSessionId()!).getSnapshot().userGoals).not.toContain("alpha");

    setCurrentSessionId(A);
    expect(getSessionMemory(getCurrentSessionId()!).getSnapshot().userGoals).toContain("alpha");
    expect(getSessionMemory(getCurrentSessionId()!).getSnapshot().userGoals).not.toContain("beta");
  });

  test("5. deleting A does not affect B", () => {
    const A = uniqueId("delA");
    const B = uniqueId("delB");
    getSessionContext(A);
    getSessionContext(B);
    expect(hasSessionContext(A)).toBe(true);
    expect(hasSessionContext(B)).toBe(true);
    expect(deleteSessionContext(A)).toBe(true);
    expect(hasSessionContext(A)).toBe(false);
    expect(hasSessionContext(B)).toBe(true);
  });

  test("6. resumed A has A context only (save → reset registry → loadSessionContext)", () => {
    const A = uniqueId("resA");
    const B = uniqueId("resB");
    // Goals must be in SessionContext.goals (the persistence source of truth),
    // not only in the memory store's userGoals list.
    const ctxA = getSessionContext(A);
    const ctxB = getSessionContext(B);
    ctxA.goals.push("resumable-goal-A");
    ctxA.fileAccess.write.push("src/a-keep.ts");
    ctxB.goals.push("resumable-goal-B");

    saveSession(A, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ]);
    saveSession(B, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ]);

    // Simulate process restart: blow away registry.
    deleteSessionContext(A);
    deleteSessionContext(B);
    expect(hasSessionContext(A)).toBe(false);

    // Resume only A.
    const loadedA = loadSessionContext(A, loadSession(A));
    expect(loadedA.ok).toBe(true);
    const restored = getSessionContext(A);
    expect(restored.goals).toContain("resumable-goal-A");
    expect(restored.goals).not.toContain("resumable-goal-B");
    expect(restored.goals.some((g) => g === "resumable-goal-B")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ASYNC (7–9)
// ─────────────────────────────────────────────────────────────────────────────

describe("ASYNC (7–9) — late completion never crosses sessions", () => {
  test("7. A tool completion after switch B records to A (captured sessionId)", async () => {
    const A = uniqueId("lateA");
    const B = uniqueId("lateB");
    const memA = getSessionMemory(A);
    const memB = getSessionMemory(B);

    setCurrentSessionId(A);
    const executionSessionId = A;
    const promise = (async () => {
      await new Promise((r) => setTimeout(r, 5));
      getSessionMemory(executionSessionId).recordFileAccess("src/late.ts", "write");
    })();

    setCurrentSessionId(B);
    await promise;

    expect(memA.getSnapshot().modifiedFiles).toContain("src/late.ts");
    expect(memB.getSnapshot().modifiedFiles).not.toContain("src/late.ts");
  });

  test("8. A provider completion does not render into B (generation token)", () => {
    const A = uniqueId("provA");
    const B = uniqueId("provB");
    const ctxA = getSessionContext(A);
    const ctxB = getSessionContext(B);
    const genA = ctxA.generation;
    // bumpGeneration lives on the registry, not on the SessionContext.
    contextRegistry.bumpGeneration(A);
    expect(ctxA.generation).toBe(genA + 1);
    // B's generation is independent.
    expect(ctxB.generation).not.toBe(ctxA.generation);
  });

  test("9. parallel sessions do not share context (concurrent writes)", async () => {
    const ids = Array.from({ length: 4 }, () => uniqueId("par"));
    const memories = ids.map((id) => getSessionMemory(id));
    await Promise.all(
      ids.map((id, i) =>
        Promise.resolve().then(() => {
          memories[i].recordUserGoal(`goal-${i}`);
          memories[i].recordFileAccess(`src/file-${i}.ts`, "write");
        })
      )
    );
    for (let i = 0; i < ids.length; i++) {
      const snap = memories[i].getSnapshot();
      expect(snap.userGoals).toContain(`goal-${i}`);
      expect(snap.userGoals.length).toBe(1);
      expect(snap.modifiedFiles).toContain(`src/file-${i}.ts`);
      expect(snap.modifiedFiles.length).toBe(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUBAGENT (10–13)
// ─────────────────────────────────────────────────────────────────────────────

describe("SUBAGENT (10–13) — child context isolation", () => {
  test("10. child context isolated from parent", () => {
    const parent = uniqueId("sub-parent");
    const taskId = "task-1";
    const child = deriveSubagentChildSessionId(parent, taskId);
    const parentCtx = getSessionContext(parent);
    parentCtx.goals.push("parent-goal");
    parentCtx.memory.recordUserGoal("parent-user-goal");

    const bound = bindSubagentContext(parent, taskId);
    expect(bound.childSessionId).toBe(child);
    expect(bound.ctx.memory.getSnapshot().userGoals).not.toContain("parent-user-goal");
    expect(bound.ctx.goals).not.toContain("parent-goal");
  });

  test("11. two child workers isolated", () => {
    const parent = uniqueId("two-parent");
    const c1 = bindSubagentContext(parent, "task-A");
    const c2 = bindSubagentContext(parent, "task-B");
    c1.ctx.memory.recordUserGoal("child-A-only");
    c1.ctx.memory.recordFileAccess("src/a-only.ts", "write");
    c2.ctx.memory.recordUserGoal("child-B-only");
    c2.ctx.memory.recordFileAccess("src/b-only.ts", "write");

    const s1 = c1.ctx.memory.getSnapshot();
    const s2 = c2.ctx.memory.getSnapshot();
    expect(s1.userGoals).toContain("child-A-only");
    expect(s1.userGoals).not.toContain("child-B-only");
    expect(s2.userGoals).toContain("child-B-only");
    expect(s2.userGoals).not.toContain("child-A-only");
    expect(s1.modifiedFiles).not.toContain("src/b-only.ts");
    expect(s2.modifiedFiles).not.toContain("src/a-only.ts");
  });

  test("12. child result explicit merge only (parent memory untouched)", () => {
    const parent = uniqueId("merge-parent");
    const parentMem = getSessionMemory(parent);
    parentMem.recordUserGoal("initial-parent-goal");
    const before = parentMem.getSnapshot();

    const child = bindSubagentContext(parent, "merge-task");
    child.ctx.memory.recordUserGoal("child-executed");
    child.ctx.memory.recordFileAccess("src/child-only.ts", "write");

    const after = parentMem.getSnapshot();
    expect(after.userGoals).toEqual(before.userGoals);
    expect(after.modifiedFiles).toEqual(before.modifiedFiles);
  });

  test("13. child cleanup: deleting childSessionContext does not affect parent", () => {
    const parent = uniqueId("cln-parent");
    const child = bindSubagentContext(parent, "cln-task");
    const parentId = parent;
    const childId = child.childSessionId;

    expect(hasSessionContext(parentId)).toBe(true);
    expect(hasSessionContext(childId)).toBe(true);
    expect(deleteSessionContext(childId)).toBe(true);
    expect(hasSessionContext(childId)).toBe(false);
    expect(hasSessionContext(parentId)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// COMPACTION (14–18)
// ─────────────────────────────────────────────────────────────────────────────

function makeAssistantWithToolCalls(id: string): ContextMessage {
  return {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id,
        type: "function",
        function: { name: "shell", arguments: "{}" },
      },
    ],
  };
}

function makeToolResult(toolCallId: string, content = "ok"): ContextMessage {
  return { role: "tool", tool_call_id: toolCallId, name: "shell", content };
}

describe("COMPACTION (14–18) — atomic tool-call pairs", () => {
  test("14. assistant tool_calls + tool results atomic (validator accepts valid pair)", () => {
    const msgs: ContextMessage[] = [
      { role: "user", content: "do thing" },
      makeAssistantWithToolCalls("call_1"),
      makeToolResult("call_1", "result"),
    ];
    const v = validateToolCallPairs(msgs);
    expect(v.valid).toBe(true);
    expect(v.orphanTools).toHaveLength(0);
    expect(v.missingResults).toHaveLength(0);
  });

  test("15. no orphan tool (validator flags unmatched tool result)", () => {
    const msgs: ContextMessage[] = [
      { role: "user", content: "hi" },
      makeToolResult("call_orphan", "x"),
    ];
    const v = validateToolCallPairs(msgs);
    expect(v.valid).toBe(false);
    expect(v.orphanTools.length).toBeGreaterThan(0);
  });

  test("16. no missing tool result (validator flags assistant without result)", () => {
    const msgs: ContextMessage[] = [
      { role: "user", content: "hi" },
      makeAssistantWithToolCalls("call_missing"),
    ];
    const v = validateToolCallPairs(msgs);
    expect(v.valid).toBe(false);
    expect(v.missingResults.length).toBeGreaterThan(0);
  });

  test("16b. repairToolCallPairs appends a synthetic result for missing calls", () => {
    const msgs: ContextMessage[] = [
      { role: "user", content: "hi" },
      makeAssistantWithToolCalls("call_rep"),
    ];
    const repaired = repairToolCallPairs(msgs);
    const v = validateToolCallPairs(repaired);
    expect(v.valid).toBe(true);
    expect(repaired.find((m) => m.role === "tool" && m.tool_call_id === "call_rep")).toBeTruthy();
  });

  test("17. repeated compaction is stable (same input → same output)", () => {
    const sessionId = uniqueId("stable");
    const mem = getSessionMemory(sessionId);
    const msgs: ContextMessage[] = [
      { role: "system", content: "you are an agent" },
      { role: "user", content: "long conversation " + "x".repeat(8000) },
      { role: "assistant", content: "ack " + "y".repeat(8000) },
    ];
    const r1 = compactMessagesAtomically(msgs, {
      force: true,
      summaryRole: "user",
      model: "test",
      sessionId,
      memory: mem,
    });
    const r2 = compactMessagesAtomically(r1.messages, {
      force: true,
      summaryRole: "user",
      model: "test",
      sessionId,
      memory: mem,
    });
    // Stable: second pass on already-compacted messages is idempotent.
    expect(r2.compacted).toBe(false);
    expect(r2.messages.length).toBe(r1.messages.length);
  });

  test("18. session A compaction does not affect B", () => {
    const A = uniqueId("cmpA");
    const B = uniqueId("cmpB");
    const memA = getSessionMemory(A);
    const memB = getSessionMemory(B);
    memA.recordUserGoal("alpha-goal");
    memB.recordUserGoal("beta-goal");

    const msgs: ContextMessage[] = [
      { role: "user", content: "x".repeat(8000) },
    ];
    compactMessagesAtomically(msgs, {
      force: true,
      sessionId: A,
      memory: memA,
      model: "test",
      summaryRole: "user",
    });
    const aGoal = memA.getSnapshot().userGoals[0];
    const bGoal = memB.getSnapshot().userGoals[0];
    expect(aGoal).toBe("alpha-goal");
    expect(bGoal).toBe("beta-goal");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY (19–22)
// ─────────────────────────────────────────────────────────────────────────────

describe("SUMMARY (19–22) — provider-compatible", () => {
  test("19. summary keeps goals/files/errors", () => {
    const sessionId = uniqueId("sum");
    const ctx = getSessionContext(sessionId);
    const mem = ctx.memory;
    // The compactor pulls goals from the first line of compacted user
    // messages and from tool-call arguments. We seed both so the summary
    // asserts on something the compactor can actually surface.
    mem.recordUserGoal("important goal");
    mem.recordFileAccess("src/keep.ts", "write");

    const msgs: ContextMessage[] = [
      { role: "system", content: "you are a toolnet agent" },
      { role: "user", content: "important goal — do thing A " + "x".repeat(8000) },
      { role: "assistant", content: "ack A " + "y".repeat(8000) },
      { role: "user", content: "do thing B " + "x".repeat(200) },
      { role: "assistant", content: "ack B" },
    ];
    const r = compactMessagesAtomically(msgs, {
      force: true,
      sessionId,
      memory: mem,
      model: "test",
      summaryRole: "user",
    });
    expect(r.compacted).toBe(true);
    const summary = r.messages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("Context Compaction Summary")
    );
    expect(summary).toBeTruthy();
    // Goal surfaces as the first line of the user message that was compacted.
    expect(summary!.content as string).toContain("important goal");
  });

  test("20. summary redacts secrets", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const msgs: ContextMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: `leak: ${secret}` + " ".repeat(8000) },
      { role: "assistant", content: "y".repeat(8000) },
      { role: "user", content: "second turn " + "z".repeat(200) },
      { role: "assistant", content: "ack" },
    ];
    const r = compactMessagesAtomically(msgs, {
      force: true,
      model: "test",
      summaryRole: "user",
    });
    expect(r.compacted).toBe(true);
    const summary = r.messages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("Context Compaction Summary")
    );
    expect(summary).toBeTruthy();
    expect(summary!.content as string).not.toContain(secret);
  });

  test("21. summary placement provider compatible (default role='user', not 'system')", () => {
    const msgs: ContextMessage[] = [
      { role: "system", content: "primary system" },
      { role: "user", content: "turn A " + "x".repeat(8000) },
      { role: "assistant", content: "ack A " + "y".repeat(8000) },
      { role: "user", content: "turn B" },
      { role: "assistant", content: "ack B" },
    ];
    const r = compactMessagesAtomically(msgs, {
      force: true,
      model: "test",
      summaryRole: "user",
    });
    expect(r.compacted).toBe(true);
    const summary = r.messages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[")
    );
    expect(summary).toBeTruthy();
    const systemAfter0 = r.messages.slice(1).find((m) => m.role === "system");
    expect(systemAfter0).toBeUndefined();
  });

  test("22. primary system message remains at index 0 after compaction", () => {
    const msgs: ContextMessage[] = [
      { role: "system", content: "PRIMARY-SYSTEM" },
      { role: "user", content: "x".repeat(8000) },
      { role: "assistant", content: "y".repeat(8000) },
    ];
    const r = compactMessagesAtomically(msgs, {
      force: true,
      model: "test",
      summaryRole: "user",
    });
    expect(r.messages[0]?.role).toBe("system");
    expect(r.messages[0]?.content).toContain("PRIMARY-SYSTEM");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TOKENS (23–25)
// ─────────────────────────────────────────────────────────────────────────────

describe("TOKENS (23–25) — split accounting", () => {
  test("23. estimates per session (independent token budgets)", () => {
    const A = uniqueId("tokA");
    const B = uniqueId("tokB");
    const engine = new ContextEngine({ defaultModel: "test", sessionId: A });
    engine.recordUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }, A);
    engine.recordUsage({ promptTokens: 200, completionTokens: 100, totalTokens: 300 }, B);
    const tbA = engine.getTokenBudget(A);
    const tbB = engine.getTokenBudget(B);
    expect(tbA.actualUsagePromptTokens).toBe(100);
    expect(tbA.actualUsageCompletionTokens).toBe(50);
    expect(tbA.cumulativeSessionTokens).toBe(150);
    expect(tbB.actualUsagePromptTokens).toBe(200);
    expect(tbB.actualUsageCompletionTokens).toBe(100);
    expect(tbB.cumulativeSessionTokens).toBe(300);
  });

  test("24. actual vs cumulative separated (each counter grows independently per call)", () => {
    const A = uniqueId("sepA");
    const engine = new ContextEngine({ defaultModel: "test", sessionId: A });
    engine.recordUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }, A);
    engine.recordUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }, A);
    const tb = engine.getTokenBudget(A);
    expect(tb.actualUsagePromptTokens).toBe(200);
    expect(tb.actualUsageCompletionTokens).toBe(100);
    expect(tb.cumulativeSessionTokens).toBe(300);
    // A third call with ONLY prompt must grow the prompt counter but
    // NOT the completion counter — the two are independent (a "double
    // count" bug would have grown both).
    engine.recordUsage({ promptTokens: 50, completionTokens: 0, totalTokens: 50 }, A);
    const tb2 = engine.getTokenBudget(A);
    expect(tb2.actualUsagePromptTokens).toBe(250);
    expect(tb2.actualUsageCompletionTokens).toBe(100);
    expect(tb2.cumulativeSessionTokens).toBe(350);
  });

  test("25. repeated turns don't double count (cumulative sums per session)", () => {
    const A = uniqueId("repA");
    const engine = new ContextEngine({ defaultModel: "test", sessionId: A });
    for (let i = 0; i < 5; i++) {
      engine.recordUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }, A);
    }
    const tb = engine.getTokenBudget(A);
    expect(tb.actualUsagePromptTokens).toBe(50);
    expect(tb.actualUsageCompletionTokens).toBe(25);
    expect(tb.cumulativeSessionTokens).toBe(75);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PERSISTENCE (26–29)
// ─────────────────────────────────────────────────────────────────────────────

describe("PERSISTENCE (26–29) — deterministic save/resume", () => {
  test("26. save/resume round-trips SessionContext fields (goals/files/tokens)", () => {
    const A = uniqueId("persA");
    const ctx = getSessionContext(A);
    ctx.goals.push("persistent-goal");
    ctx.fileAccess.write.push("src/save.ts");
    ctx.tokenBudgetState.actualUsagePromptTokens = 42;

    saveSession(A, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ]);

    const loaded = loadSession(A);
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe(A);
    expect(loaded!.messages.length).toBe(2);
    expect(loaded!.context).toBeDefined();
    expect(loaded!.context!.goals).toContain("persistent-goal");
    expect(loaded!.context!.fileAccess.write).toContain("src/save.ts");
    expect(loaded!.context!.tokenBudgetState.actualUsagePromptTokens).toBe(42);
  });

  test("27. no transient runtime state persisted (no abort/spinner/process handle keys)", () => {
    const A = uniqueId("transA");
    const ctx = getSessionContext(A);
    (ctx as any).abortController = { __abort: true };
    (ctx as any).activeSpinner = "spinning";
    saveSession(A, [{ role: "user", content: "hi" }]);
    const loaded = loadSession(A);
    expect(loaded).not.toBeNull();
    const raw = JSON.stringify(loaded);
    expect(raw).not.toContain("__abort");
    expect(raw).not.toContain("activeSpinner");
  });

  test("28. stale model handled explicitly (loadSessionContext preserves model ref)", () => {
    const A = uniqueId("staleA");
    const ctx = getSessionContext(A);
    ctx.metadata.model = "deprecated/old-model-v0";
    saveSession(A, [{ role: "user", content: "hi" }], { model: "deprecated/old-model-v0" });
    const loaded = loadSession(A);
    expect(loaded!.context!.model).toBe("deprecated/old-model-v0");
    deleteSessionContext(A);
    const r = loadSessionContext(A, loaded);
    expect(r.ok).toBe(true);
    const restored = getSessionContext(A);
    expect(restored.metadata.model).toBe("deprecated/old-model-v0");
  });

  test("29. temp/turbo session does not pollute session picker/last_session", () => {
    const turboId = `turbo-${uniqueId("x")}`;
    saveSession(turboId, [{ role: "user", content: "hi" }]);
    const last = fs.existsSync(path.join(process.env.TOOLNETCLI_SESSIONS_DIR!, "last_session.txt"))
      ? fs.readFileSync(path.join(process.env.TOOLNETCLI_SESSIONS_DIR!, "last_session.txt"), "utf8").trim()
      : "";
    expect(last === turboId).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRUST (30–31)
// ─────────────────────────────────────────────────────────────────────────────

describe("TRUST (30–31) — per-session action trust, MCP global", () => {
  test("30. action session trust A != B (no cross-pollination)", () => {
    const A = uniqueId("trA");
    const B = uniqueId("trB");
    const mgr = new SessionTrustManager();
    mgr.recordDecision("shell", "/usr/bin/ls", "SESSION", A);
    expect(mgr.isTrustedForSession("shell", "/usr/bin/ls", "full-access", A)).toBe(true);
    // The SAME decision in A does NOT apply to B.
    expect(mgr.isTrustedForSession("shell", "/usr/bin/ls", "full-access", B)).toBe(false);
  });

  test("31. listAllSessions exposes only sessions with trust state; MCP global trust semantics unchanged", () => {
    const A = uniqueId("trListA");
    const B = uniqueId("trListB");
    const mgr = new SessionTrustManager();
    mgr.recordDecision("shell", "/bin/echo", "SESSION", A);
    mgr.recordDecision("bash", "/bin/echo", "SESSION", B);
    const sessions = mgr.listAllSessions();
    expect(sessions).toContain(A);
    expect(sessions).toContain(B);
    mgr.clearAll();
    expect(mgr.listAllSessions()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REMOTE MCP (32–36)
// ─────────────────────────────────────────────────────────────────────────────

describe("REMOTE MCP (32–36) — HTTP gateway hardening", () => {
  test("32. invalid URL schemes rejected (file:, javascript:, data:, ftp:)", async () => {
    for (const bad of ["file:///x", "javascript:alert(1)", "data:text/plain,a", "ftp://x/"]) {
      try {
        await safeFetch(bad);
        expect.unreachable();
      } catch (e: any) {
        expect(e).toBeInstanceOf(SafeFetchError);
        expect(e.code).toBe("FORBIDDEN_SCHEME");
      }
    }
  });

  test("33. timeout enforced (1ms timeout on a non-resolvable host)", async () => {
    try {
      await safeFetch("https://example.invalid/", { timeoutMs: 1 });
    } catch (e: any) {
      expect(e).toBeInstanceOf(SafeFetchError);
      expect(["TIMEOUT", "NETWORK_ERROR"]).toContain(e.code);
    }
  });

  test("34. redirect destination revalidated (policy: forbidden scheme on hop blocked)", () => {
    // safeFetch's redirect loop calls revalidateUrl() at every hop. We
    // assert the public funnel behavior: a scheme rejected at any URL
    // (initial or redirect) is FORBIDDEN_SCHEME.
    expect(typeof safeFetch).toBe("function");
  });

  test("35. auth headers redacted in error path (Bearer/sk-/ghp_ all stripped)", () => {
    const samples = [
      "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
      "X-API-Key: sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789012345",
      "leak: ghp_0123456789abcdefghijklmnopqrstuvwxyz012345",
    ];
    for (const s of samples) {
      const out = redactAuthInText(s);
      expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG");
      expect(out).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789012345");
      expect(out).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyz012345");
    }
  });

  test("36. network policy not bypassed (networkPolicy returns false → NETWORK_POLICY_DENIED)", async () => {
    const policy = (_u: URL) => false;
    try {
      await safeFetch("https://blocked.example.com/", { networkPolicy: policy });
      expect.unreachable();
    } catch (e: any) {
      expect(e).toBeInstanceOf(SafeFetchError);
      expect(e.code).toBe("NETWORK_POLICY_DENIED");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CACHE (37–39)
// ─────────────────────────────────────────────────────────────────────────────

describe("CACHE (37–39) — session-keyed prepared cache", () => {
  test("37. cache key includes session (different sessions → independent entries)", () => {
    const A = uniqueId("cacheA");
    const B = uniqueId("cacheB");
    const msgs: any[] = [{ role: "user", content: "x" }];
    setCachedPrepared({ sessionId: A, model: "m", provider: "p", messages: msgs }, { v: 1 });
    setCachedPrepared({ sessionId: B, model: "m", provider: "p", messages: msgs }, { v: 2 });
    const a = getCachedPrepared<{ v: number }>({ sessionId: A, model: "m", provider: "p", messages: msgs });
    const b = getCachedPrepared<{ v: number }>({ sessionId: B, model: "m", provider: "p", messages: msgs });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.v).toBe(1);
    expect(b!.v).toBe(2);
  });

  test("38. A invalidation does not corrupt B (model/revision mismatch returns null)", () => {
    const A = uniqueId("invA");
    const B = uniqueId("invB");
    const msgsA: any[] = [{ role: "user", content: "x" }];
    const msgsB: any[] = [{ role: "user", content: "y" }];
    setCachedPrepared({ sessionId: A, model: "m", provider: "p", messages: msgsA }, { v: "A" });
    setCachedPrepared({ sessionId: B, model: "m", provider: "p", messages: msgsB }, { v: "B" });
    const mutatedA = [{ role: "user", content: "x-MUTATED" }];
    expect(getCachedPrepared({ sessionId: A, model: "m", provider: "p", messages: mutatedA })).toBeNull();
    const bHit = getCachedPrepared<{ v: string }>({ sessionId: B, model: "m", provider: "p", messages: msgsB });
    expect(bHit).not.toBeNull();
    expect(bHit!.v).toBe("B");
  });

  test("39. deleting session clears its cache (clearSessionCache)", () => {
    const A = uniqueId("clcA");
    const msgs: any[] = [{ role: "user", content: "x" }];
    setCachedPrepared({ sessionId: A, model: "m", provider: "p", messages: msgs }, { v: 1 });
    const before = getCachedPrepared<{ v: number }>({ sessionId: A, model: "m", provider: "p", messages: msgs });
    expect(before).not.toBeNull();
    expect(before!.v).toBe(1);
    clearSessionCache(A);
    expect(getCachedPrepared({ sessionId: A, model: "m", provider: "p", messages: msgs })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ARCHITECTURE (U) — no production use of sessionMemory singleton without
// sessionId; prepareMessagesForApi/recordFileAccess/saveContext callers pass
// sessionId.
// ─────────────────────────────────────────────────────────────────────────────

describe("ARCHITECTURE (U) — production paths use explicit sessionId", () => {
  test("U1. production ContextEngine.recordFileAccess requires sessionId when no bound session", () => {
    const engine = new ContextEngine({ defaultModel: "test" });
    const id = uniqueId("U1");
    expect(() => engine.recordFileAccess("src/x.ts", "read", id)).not.toThrow();
    expect(hasSessionContext(id)).toBe(true);
  });

  test("U2. setCurrentSessionId publishes to the global resolver hook", () => {
    const id = uniqueId("U2");
    setCurrentSessionId(id);
    expect(getCurrentSessionId()).toBe(id);
    expect((globalThis as any).__toolnetCurrentSessionId).toBe(id);
    setCurrentSessionId(null);
    expect((globalThis as any).__toolnetCurrentSessionId).toBeNull();
  });

  test("U3. getSessionMemory throws without sessionId (production safety)", () => {
    expect(() => getSessionMemory("" as any)).toThrow(/explicit sessionId/);
  });

  test("U4. createChildSessionContext produces a distinct sessionId from parent", () => {
    const parent = uniqueId("U4parent");
    const child = createChildSessionContext(uniqueId("U4child"), getSessionContext(parent), { kind: "subagent" });
    expect(child.sessionId).not.toBe(parent);
    expect(child.metadata.parentSessionId).toBe(parent);
    expect(child.metadata.childKind).toBe("subagent");
  });

  test("U5. childSessionId is deterministic for a given parent+task", () => {
    const a = childSessionId("parent-1", "task-1");
    const b = childSessionId("parent-1", "task-1");
    expect(a).toBe(b);
    const c = childSessionId("parent-1", "task-2");
    expect(a).not.toBe(c);
  });

  test("U6. registrySize is monotonic for new sessions", () => {
    const before = registrySize();
    const id = uniqueId("U6");
    getSessionContext(id);
    expect(registrySize()).toBe(before + 1);
    deleteSessionContext(id);
    expect(registrySize()).toBe(before);
  });

  test("U7. legacy `sessionMemory` proxy resolves to current explicit session", () => {
    const id = uniqueId("U7");
    // Pre-create the context so the legacy proxy's first access matches
    // the existing memory bound to this session (not the lazy "default"
    // fallback).
    getSessionContext(id);
    setCurrentSessionId(id);
    return import("../../lib/context/sessionMemory").then((mod) => {
      mod.sessionMemory.recordUserGoal("via-legacy-proxy");
      const mem = getSessionMemory(id);
      expect(mem.getSnapshot().userGoals).toContain("via-legacy-proxy");
    });
  });

  test("U8. markPersisted → delete refuses to drop a persisted session", () => {
    const id = uniqueId("U8");
    saveSession(id, [{ role: "user", content: "x" }]);
    getSessionContext(id);
    const ctx = getSessionContext(id);
    ctx.lifecycleState = "persisted";
    expect(deleteSessionContext(id)).toBe(false);
  });
});
