/**
 * Session steer (follow-up while BUSY) — regression matrix.
 *
 * Covers the invariant set from the design brief:
 *  - ADMITTED != PROMOTED; promotion only at a safe provider-turn boundary
 *  - never inject into a streaming request, never race a second provider call
 *  - FIFO by monotonic admission; multiple steers promote together
 *  - a pending steer is a valid reason for one more provider turn (no Idle)
 *  - strictly session-scoped; durable via the ONE SessionStore journal
 *  - exactly-once promotion across a crash/resume
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentHarness, resetHarness } from "../../lib/harness";
import { setSandboxMode } from "../../lib/permissions";
import { PendingInputRegistry, resetPendingInputs, pendingInputs } from "../../core/agent/pendingInput";
import { foldPendingInputs, readPendingInputs } from "../../core/session/pendingInputJournal";
import { sessionStore } from "../../core/session";
import type { SessionEvent } from "../../core/session/types";

// ── helpers ────────────────────────────────────────────────────────────────

function event(
  seq: number,
  type: SessionEvent["type"],
  data?: Record<string, unknown>,
): SessionEvent {
  return { seq, at: 1_700_000_000_000 + seq, type, ...(data ? { data } : {}) };
}

function openAiReply(message: Record<string, unknown>): any {
  return { ok: true, json: async () => ({ choices: [{ message }] }) } as any;
}

/** Extract the serialized conversation from a mocked provider request. */
function bodyMessages(init: RequestInit | undefined): string {
  const raw = typeof init?.body === "string" ? init.body : "";
  return raw;
}

// ── A. registry semantics ──────────────────────────────────────────────────

describe("PendingInputRegistry — admission semantics", () => {
  let registry: PendingInputRegistry;

  beforeEach(() => {
    registry = new PendingInputRegistry();
  });

  test("admits a follow-up as pending on the given session", () => {
    const input = registry.admit("s1", "check the Maybach carousel");
    expect(input).toBeDefined();
    expect(input!.state).toBe("pending");
    expect(input!.delivery).toBe("steer");
    expect(registry.count("s1")).toBe(1);
  });

  test("rejects empty content and empty session id", () => {
    expect(registry.admit("s1", "   ")).toBeUndefined();
    expect(registry.admit("", "real task")).toBeUndefined();
  });

  test("duplicate submit with the same id admits exactly once", () => {
    const first = registry.admit("s1", "B", { id: "pin_fixed_1" });
    const second = registry.admit("s1", "B", { id: "pin_fixed_1" });
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(registry.count("s1")).toBe(1);
  });

  test("FIFO by monotonic admission, regardless of call timing", () => {
    registry.admit("s1", "B");
    registry.admit("s1", "C");
    registry.admit("s1", "D");
    expect(registry.pending("s1").map((i) => i.content)).toEqual(["B", "C", "D"]);
  });

  test("sessions are isolated — one session never sees another's input", () => {
    registry.admit("s1", "B");
    expect(registry.count("s1")).toBe(1);
    expect(registry.count("s2")).toBe(0);
    expect(registry.pending("s2")).toEqual([]);
  });

  test("promotion is exactly-once", () => {
    const b = registry.admit("s1", "B")!;
    const promoted = registry.promote("s1", [b.id]);
    expect(promoted.map((i) => i.id)).toEqual([b.id]);
    expect(registry.promote("s1", [b.id])).toEqual([]);
    expect(registry.count("s1")).toBe(0);
  });

  test("cancel retires a pending input without promoting it", () => {
    const b = registry.admit("s1", "B")!;
    expect(registry.cancel("s1", b.id)).toBe(true);
    expect(registry.cancel("s1", b.id)).toBe(false);
    expect(registry.count("s1")).toBe(0);
  });

  test("remove drops a pending input; removing #2 does not touch #1", () => {
    const one = registry.admit("s1", "one")!;
    const two = registry.admit("s1", "two")!;
    expect(registry.remove("s1", two.id)).toBe(true);
    expect(registry.pending("s1").map((i) => i.id)).toEqual([one.id]);
  });

  test("restore re-seeds durable inputs without duplicating or reordering", () => {
    registry.restore("s1", [
      { id: "a", content: "A", delivery: "steer", admittedSequence: 1 },
      { id: "b", content: "B", delivery: "queue", admittedSequence: 2 },
    ]);
    registry.restore("s1", [
      { id: "a", content: "A", delivery: "steer", admittedSequence: 1 },
      { id: "c", content: "C", delivery: "steer", admittedSequence: 3 },
    ]);
    expect(registry.pending("s1").map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  test("a restored input keeps admittedSequence higher than the sequence counter", () => {
    registry.restore("s1", [{ id: "a", content: "A", delivery: "steer", admittedSequence: 7 }]);
    const next = registry.admit("s1", "B")!;
    expect(next.admittedSequence).toBeGreaterThan(7);
  });
});

// ── B. durable fold ────────────────────────────────────────────────────────

describe("pendingInputJournal — durable fold", () => {
  test("admitted-only is pending", () => {
    const fold = foldPendingInputs(
      [event(1, "session.input.admitted", { inputId: "b", content: "B", delivery: "steer", admittedSequence: 1 })],
      "s1",
    );
    expect(fold.pending.map((p) => p.id)).toEqual(["b"]);
  });

  test("crash AFTER promotion leaves nothing pending (no duplicate on resume)", () => {
    const fold = foldPendingInputs(
      [
        event(1, "session.input.admitted", { inputId: "b", content: "B", delivery: "steer", admittedSequence: 1 }),
        event(2, "user.message", { inputId: "b", content: "B" }),
        event(3, "session.input.promoted", { inputId: "b", delivery: "steer" }),
      ],
      "s1",
    );
    expect(fold.pending).toEqual([]);
    expect(fold.promoted).toContain("b");
  });

  test("crash BEFORE promotion still shows the steer as pending", () => {
    const fold = foldPendingInputs(
      [event(1, "session.input.admitted", { inputId: "b", content: "B", delivery: "steer", admittedSequence: 1 })],
      "s1",
    );
    expect(fold.pending.map((p) => p.content)).toEqual(["B"]);
  });

  test("cancelled inputs are neither pending nor promoted", () => {
    const fold = foldPendingInputs(
      [
        event(1, "session.input.admitted", { inputId: "b", content: "B", delivery: "steer", admittedSequence: 1 }),
        event(2, "session.input.cancelled", { inputId: "b" }),
      ],
      "s1",
    );
    expect(fold.pending).toEqual([]);
    expect(fold.cancelled).toContain("b");
  });

  test("a normal user.message without inputId is not a promotion marker", () => {
    const fold = foldPendingInputs(
      [
        event(1, "session.input.admitted", { inputId: "b", content: "B", delivery: "steer", admittedSequence: 1 }),
        event(2, "user.message", { content: "unrelated" }),
      ],
      "s1",
    );
    expect(fold.pending.map((p) => p.id)).toEqual(["b"]);
  });

  test("FIFO order survives the fold", () => {
    const fold = foldPendingInputs(
      [
        event(1, "session.input.admitted", { inputId: "d", content: "D", delivery: "steer", admittedSequence: 3 }),
        event(2, "session.input.admitted", { inputId: "b", content: "B", delivery: "steer", admittedSequence: 1 }),
        event(3, "session.input.admitted", { inputId: "c", content: "C", delivery: "queue", admittedSequence: 2 }),
      ],
      "s1",
    );
    expect(fold.pending.map((p) => p.id)).toEqual(["b", "c", "d"]);
  });
});

// ── C. durable integration through SessionStore ────────────────────────────

describe("pending input durability through the SessionStore journal", () => {
  let dir: string;
  let previousDir: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-steer-"));
    previousDir = process.env.TOOLNETCLI_SESSIONS_DIR;
    process.env.TOOLNETCLI_SESSIONS_DIR = dir;
  });

  afterEach(() => {
    if (previousDir === undefined) delete process.env.TOOLNETCLI_SESSIONS_DIR;
    else process.env.TOOLNETCLI_SESSIONS_DIR = previousDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("an admitted steer survives a process restart (crash before promotion)", () => {
    const id = "steer_crash_1";
    sessionStore.appendSessionEvent(id, "session.input.admitted", {
      inputId: "pin_1",
      content: "kiểm tra thêm Maybach",
      delivery: "steer",
      admittedSequence: 1,
    });

    const pending = readPendingInputs(id);
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toBe("kiểm tra thêm Maybach");
    expect(pending[0].delivery).toBe("steer");
  });

  test("after promotion the journal no longer reports the steer pending (no duplicate)", () => {
    const id = "steer_crash_2";
    sessionStore.appendSessionEvent(id, "session.input.admitted", {
      inputId: "pin_2",
      content: "fix header",
      delivery: "steer",
      admittedSequence: 1,
    });
    sessionStore.appendSessionEvent(id, "user.message", { inputId: "pin_2", content: "fix header" });
    sessionStore.appendSessionEvent(id, "session.input.promoted", { inputId: "pin_2", delivery: "steer" });

    expect(readPendingInputs(id)).toEqual([]);
  });

  test("restoring a durable steer into the registry keeps it pending for promotion", () => {
    const id = "steer_crash_3";
    sessionStore.appendSessionEvent(id, "session.input.admitted", {
      inputId: "pin_3",
      content: "C",
      delivery: "steer",
      admittedSequence: 4,
    });
    const registry = new PendingInputRegistry();
    registry.restore(id, readPendingInputs(id));
    expect(registry.pending(id).map((i) => i.content)).toEqual(["C"]);
  });
});

// ── D. harness end-to-end: safe boundary promotion ─────────────────────────

describe("AgentHarness — steer promotion at the safe provider-turn boundary", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetPendingInputs();
    resetHarness();
    setSandboxMode("workspace");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetPendingInputs();
    resetHarness();
  });

  test("a steer admitted mid-run is NOT injected into the in-flight request, only the next turn", async () => {
    const sessionId = "steer-e2e-1";
    const harness = new AgentHarness({ sessionId, model: "openai/gpt-4o", sandboxMode: "workspace" });
    const bodies: string[] = [];
    let call = 0;

    globalThis.fetch = (mock as any)().mockImplementation(async (_url: string, init: RequestInit) => {
      call++;
      bodies.push(bodyMessages(init));
      if (call === 1) {
        // Turn 1: one tool call so the loop continues past this request.
        return openAiReply({
          role: "assistant",
          content: "",
          tool_calls: [{ id: "tc_1", type: "function", function: { name: "get_cwd", arguments: "{}" } }],
        });
      }
      if (call === 2) {
        // Admit B WHILE this request is being served: it must never leak into
        // this request, only into the next one.
        pendingInputs.admit(sessionId, "STEER_BACKPRESSURE_MARKER", { delivery: "steer" });
        return openAiReply({ role: "assistant", content: "first task done" });
      }
      return openAiReply({ role: "assistant", content: "steer handled" });
    });

    const result = await harness.runHeadless("Check workspace root");

    expect(call).toBeGreaterThanOrEqual(3);
    // The request that was in flight when B was admitted must not contain B.
    expect(bodies[1]).not.toContain("STEER_BACKPRESSURE_MARKER");
    // The next provider request DOES contain B.
    expect(bodies[2]).toContain("STEER_BACKPRESSURE_MARKER");
    expect(result.success).toBe(true);
    expect(result.output).toBe("steer handled");
  });

  test("B, C and D promote together in FIFO order at the same boundary", async () => {
    const sessionId = "steer-e2e-fifo";
    const harness = new AgentHarness({ sessionId, model: "openai/gpt-4o", sandboxMode: "workspace" });
    let call = 0;
    let promotedBody = "";

    globalThis.fetch = (mock as any)().mockImplementation(async (_url: string, init: RequestInit) => {
      call++;
      if (call === 1) {
        return openAiReply({
          role: "assistant",
          content: "",
          tool_calls: [{ id: "tc_1", type: "function", function: { name: "get_cwd", arguments: "{}" } }],
        });
      }
      if (call === 2) {
        pendingInputs.admit(sessionId, "MARK_B", { delivery: "steer" });
        pendingInputs.admit(sessionId, "MARK_C", { delivery: "steer" });
        pendingInputs.admit(sessionId, "MARK_D", { delivery: "steer" });
        return openAiReply({ role: "assistant", content: "done" });
      }
      promotedBody = bodyMessages(init);
      return openAiReply({ role: "assistant", content: "all handled" });
    });

    const result = await harness.runHeadless("Check workspace root");
    expect(result.success).toBe(true);

    const iB = promotedBody.indexOf("MARK_B");
    const iC = promotedBody.indexOf("MARK_C");
    const iD = promotedBody.indexOf("MARK_D");
    expect(iB).toBeGreaterThanOrEqual(0);
    expect(iB).toBeLessThan(iC);
    expect(iC).toBeLessThan(iD);
  });

  test("no pending input → normal completion still works (no extra turn)", async () => {
    const sessionId = "steer-e2e-idle";
    const harness = new AgentHarness({ sessionId, model: "openai/gpt-4o", sandboxMode: "workspace" });
    let call = 0;

    globalThis.fetch = (mock as any)().mockImplementation(async () => {
      call++;
      return openAiReply({ role: "assistant", content: "plain answer" });
    });

    const result = await harness.runHeadless("say hi");
    expect(result.success).toBe(true);
    expect(result.output).toBe("plain answer");
    expect(call).toBe(1);
    expect(pendingInputs.count(sessionId)).toBe(0);
  });

  test("one session never issues two concurrent provider requests", async () => {
    const sessionId = "steer-e2e-concurrency";
    const harness = new AgentHarness({ sessionId, model: "openai/gpt-4o", sandboxMode: "workspace" });
    let inFlight = 0;
    let maxInFlight = 0;
    let call = 0;

    globalThis.fetch = (mock as any)().mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      call++;
      await new Promise((r) => setTimeout(r, 5));
      const reply =
        call === 1
          ? openAiReply({
              role: "assistant",
              content: "",
              tool_calls: [{ id: "tc_1", type: "function", function: { name: "get_cwd", arguments: "{}" } }],
            })
          : openAiReply({ role: "assistant", content: "ok" });
      inFlight--;
      return reply;
    });

    await harness.runHeadless("Check workspace root");
    expect(maxInFlight).toBe(1);
  });

  test("a promoted steer is never promoted twice within a run", async () => {
    const sessionId = "steer-e2e-once";
    const harness = new AgentHarness({ sessionId, model: "openai/gpt-4o", sandboxMode: "workspace" });
    let call = 0;
    const seen: string[] = [];

    globalThis.fetch = (mock as any)().mockImplementation(async (_url: string, init: RequestInit) => {
      call++;
      const body = bodyMessages(init);
      if (body.includes("ONCE_MARKER")) seen.push(body);
      if (call === 1) {
        return openAiReply({
          role: "assistant",
          content: "",
          tool_calls: [{ id: "tc_1", type: "function", function: { name: "get_cwd", arguments: "{}" } }],
        });
      }
      if (call === 2) {
        pendingInputs.admit(sessionId, "ONCE_MARKER", { delivery: "steer" });
        return openAiReply({ role: "assistant", content: "done" });
      }
      return openAiReply({ role: "assistant", content: "steer done" });
    });

    await harness.runHeadless("Check workspace root");

    const occurrences = (seen.join("").split("ONCE_MARKER").length - 1);
    expect(occurrences).toBeGreaterThanOrEqual(1);
    // The marker appears in exactly the requests AFTER promotion; the first
    // request carrying it is the only place it was introduced — the count of
    // messages is bounded (one user message per promoted input).
    const firstCarrier = seen[0];
    const perMessage = firstCarrier.split("ONCE_MARKER").length - 1;
    expect(perMessage).toBe(1);
  });
});
