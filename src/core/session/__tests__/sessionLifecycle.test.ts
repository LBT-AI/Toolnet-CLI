/**
 * Phase 6 — session / steer / agent lifecycle correctness.
 *
 * The race matrix (A–L) runs against the real `SessionRunDriver` with a
 * controllable run executor: every "race" is expressed with deferred promises
 * and barriers — no sleeps, no timers, no real provider.
 *
 * Crash/resume (G–I) runs against the real `SessionStore` journal +
 * checkpoint reconstruction in a temp sessions dir.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SessionRunDriver,
  canonicalRunError,
  canSettleIdle,
  idleBlockers,
  type ForegroundRun,
  type RunOutcome,
  type SettledRun,
} from "../lifecycle";
import { sessionStore, sessionPathsFor } from "..";
import { readJournal, readCheckpoints } from "../journal";
import { foldPendingInputs, readPendingInputs } from "../pendingInputJournal";

// ── control-plane helpers (deferred promises only — never a sleep) ──────────

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface FakeRunControl {
  driver: SessionRunDriver;
  /** Every run the driver actually started, in order. */
  runs: ForegroundRun[];
  /** Resolves as soon as run #i started. */
  started: Array<Promise<void>>;
  /** Settle run #i and wait for the next boundary (next run or IDLE). */
  finish: (index: number, outcome: RunOutcome) => Promise<void>;
  /** "pending steer" source (production: the PendingInputRegistry). */
  pendingSteers: string[];
  /** "queued message" source (production: MessageQueue). */
  queued: string[];
  /** App-owned (non-run) idle blockers, e.g. active tools / compaction. */
  externalBlockers: string[];
  settled: SettledRun[];
  idleCount: () => number;
}

function makeControl(options: { onSettleExtra?: (settled: SettledRun) => void } = {}): FakeRunControl {
  const runs: ForegroundRun[] = [];
  const started: Array<Promise<void>> = [];
  const gates: Array<Deferred<RunOutcome>> = [];
  const settled: SettledRun[] = [];
  const pendingSteers: string[] = [];
  const queued: string[] = [];
  const externalBlockers: string[] = [];
  let idle = 0;

  // Boundary signal: fires when a new run starts or the drain reports IDLE, so
  // a test can await "what happened next" without polling or sleeping.
  let boundaryWaiters: Array<() => void> = [];
  const signalBoundary = () => {
    const waiters = boundaryWaiters;
    boundaryWaiters = [];
    for (const waiter of waiters) waiter();
  };
  const nextBoundary = () => new Promise<void>((resolve) => boundaryWaiters.push(resolve));

  const driver = new SessionRunDriver({
    sessionId: "s1",
    run: async (run) => {
      runs.push(run);
      const gate = deferred<RunOutcome>();
      gates.push(gate);
      const start = deferred<void>();
      started.push(start.promise);
      start.resolve();
      signalBoundary();
      return gate.promise;
    },
    promoteSteers: () => {
      const promoted = [...pendingSteers];
      pendingSteers.length = 0;
      return promoted;
    },
    dequeueMessage: () => {
      const text = queued.shift();
      return text ? { id: `q_${text}`, text } : null;
    },
    // Production: PendingInputRegistry.admit — a busy submit is never lost.
    admitSteer: (content) => {
      pendingSteers.push(content);
    },
    // Faithful to production: leftover steer/queue work blocks IDLE.
    externalIdleBlockers: () => [
      ...externalBlockers,
      ...(pendingSteers.length > 0 ? ["pending-steer"] : []),
      ...(queued.length > 0 ? ["queued-message"] : []),
    ],
    onSettle: (s) => {
      settled.push(s);
      options.onSettleExtra?.(s);
    },
    onIdle: () => {
      idle += 1;
      signalBoundary();
    },
    // The drain can end WITHOUT idle (a blocker still held): the boundary must
    // still be observable, otherwise a race test would have nothing to await.
    onDrainEnd: () => signalBoundary(),
  });

  return {
    driver,
    runs,
    started,
    pendingSteers,
    queued,
    externalBlockers,
    settled,
    idleCount: () => idle,
    finish: async (index, outcome) => {
      const boundary = nextBoundary();
      gates[index].resolve(outcome);
      await boundary;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// A–D: steer delivery while work is in flight
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 6 — A/B/D: one foreground request, FIFO steer delivery", () => {
  test("A. a steer admitted during the provider stream never leaks into the in-flight run", async () => {
    const c = makeControl();
    const submitted = c.driver.submit("first task");
    expect(submitted.started).toBe(true);
    expect(c.runs).toHaveLength(1);

    // The stream is in flight: the steer arrives mid-turn.
    c.pendingSteers.push("STEER_DURING_STREAM");
    expect(c.runs[0].promoted).toEqual([]); // never injected into the in-flight request
    expect(c.runs[0].text).toBe("first task");
    expect(c.driver.getPhase()).toBe("running");

    await c.finish(0, { success: true });
    await c.started[1];

    // Exactly ONE foreground request at a time, and the steer became the next run.
    expect(c.runs).toHaveLength(2);
    expect(c.runs[1].kind).toBe("continuation");
    expect(c.runs[1].promoted).toEqual(["STEER_DURING_STREAM"]);
    expect(c.runs[1].text).toBe("STEER_DURING_STREAM"); // no empty synthetic prompt

    await c.finish(1, { success: true });
    expect(c.driver.getPhase()).toBe("idle");
  });

  test("B. a steer admitted while a tool runs is promoted once, after the tool phase", async () => {
    const c = makeControl();
    c.driver.submit("run the tests");
    expect(c.runs[0].promoted).toEqual([]);

    // Tool phase: the run has not settled yet.
    c.pendingSteers.push("STEER_DURING_TOOL");
    expect(c.settled).toHaveLength(0);

    await c.finish(0, { success: true });
    await c.started[1];

    // Promoted exactly once, in the run that follows the tool phase.
    expect(c.driver.steersPromoted).toBe(1);
    expect(c.runs[1].promoted).toEqual(["STEER_DURING_TOOL"]);
    await c.finish(1, { success: true });
    // No second promotion of the same input (exactly-once).
    expect(c.driver.steersPromoted).toBe(1);
    expect(c.driver.getPhase()).toBe("idle");
  });

  test("C. a steer arriving EXACTLY at completion becomes the next work atomically", async () => {
    let idleWhenSecondStarted = -1;
    let injected = false;
    const c = makeControl({
      // The steer lands in the settle window: inside the terminal notification.
      onSettleExtra: (settled) => {
        if (injected) return;
        injected = true;
        c.pendingSteers.push("STEER_AT_COMPLETION");
      },
    });

    c.driver.submit("complete me");
    await c.finish(0, { success: true });
    await c.started[1];
    idleWhenSecondStarted = c.idleCount();

    expect(c.runs).toHaveLength(2);
    expect(c.runs[1].kind).toBe("continuation");
    expect(c.runs[1].promoted).toEqual(["STEER_AT_COMPLETION"]);
    // The session never reported IDLE between the settle and the next run.
    expect(idleWhenSecondStarted).toBe(0);
    await c.finish(1, { success: true });
    expect(c.driver.getPhase()).toBe("idle");
    expect(c.idleCount()).toBe(1);
  });

  test("D. two rapid steers promote together, FIFO, exactly once", async () => {
    const c = makeControl();
    c.driver.submit("base");

    // Rapid submits while busy: admitted as steers, never a second request.
    const first = c.driver.submit("B");
    const second = c.driver.submit("C");
    expect(first.started).toBe(false);
    expect(first.admittedAsSteer).toBe(true);
    expect(second.admittedAsSteer).toBe(true);
    expect(c.runs).toHaveLength(1);

    await c.finish(0, { success: true });
    await c.started[1];

    expect(c.runs).toHaveLength(2);
    expect(c.runs[1].kind).toBe("continuation");
    expect(c.runs[1].promoted).toEqual(["B", "C"]); // FIFO by admission
    expect(c.pendingSteers).toEqual([]); // nothing lost, nothing duplicated

    await c.finish(1, { success: true });
    expect(c.driver.getPhase()).toBe("idle");
    expect(c.driver.busySubmitsAdmitted).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E/F: cancel and failure keep the invariants
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 6 — E/F: cancel settles, failure never resurrects nor loses work", () => {
  test("E. cancel settles the active run and a late success cannot resurrect it", async () => {
    const c = makeControl();
    c.driver.submit("long task");
    c.pendingSteers.push("STEER_DURING_CANCEL");

    expect(c.driver.cancel()).toBe(true);

    // Late provider success arrives AFTER the cancel.
    await c.finish(0, { success: true });

    // The verdict is CANCELLED — a late success never becomes DONE.
    expect(c.settled).toHaveLength(1);
    expect(c.settled[0].phase).toBe("cancelled");
    expect(c.settled[0].error).toBe("Cancelled");
    expect(c.driver.getLastSettled()!.phase).not.toBe("done");
    // The drain stopped: no auto-continuation after a cancel, and the leftover
    // steer keeps the session out of IDLE.
    expect(c.runs).toHaveLength(1);
    expect(c.driver.getPhase()).toBe("cancelled");
    expect(c.driver.idleBlockers()).toContain("pending-steer");

    // The steer is NOT lost — an explicit resume still delivers it.
    expect(c.pendingSteers).toEqual(["STEER_DURING_CANCEL"]);
    expect(c.driver.resumePendingWork()).toBe(true);
    await c.started[1];
    expect(c.runs[1].promoted).toEqual(["STEER_DURING_CANCEL"]);
    await c.finish(1, { success: true });
    expect(c.driver.getPhase()).toBe("idle");
  });

  test("F. provider failure keeps the queued steer/queue: never lost, ordered, bounded", async () => {
    const c = makeControl();
    c.driver.submit("task that fails");
    c.pendingSteers.push("STEER_AFTER_FAILURE");
    c.queued.push("QUEUED_AFTER_FAILURE");

    await c.finish(0, { success: false, error: "provider exploded" });

    // The failure is recorded, and the pending work still runs (steer first).
    expect(c.settled[0].phase).toBe("failed");
    expect(c.settled[0].error).toBe("provider exploded");
    expect(c.driver.continuesAfterFailure).toBe(1);

    await c.started[1];
    expect(c.runs[1].kind).toBe("continuation");
    expect(c.runs[1].promoted).toEqual(["STEER_AFTER_FAILURE"]);

    await c.finish(1, { success: true });
    await c.started[2];
    expect(c.runs[2].kind).toBe("user");
    expect(c.runs[2].text).toBe("QUEUED_AFTER_FAILURE");

    await c.finish(2, { success: true });
    expect(c.driver.getPhase()).toBe("idle");
    expect(c.queued).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// J/K/L: status + idle gate
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 6 — J/K/L: failure status, idle gate, compaction", () => {
  test("J. the canonical error is always actionable", () => {
    expect(canonicalRunError({ success: false })).toBe("Execution failed");
    expect(canonicalRunError({ success: false, error: "  " })).toBe("Execution failed");
    expect(canonicalRunError({ success: false, error: "boom" })).toBe("boom");
    expect(canonicalRunError({ success: false, cancelled: true })).toBe("Cancelled");
    expect(canonicalRunError({ success: true })).toBeUndefined();
  });

  test("J. a failed run settles as failed exactly once (never done)", async () => {
    const c = makeControl();
    c.driver.submit("fail please");
    await c.finish(0, { success: false });

    expect(c.settled).toHaveLength(1);
    expect(c.settled[0].phase).toBe("failed");
    expect(c.settled[0].error).toBe("Execution failed");
    expect(c.driver.getLastSettled()!.phase).not.toBe("done");
    expect(c.driver.getPhase()).toBe("idle"); // settled AFTER the failure was recorded
  });

  test("K. the idle gate lists every blocker and only idles when all are clear", async () => {
    expect(idleBlockers({
      foregroundRequest: false,
      activeTools: 0,
      pendingPermission: 0,
      pendingSteer: 0,
      queuedMessages: 0,
      continuation: false,
      compactionPending: false,
      foregroundSubtasks: 0,
    })).toEqual([]);
    expect(canSettleIdle({
      foregroundRequest: true,
      activeTools: 0,
      pendingPermission: 0,
      pendingSteer: 0,
      queuedMessages: 0,
      continuation: false,
      compactionPending: false,
      foregroundSubtasks: 0,
    })).toBe(false);

    expect(idleBlockers({
      foregroundRequest: false,
      activeTools: 2,
      pendingPermission: 1,
      pendingSteer: 3,
      queuedMessages: 1,
      continuation: true,
      compactionPending: true,
      foregroundSubtasks: 1,
    })).toEqual([
      "active-tool",
      "pending-permission",
      "pending-steer",
      "queued-message",
      "continuation",
      "compaction",
      "foreground-subtask",
    ]);

    // Driver-level: an external blocker keeps the session out of IDLE.
    const c = makeControl();
    c.externalBlockers.push("active-tool");
    c.driver.submit("work");
    await c.finish(0, { success: true });
    expect(c.driver.getPhase()).toBe("done");
    expect(c.idleCount()).toBe(0);
    expect(c.driver.idleBlockers()).toEqual(["active-tool"]);

    // The blocker clears → the driver reports IDLE exactly once.
    c.externalBlockers.length = 0;
    expect(c.driver.refreshIdle()).toBe(true);
    expect(c.driver.getPhase()).toBe("idle");
    expect(c.idleCount()).toBe(1);
    expect(c.driver.refreshIdle()).toBe(true);
    expect(c.idleCount()).toBe(1); // idempotent, no duplicate IDLE report
  });

  test("L. a pending compaction blocks IDLE and the session settles idle once it finishes", async () => {
    const c = makeControl();
    c.externalBlockers.push("compaction");
    c.driver.submit("compact me");
    await c.finish(0, { success: true });

    expect(c.driver.getPhase()).not.toBe("idle");
    expect(c.driver.idleBlockers()).toContain("compaction");

    c.externalBlockers.length = 0;
    c.driver.refreshIdle();
    expect(c.driver.getPhase()).toBe("idle");
    expect(c.idleCount()).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G–I: crash / resume integrity (real SessionStore)
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 6 — G/H/I: crash and resume integrity", () => {
  let dir: string;
  let previousDir: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-phase6-"));
    previousDir = process.env.TOOLNETCLI_SESSIONS_DIR;
    process.env.TOOLNETCLI_SESSIONS_DIR = dir;
  });

  afterEach(() => {
    if (previousDir === undefined) delete process.env.TOOLNETCLI_SESSIONS_DIR;
    else process.env.TOOLNETCLI_SESSIONS_DIR = previousDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("G. crash before a tool result: the call is interrupted (never fabricated, never auto-retried)", () => {
    const id = `phase6_g_${Date.now()}`;
    sessionStore.create({ id });
    sessionStore.setStatus(id, "running", { reason: "run-started" });
    sessionStore.appendSessionEvent(id, "user.message", { content: "read the config" });
    sessionStore.appendSessionEvent(id, "assistant.message", { content: "" });
    sessionStore.appendSessionEvent(id, "session.input.admitted", {
      inputId: "pin_g1",
      content: "steer that survived the crash",
      delivery: "steer",
      admittedSequence: 1,
    });
    // The tool started and the process died before any result was persisted.
    sessionStore.appendSessionEvent(id, "tool.started", { callId: "call_g1", name: "write_file", args: { path: "a.txt" } });

    const resumed = sessionStore.resume(id, { liveOwner: false });

    expect(resumed.status).toBe("interrupted");
    expect(resumed.interruptedTools).toHaveLength(1);
    expect(resumed.interruptedTools[0].callId).toBe("call_g1");
    expect(resumed.interruptedTools[0].reason).toBe("started_without_completion");
    // No fabricated tool result for a call that never completed.
    expect(resumed.transcript.filter((m) => m.role === "tool")).toHaveLength(0);
    // The interrupted MUTATION is never replayed automatically.
    expect(resumed.evidence.filesChanged).toEqual([]);

    // The admitted steer is still pending after the crash (never lost).
    expect(readPendingInputs(id).map((p) => p.content)).toEqual(["steer that survived the crash"]);
  });

  test("H. crash after a tool result persisted: the result replays exactly once", () => {
    const id = `phase6_h_${Date.now()}`;
    sessionStore.create({ id });
    sessionStore.setStatus(id, "running", { reason: "run-started" });
    sessionStore.appendSessionEvent(id, "user.message", { content: "write the file" });
    sessionStore.appendSessionEvent(id, "tool.started", { callId: "call_h1", name: "write_file", args: { path: "out.txt" } });
    sessionStore.appendSessionEvent(id, "tool.completed", {
      callId: "call_h1",
      name: "write_file",
      ok: true,
      content: "wrote out.txt",
      args: { path: "out.txt" },
    });

    const resumed = sessionStore.resume(id, { liveOwner: false });

    expect(resumed.status).toBe("interrupted"); // the RUN was interrupted…
    expect(resumed.interruptedTools).toEqual([]); // …but the call itself completed
    const toolMessages = resumed.transcript.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].tool_call_id).toBe("call_h1");
    expect(toolMessages[0].content).toBe("wrote out.txt");
    // A completed mutation is recorded exactly once.
    expect(resumed.evidence.filesChanged).toEqual(["out.txt"]);
    expect(resumed.evidence.toolCalls).toBe(1);
  });

  test("I. resume replays no duplicate user messages/tool results and keeps the promoted steer out of pending", () => {
    const id = `phase6_i_${Date.now()}`;
    sessionStore.create({ id });
    sessionStore.appendSessionEvent(id, "user.message", { content: "first" });
    sessionStore.appendSessionEvent(id, "assistant.message", {
      content: "",
      toolCalls: [{ id: "call_i1", type: "function", function: { name: "read_file", arguments: "{}" } }],
    });
    sessionStore.appendSessionEvent(id, "tool.started", { callId: "call_i1", name: "read_file", args: { path: "x" } });
    sessionStore.appendSessionEvent(id, "tool.completed", { callId: "call_i1", name: "read_file", ok: true, content: "content of x" });
    sessionStore.appendSessionEvent(id, "assistant.message", { content: "done" });

    // A steer admitted and PROMOTED before the crash: durable, and not pending.
    sessionStore.appendSessionEvent(id, "session.input.admitted", {
      inputId: "pin_i1",
      content: "promoted steer",
      delivery: "steer",
      admittedSequence: 2,
    });
    sessionStore.appendSessionEvent(id, "user.message", { inputId: "pin_i1", content: "promoted steer" });
    sessionStore.appendSessionEvent(id, "session.input.promoted", { inputId: "pin_i1", delivery: "steer" });

    // Checkpoint the transcript (what a normal turn end does), then finish.
    const before = sessionStore.resume(id, { liveOwner: false });
    sessionStore.save(id, before.transcript, { model: "test-model" });
    sessionStore.appendSessionEvent(id, "session.completed", { reason: "final answer" });

    const resumed = sessionStore.resume(id, { liveOwner: false });

    expect(resumed.status).toBe("completed");
    const userMessages = resumed.transcript.filter((m) => m.role === "user");
    expect(userMessages.map((m) => m.content)).toEqual(["first", "promoted steer"]);
    expect(resumed.transcript.filter((m) => m.role === "tool")).toHaveLength(1);

    // Exactly-once: the promoted steer is NOT pending again.
    const journal = readJournal(sessionPathsFor(id).journal);
    const fold = foldPendingInputs(journal.events, id);
    expect(fold.pending).toEqual([]);
    expect(fold.promoted).toEqual(["pin_i1"]);

    // Reconstruction is idempotent: a second resume duplicates nothing.
    const again = sessionStore.resume(id, { liveOwner: false });
    expect(again.transcript.filter((m) => m.role === "user")).toHaveLength(2);
    expect(again.transcript.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(readCheckpoints(sessionPathsFor(id).checkpoints).checkpoints.length).toBeGreaterThan(0);
  });
});
