import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSessionCli, resolveSessionReference, type SessionCliIO } from "../../../commands/sessionCli";
import { sessionStore } from "../store";

let tmpDir: string;
let out: string[];
let err: string[];
let io: SessionCliIO;

function recorder(): SessionCliIO {
  return {
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-session-cli-"));
  process.env.TOOLNETCLI_SESSIONS_DIR = tmpDir;
  sessionStore.resetCache();
  out = [];
  err = [];
  io = recorder();
});

afterEach(() => {
  sessionStore.resetCache();
  delete process.env.TOOLNETCLI_SESSIONS_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSession(title: string, messages = 1) {
  const record = sessionStore.create({ title });
  if (messages > 0) {
    sessionStore.save(
      record.id,
      Array.from({ length: messages }, (_, i) => ({ role: "user", content: `m${i}` })),
    );
  }
  return record;
}

describe("toolnet session list", () => {
  test("reports an empty store", async () => {
    const code = await runSessionCli(["list"], io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("No saved sessions found.");
  });

  test("lists sessions with status and workspace", async () => {
    const record = makeSession("alpha");
    out = [];
    const code = await runSessionCli(["list"], io);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(record.id);
    expect(text).toContain("alpha");
    expect(text).toContain("status:");
  });

  test("--json emits the raw index", async () => {
    makeSession("alpha");
    out = [];
    await runSessionCli(["list", "--json"], io);
    const parsed = JSON.parse(out.join("\n"));
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(parsed.sessions.length).toBe(1);
  });

  test("--workspace scopes to the current project", async () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-cli-other-"));
    try {
      const here = sessionStore.create({ title: "here" });
      sessionStore.create({ title: "elsewhere", workspace: { path: otherDir, root: otherDir, key: "path:elsewhere" } });
      out = [];
      await runSessionCli(["list", "--workspace"], io);
      const text = out.join("\n");
      expect(text).toContain(here.id);
      expect(text).not.toContain("elsewhere");
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

describe("toolnet session show", () => {
  test("shows durable metadata", async () => {
    const record = makeSession("alpha");
    out = [];
    const code = await runSessionCli(["show", record.id], io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(record.id);
    expect(out.join("\n")).toContain("Workspace:");
  });

  test("resolves an unambiguous prefix", () => {
    const record = makeSession("alpha");
    const resolved = resolveSessionReference(record.id.slice(0, 12));
    expect(resolved.id).toBe(record.id);
  });

  test("reports ambiguity instead of guessing", async () => {
    sessionStore.create({ id: "sess_amb_1", title: "one" });
    sessionStore.create({ id: "sess_amb_2", title: "two" });
    out = [];
    const code = await runSessionCli(["show", "sess_amb"], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("ambiguous");
  });

  test("fails cleanly for an unknown id", async () => {
    const code = await runSessionCli(["show", "sess_missing"], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("not found");
  });

  test("rejects an unsafe id instead of treating it as a path", async () => {
    const code = await runSessionCli(["show", "../escape"], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("not found");
  });
});

describe("toolnet session resume", () => {
  test("reconstructs an interrupted session and marks it interrupted", async () => {
    const record = makeSession("crashy");
    sessionStore.save(record.id, [{ role: "user", content: "work" }], undefined, { status: "running" });
    sessionStore.appendSessionEvent(record.id, "tool.started", { callId: "t1", name: "write_file" });

    out = [];
    const code = await runSessionCli(["resume", record.id], io);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("interrupted");
    expect(text).toContain("write_file");
    expect(text).toContain(`toolnet --session ${record.id}`);
    expect(sessionStore.load(record.id)!.status).toBe("interrupted");
  });

  test("--dry-run does not persist the status change", async () => {
    const record = makeSession("crashy");
    sessionStore.save(record.id, [{ role: "user", content: "work" }], undefined, { status: "running" });
    out = [];
    await runSessionCli(["resume", record.id, "--dry-run"], io);
    expect(sessionStore.load(record.id)!.status).toBe("running");
  });

  test("--json exposes the reconstruction without secrets", async () => {
    const record = makeSession("alpha");
    sessionStore.recordIdentity(record.id, { authProfileId: "openrouter/work", provider: "openrouter" });
    out = [];
    await runSessionCli(["resume", record.id, "--json"], io);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.id).toBe(record.id);
    expect(parsed.identity.authProfileId).toBe("openrouter/work");
    expect(out.join("\n")).not.toMatch(/api[-_]?key/i);
  });
});

describe("toolnet session continue", () => {
  test("selects the most recent session for this workspace", async () => {
    makeSession("older");
    // A distinct updatedAt makes "most recent" unambiguous rather than a
    // same-millisecond tie broken by id.
    await Bun.sleep(5);
    const newer = makeSession("newer");
    out = [];
    const code = await runSessionCli(["continue"], io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(newer.id);
  });

  test("reports when nothing matches", async () => {
    sessionStore.create({ title: "other", workspace: { path: "/tmp/other-x", root: "/tmp/other-x", key: "path:other-x" } });
    out = [];
    await runSessionCli(["continue"], io);
    expect(out.join("\n")).toContain("No session for this workspace");
  });
});

describe("toolnet session fork / rename / delete", () => {
  test("fork prints the child and leaves the source untouched", async () => {
    const record = makeSession("source");
    out = [];
    const code = await runSessionCli(["fork", record.id, "--title", "child"], io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Forked");
    expect(sessionStore.load(record.id)!.title).toBe("source");
    const child = sessionStore.list().find((entry) => entry.title === "child")!;
    expect(child.parentSessionId).toBe(record.id);
  });

  test("rename sets the title", async () => {
    const record = makeSession("old");
    out = [];
    const code = await runSessionCli(["rename", record.id, "New Title"], io);
    expect(code).toBe(0);
    expect(sessionStore.load(record.id)!.title).toBe("New Title");
  });

  test("delete refuses to cascade without the flag", async () => {
    const parent = makeSession("parent");
    sessionStore.fork(parent.id, { title: "child" });
    out = [];
    const blocked = await runSessionCli(["delete", parent.id], io);
    expect(blocked).toBe(1);
    expect(err.join("\n")).toContain("forked");
    err = [];
    const ok = await runSessionCli(["delete", parent.id, "--cascade"], io);
    expect(ok).toBe(0);
    expect(sessionStore.load(parent.id)).toBeNull();
  });
});

describe("toolnet session doctor", () => {
  test("runs read-only and reports the store", async () => {
    makeSession("alpha");
    out = [];
    const code = await runSessionCli(["doctor"], io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Session doctor");
    expect(out.join("\n")).toContain("Sessions:");
  });

  test("--json emits a structured report", async () => {
    makeSession("alpha");
    out = [];
    await runSessionCli(["doctor", "--json"], io);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.totalSessions).toBe(1);
    expect(Array.isArray(parsed.issues)).toBe(true);
  });

  test("a fresh store reports an absent index, not a damaged one", async () => {
    out = [];
    await runSessionCli(["doctor"], io);
    expect(out.join("\n")).toContain("Index:         absent");
    expect(out.join("\n")).not.toContain("damaged");
  });
});

describe("toolnet session help and unknown subcommands", () => {
  test("no subcommand prints help", async () => {
    const code = await runSessionCli([], io);
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("USAGE:");
  });

  test("unknown subcommand errors", async () => {
    const code = await runSessionCli(["frobnicate"], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Unknown session subcommand");
  });
});
