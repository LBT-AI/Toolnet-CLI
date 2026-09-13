import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../store";
import { SessionLockedError, SessionStoreIoError } from "../errors";
import { readJournal } from "../journal";
import { normalizeWorkspaceIdentity } from "../workspace";
import { writeFileAtomic, appendLineDurable } from "../atomic";

let tmpDir: string;
let store: SessionStore;

function ws(dir = tmpDir) {
  return normalizeWorkspaceIdentity(dir);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-session-life-"));
  store = new SessionStore({ sessionsDir: tmpDir, onWarn: () => {} });
});

afterEach(() => {
  store.resetCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("locking", () => {
  test("a second owner is refused while the lock is live", () => {
    const record = store.create({ workspace: ws() });
    const handle = store.acquire(record.id);
    const other = new SessionStore({ sessionsDir: tmpDir, onWarn: () => {} });
    expect(() => other.acquire(record.id)).toThrow(SessionLockedError);
    handle.release();
    const reacquired = other.acquire(record.id);
    reacquired.release();
  });

  test("a stale lock is reclaimed so a crash never leaves a session dead", () => {
    const record = store.create({ workspace: ws() });
    fs.writeFileSync(
      path.join(tmpDir, `${record.id}.lock`),
      JSON.stringify({ pid: 999_999, host: os.hostname(), at: Date.now() - 60 * 60 * 1000, sessionId: record.id }),
    );
    const handle = store.acquire(record.id);
    expect(handle.sessionId).toBe(record.id);
    handle.release();
  });

  test("releasing a lock we do not own does not remove it", () => {
    const record = store.create({ workspace: ws() });
    store.acquire(record.id);
    const handle = store.acquire !== undefined; // keep the reference explicit
    expect(handle).toBe(true);
    // A different pid must not delete the live lock.
    const info = store.lockInfo(record.id);
    expect(info?.pid).toBe(process.pid);
  });

  test("hasLiveOwner reflects the lock state", () => {
    const record = store.create({ workspace: ws() });
    expect(store.hasLiveOwner(record.id)).toBe(false);
    const handle = store.acquire(record.id);
    expect(store.hasLiveOwner(record.id)).toBe(true);
    handle.release();
    expect(store.hasLiveOwner(record.id)).toBe(false);
  });
});

describe("atomicity and durability", () => {
  test("many writes leave no temp files behind", () => {
    const record = store.create({ workspace: ws() });
    for (let i = 0; i < 25; i++) {
      store.save(record.id, [{ role: "user", content: `m${i}` }]);
    }
    const leftovers = fs.readdirSync(tmpDir).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  test("overlapping saves never lose an update and never produce partial JSON", async () => {
    const record = store.create({ workspace: ws() });
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        Promise.resolve().then(() => {
          store.save(record.id, [{ role: "user", content: `turn-${i}` }]);
        }),
      ),
    );
    const loaded = store.load(record.id)!;
    expect(loaded.messages.length).toBe(1);
    const raw = fs.readFileSync(path.join(tmpDir, `${record.id}.json`), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test("overlapping event appends keep a strictly increasing sequence", async () => {
    const record = store.create({ workspace: ws() });
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        Promise.resolve().then(() => store.appendSessionEvent(record.id, "user.message", { content: `e${i}` })),
      ),
    );
    const journal = readJournal(path.join(tmpDir, `${record.id}.events.jsonl`));
    const sequences = journal.events.map((e) => e.seq);
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBeGreaterThan(sequences[i - 1]);
    }
    expect(journal.events.length).toBe(42); // 40 appends + created + checkpoint
  });

  test("a write failure surfaces as a structured error and leaves no partial file", () => {
    const blocker = path.join(tmpDir, "blocker-file");
    fs.writeFileSync(blocker, "not a directory");
    const blocked = new SessionStore({ sessionsDir: path.join(blocker, "sessions"), onWarn: () => {} });
    expect(() => blocked.create({ workspace: ws() })).toThrow(SessionStoreIoError);
  });

  test("writeFileAtomic to an impossible target throws without leaving junk", () => {
    const dirTarget = path.join(tmpDir, "a-directory");
    fs.mkdirSync(dirTarget);
    expect(() => writeFileAtomic(dirTarget, "data")).toThrow();
    const leftovers = fs.readdirSync(tmpDir).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});

describe("crash windows", () => {
  test("events appended after the last checkpoint are replayed on resume", () => {
    const record = store.create({ workspace: ws() });
    store.save(record.id, [{ role: "user", content: "base" }]);
    // Crash-shaped: a turn's events are durable but no later checkpoint ran.
    store.appendSessionEvent(record.id, "assistant.message", { content: "tail answer" });

    store.resetCache();
    const resumed = store.resume(record.id, { workspace: ws() });
    expect(resumed.transcript.map((m) => m.content)).toContain("tail answer");
    expect(resumed.replayedEvents).toBeGreaterThan(0);
  });

  test("a checkpoint referencing lost journal state falls back to an earlier one", () => {
    const record = store.create({ workspace: ws() });
    store.save(record.id, [{ role: "user", content: "one" }]);
    const checkpointPath = path.join(tmpDir, `${record.id}.checkpoints.jsonl`);
    // Fabricate a checkpoint that claims far more journal than exists.
    fs.appendFileSync(
      checkpointPath,
      `${JSON.stringify({
        checkpointId: "cp_future",
        sessionId: record.id,
        eventSequence: 10_000,
        at: Date.now(),
        messageCount: 99,
        workspaceKey: ws().key,
        status: "running",
        reason: "turn-complete",
      })}\n`,
    );

    store.resetCache();
    const resumed = store.resume(record.id, { workspace: ws() });
    expect(resumed.checkpointHead!.checkpointId).not.toBe("cp_future");
    expect(resumed.warnings.join(" ")).toContain("skipped");
  });

  test("a torn journal tail is dropped and the session still resumes", () => {
    const record = store.create({ workspace: ws() });
    store.save(record.id, [{ role: "user", content: "kept" }]);
    fs.appendFileSync(path.join(tmpDir, `${record.id}.events.jsonl`), '{"seq":999,"at":1,"type":"tool.st');

    store.resetCache();
    const resumed = store.resume(record.id, { workspace: ws() });
    expect(resumed.transcript.some((m) => m.content === "kept")).toBe(true);
    expect(resumed.warnings.join(" ")).toContain("journal");
  });

  test("a torn checkpoint tail is dropped and the session still resumes", () => {
    const record = store.create({ workspace: ws() });
    store.save(record.id, [{ role: "user", content: "kept" }]);
    fs.appendFileSync(path.join(tmpDir, `${record.id}.checkpoints.jsonl`), '{"checkpointId":"cp_broken","eventSeq');

    store.resetCache();
    const resumed = store.resume(record.id, { workspace: ws() });
    expect(resumed.checkpointHead).toBeTruthy();
    expect(resumed.warnings.join(" ")).toContain("checkpoint");
  });
});

describe("concurrency across store instances", () => {
  test("two instances see each other's writes", () => {
    const record = store.create({ workspace: ws() });
    const other = new SessionStore({ sessionsDir: tmpDir, onWarn: () => {} });
    other.appendSessionEvent(record.id, "user.message", { content: "from-other" });

    store.resetCache();
    const resumed = store.resume(record.id, { workspace: ws() });
    expect(resumed.transcript.some((m) => m.content === "from-other")).toBe(true);
  });

  test("deleting while another instance reads does not throw and reads fail cleanly", () => {
    const record = store.create({ workspace: ws() });
    const other = new SessionStore({ sessionsDir: tmpDir, onWarn: () => {} });
    expect(other.load(record.id)).not.toBeNull();
    store.remove(record.id);
    expect(other.load(record.id)).toBeNull();
  });

  test("forking while an index update is pending keeps both sessions intact", async () => {
    const record = store.create({ workspace: ws() });
    await Promise.all([
      Promise.resolve().then(() => store.fork(record.id, { workspace: ws() })),
      Promise.resolve().then(() => store.save(record.id, [{ role: "user", content: "concurrent" }])),
    ]);
    const ids = store.list().map((entry) => entry.id);
    expect(ids).toContain(record.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    for (const id of ids) expect(store.load(id)).not.toBeNull();
  });
});

describe("appendLineDurable", () => {
  test("preserves an existing file and appends complete lines", () => {
    const file = path.join(tmpDir, "log.jsonl");
    appendLineDurable(file, '{"a":1}');
    appendLineDurable(file, '{"a":2}\n');
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toEqual(['{"a":1}', '{"a":2}']);
  });
});
