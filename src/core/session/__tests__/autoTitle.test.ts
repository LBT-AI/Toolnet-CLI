/**
 * Session titles live on the canonical record and its derived index — one store,
 * one field. These tests lock the durable half of the auto-title contract: a new
 * session is untitled, an auto title is written through the store, a human rename
 * always wins (even against a generator that is still in flight), and nothing
 * about compaction/resume/fork can drop a title.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../store";
import { normalizeWorkspaceIdentity } from "../workspace";
import { sessionIndexPath } from "../paths";

let tmpDir: string;
let store: SessionStore;

function ws() {
  return normalizeWorkspaceIdentity(tmpDir);
}

function indexEntry(id: string) {
  return store.list().find((entry) => entry.id === id);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-session-title-"));
  store = new SessionStore({ sessionsDir: tmpDir, onWarn: () => {} });
});

afterEach(() => {
  store.resetCache();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe("session titles — a new session is untitled", () => {
  test("create() persists no title and the index carries none", () => {
    const record = store.create({ workspace: ws() });
    expect(record.title).toBeUndefined();
    expect(record.metadata.titleSource).toBeUndefined();
    expect(store.load(record.id)?.title).toBeUndefined();
    expect(indexEntry(record.id)?.title).toBeUndefined();
  });

  test("the workspace name is never persisted as a title", () => {
    const record = store.create({ workspace: ws() });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, `${record.id}.json`), "utf8"));
    expect(raw.title).toBeUndefined();
    expect(record.workspace.path).toBe(tmpDir); // display fallback lives here only
  });
});

describe("session titles — auto generation", () => {
  test("setAutoTitle writes the record AND the index in one step", () => {
    const record = store.create({ workspace: ws() });
    const updated = store.setAutoTitle(record.id, "Build Mercedes-AMG WordPress page");
    expect(updated?.title).toBe("Build Mercedes-AMG WordPress page");
    expect(updated?.metadata.titleSource).toBe("auto");
    expect(updated?.metadata.name).toBe("Build Mercedes-AMG WordPress page");
    expect(store.load(record.id)?.title).toBe("Build Mercedes-AMG WordPress page");
    expect(indexEntry(record.id)?.title).toBe("Build Mercedes-AMG WordPress page");

    // Durable on disk, in the index file itself.
    const rawIndex = JSON.parse(fs.readFileSync(sessionIndexPath(tmpDir), "utf8"));
    expect(rawIndex.sessions[record.id].title).toBe("Build Mercedes-AMG WordPress page");
  });

  test("refuses to write to a session that no longer exists", () => {
    const record = store.create({ workspace: ws() });
    store.removeSingle(record.id);
    expect(store.setAutoTitle(record.id, "Ghost")).toBeNull();
    expect(store.load(record.id)).toBeNull();
  });

  test("an older generator never overwrites a newer title", () => {
    const record = store.create({ workspace: ws() });
    expect(store.setAutoTitle(record.id, "Newer", { revision: 2 })).not.toBeNull();
    expect(store.setAutoTitle(record.id, "Stale", { revision: 1 })).toBeNull();
    expect(store.load(record.id)?.title).toBe("Newer");
  });

  test("blank titles are ignored", () => {
    const record = store.create({ workspace: ws() });
    expect(store.setAutoTitle(record.id, "   ")).toBeNull();
    expect(store.load(record.id)?.title).toBeUndefined();
  });

  test("a turn save keeps an auto title (regeneration never happens)", () => {
    const record = store.create({ workspace: ws() });
    store.setAutoTitle(record.id, "Fix TUI scroll jitter");
    store.save(
      record.id,
      [{ role: "user", content: "và thêm test" }],
      { name: "Fix TUI scroll jitter", titleSource: "auto" },
      { reason: "turn-complete" },
    );
    expect(store.load(record.id)?.title).toBe("Fix TUI scroll jitter");
  });
});

describe("session titles — manual rename always wins", () => {
  test("rename marks the title manual and later auto writes are refused", () => {
    const record = store.create({ workspace: ws() });
    store.rename(record.id, "My own name");
    expect(store.load(record.id)?.metadata.titleSource).toBe("manual");

    // The generator finishes after the rename: it must lose.
    expect(store.setAutoTitle(record.id, "Generated name", { revision: 1 })).toBeNull();
    expect(store.load(record.id)?.title).toBe("My own name");
    expect(indexEntry(record.id)?.title).toBe("My own name");
  });

  test("a rename during generation is not overwritten by a later auto attempt either", () => {
    const record = store.create({ workspace: ws() });
    store.setAutoTitle(record.id, "Generated name", { revision: 1 });
    store.rename(record.id, "Manual wins");
    expect(store.setAutoTitle(record.id, "Generated again", { revision: 2 })).toBeNull();
    expect(store.load(record.id)?.title).toBe("Manual wins");
  });

  test("a legacy metadata.name without titleSource counts as manual", () => {
    const record = store.create({ workspace: ws() });
    store.save(record.id, [], { name: "Legacy name" }, { reason: "turn-complete" });
    expect(store.setAutoTitle(record.id, "Generated")).toBeNull();
  });
});

describe("session titles — preview for untitled sessions", () => {
  test("the index carries a preview of the first substantive task only", () => {
    const record = store.create({ workspace: ws() });
    store.save(record.id, [{ role: "user", content: "hello" }], undefined, { reason: "turn-complete" });
    expect(indexEntry(record.id)?.preview).toBeUndefined();

    store.save(
      record.id,
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "Hello." },
        { role: "user", content: "audit session persistence\nplease" },
      ],
      undefined,
      { reason: "turn-complete" },
    );
    expect(indexEntry(record.id)?.preview).toBe("audit session persistence please");
  });

  test("the preview disappears once a title exists", () => {
    const record = store.create({ workspace: ws() });
    store.save(record.id, [{ role: "user", content: "audit session persistence" }], undefined, {
      reason: "turn-complete",
    });
    expect(indexEntry(record.id)?.preview).toBeDefined();
    store.setAutoTitle(record.id, "Audit session persistence");
    expect(indexEntry(record.id)?.preview).toBeUndefined();
    expect(indexEntry(record.id)?.title).toBe("Audit session persistence");
  });
});

describe("session titles — survive the session lifecycle", () => {
  test("compaction (context event + checkpoint) leaves the title alone", () => {
    const record = store.create({ workspace: ws() });
    store.setAutoTitle(record.id, "Audit session persistence");
    store.save(record.id, [{ role: "user", content: "summarize" }], undefined, { reason: "turn-complete" });
    // The compaction path records the context event and a checkpoint — neither
    // may touch or regenerate the title.
    store.appendSessionEvent(record.id, "context.compaction", { summary: "…", messagesBefore: 40, messagesAfter: 6 });
    store.checkpoint(record.id, { reason: "manual" });

    const reloaded = new SessionStore({ sessionsDir: tmpDir, onWarn: () => {} });
    expect(reloaded.load(record.id)?.title).toBe("Audit session persistence");
    expect(store.lastSequence(record.id)).toBeGreaterThan(0);
  });

  test("status changes and resume preserve the title", () => {
    const record = store.create({ workspace: ws() });
    store.setAutoTitle(record.id, "Fix TUI scroll jitter");
    store.setStatus(record.id, "running");
    store.setStatus(record.id, "interrupted");
    const resumed = store.resume(record.id, { liveOwner: false, allowWorkspaceMismatch: true });
    expect(resumed.record.title).toBe("Fix TUI scroll jitter");

    const reloaded = new SessionStore({ sessionsDir: tmpDir, onWarn: () => {} });
    expect(reloaded.load(record.id)?.title).toBe("Fix TUI scroll jitter");
  });

  test("a fork starts from the same title without re-deriving it", () => {
    const record = store.create({ workspace: ws() });
    store.setAutoTitle(record.id, "Build Mercedes-AMG WordPress page");
    const child = store.fork(record.id);
    expect(child.title).toBe("Build Mercedes-AMG WordPress page (fork)");
    expect(store.load(record.id)?.title).toBe("Build Mercedes-AMG WordPress page");
  });
});
