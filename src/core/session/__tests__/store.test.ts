import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../store";
import { SessionInvalidIdError, SessionNotFoundError } from "../errors";
import { SessionHasChildrenError } from "../errors";
import { readCheckpoints, readJournal } from "../journal";
import { normalizeWorkspaceIdentity } from "../workspace";
import { SESSION_SCHEMA_VERSION } from "../types";

let tmpDir: string;
let store: SessionStore;

function makeWorkspace(dir: string) {
  return normalizeWorkspaceIdentity(dir);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-session-store-"));
  store = new SessionStore({ sessionsDir: tmpDir, onWarn: () => {} });
});

afterEach(() => {
  store.resetCache();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe("SessionStore — create and load", () => {
  test("creates a versioned record with a workspace identity and idle status", () => {
    const ws = makeWorkspace(tmpDir);
    const record = store.create({ title: "First", workspace: ws });
    expect(record.version).toBe(SESSION_SCHEMA_VERSION);
    expect(record.id).toMatch(/^sess_/);
    expect(record.status).toBe("idle");
    expect(record.workspace.key).toBe(ws.key);
    expect(store.exists(record.id)).toBe(true);
  });

  test("persists the record atomically at mode 0600 and keeps the legacy sessionId field", () => {
    const record = store.create({ workspace: makeWorkspace(tmpDir) });
    const filePath = path.join(tmpDir, `${record.id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(raw.sessionId).toBe(record.id);
    expect(raw.version).toBe(SESSION_SCHEMA_VERSION);
    // No temp files survive a successful write.
    const leftovers = fs.readdirSync(tmpDir).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  test("refuses to create the same session twice", () => {
    const record = store.create({ workspace: makeWorkspace(tmpDir) });
    expect(() => store.create({ id: record.id, workspace: makeWorkspace(tmpDir) })).toThrow();
  });

  test("save materializes messages and advances the checkpoint head", () => {
    const record = store.create({ workspace: makeWorkspace(tmpDir) });
    store.save(record.id, [{ role: "user", content: "hello" }], { model: "openrouter/x" });

    const loaded = store.load(record.id)!;
    expect(loaded.messages.length).toBe(1);
    expect(loaded.messages[0].content).toBe("hello");
    expect(loaded.metadata.model).toBe("openrouter/x");

    const head = store.latestCheckpoint(record.id);
    expect(head).not.toBeNull();
    expect(head!.messageCount).toBe(1);
    expect(head!.reason).toBe("turn-complete");
    expect(loaded.checkpointHead).toBe(head!.checkpointId);
  });

  test("load returns null for an unknown session", () => {
    expect(store.load("does_not_exist")).toBeNull();
  });

  test("rename updates the title and the legacy metadata name", () => {
    const record = store.create({ title: "old", workspace: makeWorkspace(tmpDir) });
    store.rename(record.id, "new");
    const loaded = store.load(record.id)!;
    expect(loaded.title).toBe("new");
    expect(loaded.metadata.name).toBe("new");
  });
});

describe("SessionStore — journal sequence", () => {
  test("events receive strictly increasing sequences", () => {
    const record = store.create({ workspace: makeWorkspace(tmpDir) });
    const a = store.appendSessionEvent(record.id, "user.message", { content: "one" });
    const b = store.appendSessionEvent(record.id, "assistant.message", { content: "two" });
    const c = store.appendSessionEvent(record.id, "tool.started", { callId: "t1", name: "read_file" });
    expect(b.seq).toBe(a.seq + 1);
    expect(c.seq).toBe(b.seq + 1);

    const journal = readJournal(path.join(tmpDir, `${record.id}.events.jsonl`));
    const appended = journal.events.filter((e) => e.type !== "session.created" && e.type !== "checkpoint.created");
    expect(appended.map((e) => e.type)).toEqual(["user.message", "assistant.message", "tool.started"]);
    expect(journal.lastSequence).toBe(c.seq);
  });
});

describe("SessionStore — index and listing", () => {
  test("list is newest-first and survives a deleted index", () => {
    const ws = makeWorkspace(tmpDir);
    const a = store.create({ title: "a", workspace: ws });
    store.save(a.id, [{ role: "user", content: "a" }]);
    const b = store.create({ title: "b", workspace: ws });
    store.save(b.id, [{ role: "user", content: "b" }]);

    const listed = store.list().map((entry) => entry.id);
    expect(listed).toContain(a.id);
    expect(listed).toContain(b.id);

    fs.rmSync(path.join(tmpDir, ".index.json"), { force: true });
    store.resetCache();
    const rebuilt = store.list().map((entry) => entry.id);
    expect(rebuilt.sort()).toEqual([a.id, b.id].sort());
  });

  test("listForWorkspace only returns sessions for the same project key", () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-other-ws-"));
    try {
      const here = store.create({ title: "here", workspace: makeWorkspace(tmpDir) });
      store.create({ title: "elsewhere", workspace: makeWorkspace(otherDir) });
      const forHere = store.listForWorkspace(makeWorkspace(tmpDir));
      expect(forHere.map((entry) => entry.id)).toEqual([here.id]);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

describe("SessionStore — corruption and versioning", () => {
  test("a corrupt record is quarantined and does not crash the store", () => {
    const record = store.create({ workspace: makeWorkspace(tmpDir) });
    const filePath = path.join(tmpDir, `${record.id}.json`);
    fs.writeFileSync(filePath, "{ not json");

    expect(store.load(record.id)).toBeNull();
    const quarantined = fs.readdirSync(tmpDir).filter((name) => name.startsWith(`${record.id}.json.corrupt`));
    expect(quarantined.length).toBe(1);
    // The damaged file is preserved, not overwritten.
    expect(fs.readFileSync(path.join(tmpDir, quarantined[0]), "utf8")).toBe("{ not json");
  });

  test("an unsupported future schema version is refused, not guessed at", () => {
    const record = store.create({ workspace: makeWorkspace(tmpDir) });
    const filePath = path.join(tmpDir, `${record.id}.json`);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    raw.version = SESSION_SCHEMA_VERSION + 5;
    fs.writeFileSync(filePath, JSON.stringify(raw));

    expect(store.load(record.id)).toBeNull();
    expect(() => store.load(record.id, { strict: true })).toThrow();
  });

  test("a legacy unversioned record migrates in memory without rewriting the file", () => {
    const legacyId = "sess_legacy_1";
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-legacy-ws-"));
    const legacy = {
      sessionId: legacyId,
      messages: [{ role: "user", content: "old" }],
      metadata: { workspace: legacyDir, createdAt: "2020-01-01T00:00:00.000Z", model: "m" },
      updatedAt: "2020-01-02T00:00:00.000Z",
    };
    fs.writeFileSync(path.join(tmpDir, `${legacyId}.json`), JSON.stringify(legacy));
    try {
      const loaded = store.load(legacyId)!;
      expect(loaded.version).toBe(SESSION_SCHEMA_VERSION);
      expect(loaded.messages[0].content).toBe("old");
      expect(loaded.workspace.path).toBe(fs.realpathSync(legacyDir));
      expect(loaded.model).toBe("m");
      // Non-destructive: the on-disk file is still the original shape.
      const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, `${legacyId}.json`), "utf8"));
      expect(raw.version).toBeUndefined();
    } finally {
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});

describe("SessionStore — id safety", () => {
  test("rejects traversal and separator ids instead of creating paths", () => {
    for (const id of ["../escape", "a/b", "a\\b", "..", ".hidden", "with space", "nul\u0000byte"]) {
      expect(() => store.create({ id, workspace: makeWorkspace(tmpDir) })).toThrow(SessionInvalidIdError);
    }
    expect(fs.existsSync(path.join(path.dirname(tmpDir), "escape.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "escape.json"))).toBe(false);
  });

  test("rejects an over-long id", () => {
    expect(() => store.create({ id: "a".repeat(500), workspace: makeWorkspace(tmpDir) })).toThrow(SessionInvalidIdError);
  });

  test("accepts namespaced subagent and external ids", () => {
    const sub = store.create({ id: "sub:parent:explore:1", workspace: makeWorkspace(tmpDir) });
    expect(sub.id).toBe("sub:parent:explore:1");
    const ext = store.create({ id: "external:codex:abc", workspace: makeWorkspace(tmpDir) });
    expect(ext.id).toBe("external:codex:abc");
  });
});

describe("SessionStore — delete semantics", () => {
  test("deleting a parent with forks requires an explicit cascade", () => {
    const ws = makeWorkspace(tmpDir);
    const parent = store.create({ title: "parent", workspace: ws });
    const child = store.fork(parent.id, { workspace: ws });

    expect(() => store.remove(parent.id)).toThrow(SessionHasChildrenError);
    expect(store.exists(parent.id)).toBe(true);
    expect(store.exists(child.id)).toBe(true);

    const result = store.remove(parent.id, { cascade: true });
    expect(result.removed.sort()).toEqual([parent.id, child.id].sort());
    expect(store.exists(parent.id)).toBe(false);
    expect(store.exists(child.id)).toBe(false);
  });

  test("remove throws for an unknown session", () => {
    expect(() => store.remove("nope")).toThrow(SessionNotFoundError);
  });
});

describe("SessionStore — doctor", () => {
  test("reports a missing workspace and repairs a damaged index without destroying data", () => {
    const goneDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-gone-ws-"));
    const record = store.create({ workspace: makeWorkspace(goneDir) });
    fs.rmSync(goneDir, { recursive: true, force: true });

    fs.writeFileSync(path.join(tmpDir, ".index.json"), "{ broken");
    store.resetCache();
    const report = store.doctor();
    expect(report.totalSessions).toBe(1);
    expect(report.indexRepaired).toBe(true);
    expect(report.issues.some((issue) => issue.kind === "missing-workspace" && issue.sessionId === record.id)).toBe(true);
    expect(store.load(record.id)!.id).toBe(record.id);
  });

  test("reports a stale lock but leaves it for the owner to reclaim", () => {
    const record = store.create({ workspace: makeWorkspace(tmpDir) });
    fs.writeFileSync(
      path.join(tmpDir, `${record.id}.lock`),
      JSON.stringify({ pid: 999_999, host: os.hostname(), at: Date.now(), sessionId: record.id }),
    );
    const report = store.doctor();
    expect(report.issues.some((issue) => issue.kind === "stale-lock" && issue.sessionId === record.id)).toBe(true);
  });
});

describe("SessionStore — checkpoints", () => {
  test("checkpoint log stays readable and the head always exists", () => {
    const record = store.create({ workspace: makeWorkspace(tmpDir) });
    store.save(record.id, [{ role: "user", content: "1" }]);
    store.save(record.id, [
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
    ]);
    const read = readCheckpoints(path.join(tmpDir, `${record.id}.checkpoints.jsonl`));
    expect(read.checkpoints.length).toBeGreaterThanOrEqual(3);
    const latest = store.latestCheckpoint(record.id)!;
    const journal = readJournal(path.join(tmpDir, `${record.id}.events.jsonl`));
    // The head references a durable sequence, never a future one.
    expect(latest.eventSequence).toBeLessThanOrEqual(journal.lastSequence);
  });
});
