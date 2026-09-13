import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendCheckpoint, appendEvent, readCheckpoints, readJournal } from "../journal";
import type { SessionCheckpoint, SessionEvent } from "../types";

let tmpDir: string;
let journalPath: string;
let checkpointPath: string;

function event(seq: number, type: SessionEvent["type"], data?: Record<string, unknown>): SessionEvent {
  return { seq, at: 1_700_000_000_000 + seq, type, ...(data ? { data } : {}) };
}

function checkpoint(overrides: Partial<SessionCheckpoint> = {}): SessionCheckpoint {
  return {
    checkpointId: `cp_${overrides.eventSequence ?? 1}`,
    sessionId: "sess_j",
    eventSequence: 1,
    at: 1_700_000_000_000,
    messageCount: 0,
    workspaceKey: "path:x",
    status: "idle",
    reason: "turn-complete",
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-session-journal-"));
  journalPath = path.join(tmpDir, "s.events.jsonl");
  checkpointPath = path.join(tmpDir, "s.checkpoints.jsonl");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("event journal", () => {
  test("missing file reads as empty", () => {
    const read = readJournal(journalPath);
    expect(read.events).toEqual([]);
    expect(read.lastSequence).toBe(0);
    expect(read.truncated).toBe(false);
  });

  test("appends and replays in sequence order", () => {
    appendEvent(journalPath, event(1, "session.created"));
    appendEvent(journalPath, event(2, "user.message", { content: "hi" }));
    appendEvent(journalPath, event(3, "assistant.message", { content: "yo" }));

    const read = readJournal(journalPath);
    expect(read.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(read.lastSequence).toBe(3);
    expect(read.malformedLines).toBe(0);
    expect(read.truncated).toBe(false);
  });

  test("a torn final line is dropped and reported, earlier records stay usable", () => {
    appendEvent(journalPath, event(1, "session.created"));
    appendEvent(journalPath, event(2, "user.message", { content: "kept" }));
    // Simulate a kill mid-append: a partial line with no trailing newline.
    fs.appendFileSync(journalPath, '{"seq":3,"at":1700000000003,"type":"assist');

    const read = readJournal(journalPath);
    expect(read.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(read.truncated).toBe(true);
    expect(read.lastSequence).toBe(2);
  });

  test("an unreadable interior line is isolated without discarding neighbours", () => {
    appendEvent(journalPath, event(1, "session.created"));
    fs.appendFileSync(journalPath, "this is not json\n");
    appendEvent(journalPath, event(3, "user.message", { content: "after" }));

    const read = readJournal(journalPath);
    expect(read.events.map((e) => e.seq)).toEqual([1, 3]);
    expect(read.malformedLines).toBe(1);
  });

  test("out-of-order and duplicate sequences are ignored rather than reordered", () => {
    appendEvent(journalPath, event(1, "session.created"));
    appendEvent(journalPath, event(2, "user.message", { content: "first" }));
    appendEvent(journalPath, event(2, "user.message", { content: "duplicate" }));

    const read = readJournal(journalPath);
    expect(read.events.length).toBe(2);
    expect(read.events[1].data?.content).toBe("first");
    expect(read.duplicateSequences).toBe(1);
  });

  test("unknown additive event types are preserved but reported", () => {
    appendEvent(journalPath, event(1, "session.created"));
    appendEvent(journalPath, event(2, "future.event" as any, { anything: true }));

    const read = readJournal(journalPath);
    expect(read.events.length).toBe(2);
    expect(read.unknownTypes).toEqual(["future.event"]);
    expect(read.lastSequence).toBe(2);
  });

  test("a structurally invalid event is not accepted as a record", () => {
    fs.writeFileSync(journalPath, '{"seq":"one","at":1,"type":"user.message"}\n{"seq":2,"at":1,"type":"user.message"}\n');
    const read = readJournal(journalPath);
    expect(read.malformedLines).toBe(1);
    expect(read.events.map((e) => e.seq)).toEqual([2]);
  });
});

describe("checkpoint log", () => {
  test("appends checkpoints and exposes the latest", () => {
    appendCheckpoint(checkpointPath, checkpoint({ checkpointId: "cp_1", eventSequence: 1 }));
    appendCheckpoint(checkpointPath, checkpoint({ checkpointId: "cp_2", eventSequence: 5, messageCount: 3 }));

    const read = readCheckpoints(checkpointPath);
    expect(read.checkpoints.length).toBe(2);
    expect(read.latest!.checkpointId).toBe("cp_2");
    expect(read.latest!.eventSequence).toBe(5);
  });

  test("a truncated final checkpoint is dropped; valid ones remain", () => {
    appendCheckpoint(checkpointPath, checkpoint({ checkpointId: "cp_1" }));
    fs.appendFileSync(checkpointPath, '{"checkpointId":"cp_2","sessionId":"sess_j","eventSequence":9');

    const read = readCheckpoints(checkpointPath);
    expect(read.checkpoints.map((c) => c.checkpointId)).toEqual(["cp_1"]);
    expect(read.truncated).toBe(true);
  });

  test("a checkpoint missing required fields is isolated", () => {
    fs.writeFileSync(
      checkpointPath,
      '{"checkpointId":"cp_bad"}\n' +
        `${JSON.stringify(checkpoint({ checkpointId: "cp_ok", eventSequence: 2 }))}\n`,
    );
    const read = readCheckpoints(checkpointPath);
    expect(read.checkpoints.map((c) => c.checkpointId)).toEqual(["cp_ok"]);
    expect(read.malformedLines).toBe(1);
  });
});
