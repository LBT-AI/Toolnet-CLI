import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runContextCli, type ContextCliIO } from "../contextCli";
import { sessionStore } from "../../core/session";

let tmpDir: string;
let out: string[];
let err: string[];
let io: ContextCliIO;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-context-cli-"));
  process.env.TOOLNETCLI_SESSIONS_DIR = tmpDir;
  sessionStore.resetCache();
  out = [];
  err = [];
  io = { out: (line) => out.push(line), err: (line) => err.push(line) };
});

afterEach(() => {
  sessionStore.resetCache();
  delete process.env.TOOLNETCLI_SESSIONS_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSession(messages: { role: string; content: string }[], model = "gpt-4o") {
  const record = sessionStore.create({ title: "ctx" });
  sessionStore.save(record.id, messages as never);
  sessionStore.recordIdentity(record.id, { model });
  return record;
}

describe("toolnet context status", () => {
  test("reports a budget even with no active session", async () => {
    const code = await runContextCli(["status"], io);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Context status");
    expect(text).toContain("none active");
    expect(text).toContain("Window:");
  });

  test("emits structured metrics for a session", async () => {
    const record = makeSession([{ role: "user", content: "hello" }]);
    out = [];
    const code = await runContextCli(["status", "--session", record.id, "--json"], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.contextWindow).toBeGreaterThan(0);
    expect(parsed.reservedOutput).toBeGreaterThan(0);
    expect(parsed.usableInput).toBeLessThan(parsed.contextWindow);
    expect(parsed.sessionId).toBe(record.id);
  });
});

describe("toolnet context explain", () => {
  test("lists protected and prunable categories", async () => {
    const record = makeSession([
      { role: "system", content: "sys" },
      { role: "user", content: "fix the bug" },
      { role: "tool", content: JSON.stringify({ ok: true, output: "x".repeat(2000) }) },
    ]);
    out = [];
    const code = await runContextCli(["explain", "--session", record.id], io);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Context plan");
    expect(text).toContain("Protected:");
    expect(text).toContain("Prunable:");
    expect(text).toContain("Compaction:");
    expect(text).toContain("Largest contributors:");
  });

  test("is a no-op read: no provider call and no mutation", async () => {
    const record = makeSession([{ role: "user", content: "hello" }]);
    const before = JSON.stringify(sessionStore.load(record.id));
    out = [];
    await runContextCli(["explain", "--session", record.id, "--json"], io);
    expect(JSON.stringify(sessionStore.load(record.id))).toBe(before);
  });
});

describe("toolnet context compact", () => {
  test("reports nothing to compact for a small transcript", async () => {
    const record = makeSession([{ role: "user", content: "hello" }]);
    out = [];
    const code = await runContextCli(["compact", "--session", record.id], io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Nothing to compact");
  });

  test("requires a session", async () => {
    const code = await runContextCli(["compact"], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("No session to compact");
  });
});

describe("toolnet context cache", () => {
  test("reports cache stats", async () => {
    const code = await runContextCli(["cache", "status"], io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Context cache");
    expect(out.join("\n")).toContain("Entries:");
  });

  test("clears the cache", async () => {
    const code = await runContextCli(["cache", "clear"], io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("cleared");
  });
});

describe("toolnet context help and unknown subcommands", () => {
  test("no subcommand prints help", async () => {
    const code = await runContextCli([], io);
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("USAGE:");
  });

  test("unknown subcommand errors", async () => {
    const code = await runContextCli(["frobnicate"], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Unknown context subcommand");
  });
});
