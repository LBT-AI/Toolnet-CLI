/**
 * `toolnet logs` / `toolnet trace` / `toolnet health` contract.
 *
 * The CLI is a read-only face over the canonical observability stores: it must
 * never print an unbounded amount, never print a secret, and never need network
 * access or a paid call.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { traceStore } from "../../lib/observability/trace";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ORIGINAL_CONFIG_DIR = process.env.TOOLNETCLI_CONFIG_DIR;
let tmpDir = "";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    out,
    err,
  };
}

function seedLog(records: Array<Record<string, unknown>>): string {
  const dir = path.join(tmpDir, "logs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "toolnet.jsonl");
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-cli-obs-"));
  process.env.TOOLNETCLI_CONFIG_DIR = tmpDir;
  // The trace store is process-wide; other suites in the same run record real
  // spans. Isolation, not assumption.
  traceStore.clear();
});

afterEach(() => {
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR;
  else process.env.TOOLNETCLI_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("toolnet logs", () => {
  it("prints an empty state when nothing was logged yet", async () => {
    const { runLogsCli } = await import("../observabilityCli");
    const { io, out } = capture();
    expect(await runLogsCli([], io)).toBe(0);
    expect(out.join("\n")).toContain("No logs yet");
  });

  it("tails the last N records and formats them for humans", async () => {
    const { runLogsCli } = await import("../observabilityCli");
    seedLog([
      { timestamp: "t1", level: "info", component: "harness", event: "turn.start" },
      { timestamp: "t2", level: "warn", component: "tool", event: "slow", durationMs: 12, outcome: "ok" },
      { timestamp: "t3", level: "error", component: "provider", event: "request.failed", error: { message: "HTTP 503" } },
    ]);
    const { io, out } = capture();
    expect(await runLogsCli(["-n", "2"], io)).toBe(0);
    const text = out.join("\n");
    expect(text).not.toContain("turn.start");
    expect(text).toContain("WARN");
    expect(text).toContain("tool/slow");
    expect(text).toContain("12ms");
    expect(text).toContain("provider/request.failed");
    expect(text).toContain("HTTP 503");
  });

  it("filters by level and by session correlation", async () => {
    const { runLogsCli } = await import("../observabilityCli");
    seedLog([
      { timestamp: "t1", level: "info", component: "a", event: "e1", correlation: { sessionId: "s1" } },
      { timestamp: "t2", level: "error", component: "a", event: "e2", correlation: { sessionId: "s2" } },
      { timestamp: "t3", level: "error", component: "a", event: "e3", correlation: { sessionId: "s1" } },
    ]);

    const level = capture();
    expect(await runLogsCli(["--level", "error"], level.io)).toBe(0);
    expect(level.out.join("\n")).toContain("e2");
    expect(level.out.join("\n")).not.toContain("e1");

    const session = capture();
    expect(await runLogsCli(["--session", "s1", "--level", "error"], session.io)).toBe(0);
    expect(session.out.join("\n")).toContain("e3");
    expect(session.out.join("\n")).not.toContain("e2");
  });

  it("emits raw JSONL with --json", async () => {
    const { runLogsCli } = await import("../observabilityCli");
    seedLog([{ timestamp: "t1", level: "info", component: "a", event: "e1" }]);
    const { io, out } = capture();
    await runLogsCli(["--json"], io);
    expect(() => JSON.parse(out[0])).not.toThrow();
  });

  it("rejects an unknown level with a usage error and a non-zero exit", async () => {
    const { runLogsCli } = await import("../observabilityCli");
    const { io, err } = capture();
    expect(await runLogsCli(["--level", "verbose"], io)).toBe(2);
    expect(err.join("\n")).toContain("Unknown level");
  });

  it("bounds the record count and never reads an unbounded file blindly", async () => {
    const { runLogsCli } = await import("../observabilityCli");
    const records = Array.from({ length: 60 }, (_, i) => ({
      timestamp: `t${i}`,
      level: "info",
      component: "a",
      event: `e${i}`,
    }));
    seedLog(records);
    const { io, out } = capture();
    await runLogsCli(["-n", "9999"], io);
    expect(out.length).toBe(60); // clamped to the 500 cap, file is smaller
    expect(out[out.length - 1]).toContain("e59");
  });

  it("does not print a secret that reached the log file", async () => {
    const { runLogsCli } = await import("../observabilityCli");
    seedLog([{ timestamp: "t1", level: "error", component: "provider", event: "e", error: { message: "Bearer sk-abcdefghijklmnopqrstuvwxyz" } }]);
    const { io, out } = capture();
    await runLogsCli([], io);
    expect(out.join("\n")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });
});

describe("toolnet trace", () => {
  it("reports an empty state", async () => {
    const { runTraceCli } = await import("../observabilityCli");
    const { io, out } = capture();
    expect(runTraceCli([], io)).toBe(0);
    expect(out.join("\n")).toContain("No trace spans");
  });

  it("renders recorded spans with their correlation", async () => {
    const { traceStore } = await import("../../lib/observability/trace");
    const { runTraceCli } = await import("../observabilityCli");
    traceStore.clear();
    const turn = traceStore.start("agent_turn", "turn", { sessionId: "s1", traceId: "t-abc" });
    const tool = traceStore.start("tool_call", "shell", turn.correlation, { parentSpanId: turn.spanId });
    traceStore.end(tool.spanId, "ok");
    traceStore.end(turn.spanId, "error", "MAX_TURNS");

    const { io, out } = capture();
    expect(runTraceCli(["t-abc"], io)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("agent_turn");
    expect(text).toContain("tool_call");
    expect(text).toContain("trace=t-abc");
    expect(text).toContain("error=MAX_TURNS");
    traceStore.clear();
  });

  it("rejects unknown options with a usage error", async () => {
    const { runTraceCli } = await import("../observabilityCli");
    const { io, err } = capture();
    expect(runTraceCli(["--nope"], io)).toBe(2);
    expect(err.join("\n")).toContain("Unknown argument");
  });
});

describe("toolnet health", () => {
  it("prints a component summary without any network probe", async () => {
    const { runHealthCli } = await import("../observabilityCli");
    const { io, out } = capture();
    expect(runHealthCli([], io)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Health:");
    expect(text).toContain("session_store");
    expect(text).toContain("provider_registry");
  });

  it("emits parseable JSON with --json", async () => {
    const { runHealthCli } = await import("../observabilityCli");
    const { io, out } = capture();
    runHealthCli(["--json"], io);
    const parsed = JSON.parse(out.join("\n"));
    expect(Array.isArray(parsed.components)).toBe(true);
    expect(parsed.summary).toBeTruthy();
  });
});
