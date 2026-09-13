import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../store";
import { replaySession, selectCheckpointHead } from "../resume";
import { normalizeWorkspaceIdentity } from "../workspace";
import { SessionError } from "../errors";
import type { SessionCheckpoint, SessionEvent, SessionRecord } from "../types";
import { SESSION_SCHEMA_VERSION, emptyEvidenceSummary } from "../types";

let tmpDir: string;
let store: SessionStore;

function ws(dir = tmpDir) {
  return normalizeWorkspaceIdentity(dir);
}

function baseRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: SESSION_SCHEMA_VERSION,
    id: "sess_r",
    workspace: ws(),
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    status: "idle",
    messages: [{ role: "user", content: "hello" }],
    metadata: {},
    ...overrides,
  };
}

function ev(seq: number, type: SessionEvent["type"], data?: Record<string, unknown>): SessionEvent {
  return { seq, at: 1_700_000_000_000 + seq, type, ...(data ? { data } : {}) };
}

function cp(overrides: Partial<SessionCheckpoint> = {}): SessionCheckpoint {
  return {
    checkpointId: "cp_1",
    sessionId: "sess_r",
    eventSequence: 1,
    at: 1_700_000_000_000,
    messageCount: 1,
    workspaceKey: ws().key,
    status: "running",
    reason: "turn-complete",
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-session-resume-"));
  store = new SessionStore({ sessionsDir: tmpDir, onWarn: () => {} });
});

afterEach(() => {
  store.resetCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("replaySession", () => {
  test("replays only events after the checkpoint base", () => {
    const events = [ev(1, "user.message", { content: "covered" }), ev(2, "user.message", { content: "tail" })];
    const result = replaySession({ record: baseRecord(), events, checkpointHead: cp({ eventSequence: 1, messageCount: 1 }) });
    expect(result.transcript.length).toBe(2);
    expect(result.transcript[1].content).toBe("tail");
    expect(result.replayedEvents).toBe(1);
  });

  test("rebuilds assistant and tool messages from journal events", () => {
    const events = [
      ev(2, "assistant.message", { content: "calling", toolCalls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: "{}" } }] }),
      ev(3, "tool.started", { callId: "t1", name: "read_file" }),
      ev(4, "tool.completed", { callId: "t1", name: "read_file", content: "file body", ok: true }),
    ];
    const result = replaySession({ record: baseRecord(), events, checkpointHead: cp({ eventSequence: 1 }) });
    expect(result.transcript.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(result.transcript[2].tool_call_id).toBe("t1");
    expect(result.evidence.toolCalls).toBe(1);
  });

  test("a tool started but never completed is reported interrupted, never replayed", () => {
    const events = [
      ev(2, "tool.started", { callId: "t9", name: "write_file" }),
    ];
    const result = replaySession({ record: baseRecord(), events, checkpointHead: cp({ eventSequence: 1 }) });
    expect(result.interruptedTools.length).toBe(1);
    expect(result.interruptedTools[0].name).toBe("write_file");
    expect(result.interruptedTools[0].reason).toBe("started_without_completion");
    // No tool result was fabricated into the transcript.
    expect(result.transcript.some((m) => m.role === "tool")).toBe(false);
    expect(result.warnings.join(" ")).toContain("outcome unknown");
  });

  test("an active run whose journal ends without a terminal event is activeAtEnd", () => {
    const result = replaySession({
      record: baseRecord({ status: "running" }),
      events: [ev(2, "user.message", { content: "still going" })],
      checkpointHead: cp({ eventSequence: 1 }),
    });
    expect(result.activeAtEnd).toBe(true);
    expect(result.status).toBe("running");
  });

  test("a terminal event settles the status and clears activeAtEnd", () => {
    const result = replaySession({
      record: baseRecord({ status: "running" }),
      events: [ev(2, "session.completed")],
      checkpointHead: cp({ eventSequence: 1 }),
    });
    expect(result.status).toBe("completed");
    expect(result.activeAtEnd).toBe(false);
  });

  test("failed tool calls and permission denials count toward evidence", () => {
    const events = [
      ev(2, "tool.started", { callId: "t1", name: "shell" }),
      ev(3, "tool.completed", { callId: "t1", name: "shell", content: "exit 1", ok: false }),
      ev(4, "permission.decision", { toolName: "shell", decision: "DENY" }),
    ];
    const result = replaySession({ record: baseRecord(), events, checkpointHead: cp({ eventSequence: 1 }) });
    expect(result.evidence.failedToolCalls).toBe(1);
    expect(result.evidence.permissionDenials).toBe(1);
  });
});

describe("selectCheckpointHead", () => {
  test("picks the newest checkpoint the journal can support", () => {
    const checkpoints = [cp({ checkpointId: "a", eventSequence: 2 }), cp({ checkpointId: "b", eventSequence: 5 })];
    expect(selectCheckpointHead(checkpoints, 5).head!.checkpointId).toBe("b");
  });

  test("skips a checkpoint that references state the journal does not contain", () => {
    const checkpoints = [cp({ checkpointId: "a", eventSequence: 2 }), cp({ checkpointId: "b", eventSequence: 99 })];
    const selection = selectCheckpointHead(checkpoints, 5);
    expect(selection.head!.checkpointId).toBe("a");
    expect(selection.skipped).toBe(1);
  });

  test("returns null when no checkpoint is supported", () => {
    expect(selectCheckpointHead([cp({ eventSequence: 99 })], 1).head).toBeNull();
  });
});

describe("SessionStore.resume", () => {
  test("reconstructs an interrupted run after a crash", () => {
    const record = store.create({ workspace: ws() });
    store.save(record.id, [{ role: "user", content: "do the thing" }], undefined, { status: "running" });
    store.appendSessionEvent(record.id, "tool.started", { callId: "t1", name: "edit_file" });
    // Process dies here: no tool.completed, status still running.

    store.resetCache();
    const resumed = store.resume(record.id, { workspace: ws() });
    expect(resumed.status).toBe("interrupted");
    expect(resumed.interruptedTools.length).toBe(1);
    expect(resumed.transcript.some((m) => m.content === "do the thing")).toBe(true);
    expect(resumed.warnings.join(" ")).toContain("interrupted");
  });

  test("a live owner keeps an active run active instead of calling it interrupted", () => {
    const record = store.create({ workspace: ws() });
    store.save(record.id, [{ role: "user", content: "running now" }], undefined, { status: "running" });

    store.resetCache();
    const resumed = store.resume(record.id, { liveOwner: true, workspace: ws() });
    expect(resumed.status).toBe("running");
  });

  test("refuses to resume a session from a different project", () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-other-project-"));
    const record = store.create({ workspace: normalizeWorkspaceIdentity(otherDir) });
    store.save(record.id, [{ role: "user", content: "elsewhere" }]);
    try {
      expect(() => store.resume(record.id)).toThrow(SessionError);
      const resumed = store.resume(record.id, { allowWorkspaceMismatch: true });
      expect(resumed.workspaceMatch).toBe("mismatch");
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test("persists only auth identity, never a credential", () => {
    const record = store.create({ workspace: ws(), authProfileId: "openrouter/work", provider: "openrouter" });
    store.save(record.id, [{ role: "user", content: "hi" }], undefined, {
      model: "anthropic/claude",
      harness: "coding",
    });
    store.resetCache();
    const resumed = store.resume(record.id, { workspace: ws() });
    expect(resumed.identity.authProfileId).toBe("openrouter/work");
    expect(resumed.identity.model).toBe("anthropic/claude");
    expect(resumed.identity.harness).toBe("coding");

    const raw = fs.readFileSync(path.join(tmpDir, `${record.id}.json`), "utf8");
    expect(raw).not.toMatch(/api[-_]?key/i);
    expect(raw).not.toMatch(/secret/i);
    expect(raw).not.toMatch(/Bearer /);
  });

  test("counts were not lost for a checkpointed evidence summary", () => {
    const record = store.create({ workspace: ws() });
    store.save(record.id, [{ role: "user", content: "x" }], undefined, {
      evidence: { ...emptyEvidenceSummary(), toolCalls: 3, filesChanged: ["a.ts"] },
    });
    store.resetCache();
    const resumed = store.resume(record.id, { workspace: ws() });
    expect(resumed.evidence.toolCalls).toBe(3);
    expect(resumed.evidence.filesChanged).toEqual(["a.ts"]);
  });
});

describe("fork and continue", () => {
  test("fork creates a child from the source checkpoint without mutating the source", () => {
    const record = store.create({ title: "source", workspace: ws() });
    store.save(record.id, [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ]);
    const beforeMessages = store.load(record.id)!.messages.length;

    const fork = store.fork(record.id, { workspace: ws() });
    expect(fork.parentSessionId).toBe(record.id);
    expect(fork.forkedFromCheckpointId).toBeTruthy();
    expect(fork.id).not.toBe(record.id);
    expect(fork.messages.length).toBe(beforeMessages);

    const sourceAfter = store.load(record.id)!;
    expect(sourceAfter.messages.length).toBe(beforeMessages);
    expect(sourceAfter.title).toBe("source");
  });

  test("fork copies nested tool call structures instead of sharing references", () => {
    const record = store.create({ workspace: ws() });
    store.save(record.id, [
      {
        role: "assistant",
        content: "call",
        tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
    ]);
    const fork = store.fork(record.id, { workspace: ws() });
    fork.messages[0].tool_calls![0].function.name = "mutated";
    expect(store.load(record.id)!.messages[0].tool_calls![0].function.name).toBe("read_file");
  });

  test("continueForWorkspace selects the newest session for the same project only", () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-continue-other-"));
    try {
      const a = store.create({ title: "a", workspace: ws() });
      const b = store.create({ title: "b", workspace: ws() });
      store.create({ title: "other", workspace: normalizeWorkspaceIdentity(otherDir) });

      const latest = store.continueForWorkspace(ws());
      expect(latest).not.toBeNull();
      expect([a.id, b.id]).toContain(latest!.id);
      expect(store.continueForWorkspace(normalizeWorkspaceIdentity(otherDir))!.title).toBe("other");
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test("continueForWorkspace returns null when nothing matches", () => {
    const lonely = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-lonely-"));
    try {
      expect(store.continueForWorkspace(normalizeWorkspaceIdentity(lonely))).toBeNull();
    } finally {
      fs.rmSync(lonely, { recursive: true, force: true });
    }
  });
});
