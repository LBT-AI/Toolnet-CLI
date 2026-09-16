/**
 * Observability owner contract: bounded, redacted, local-only, never control flow.
 *
 * These tests pin the properties the rest of the runtime depends on — a failing
 * logger or metric recorder must never break an operation, and nothing may grow
 * without bound or leak a secret.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ORIGINAL_CONFIG_DIR = process.env.TOOLNETCLI_CONFIG_DIR;
let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-obs-"));
  process.env.TOOLNETCLI_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR;
  else process.env.TOOLNETCLI_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("structured logger", () => {
  it("writes JSONL records under the canonical home and keeps them 0600", async () => {
    const { StructuredLogger, LOG_FILE_NAME } = await import("../logger");
    const log = new StructuredLogger();
    log.info("harness", "turn.start", { correlation: { sessionId: "s1" } });

    const file = path.join(tmpDir, "logs", LOG_FILE_NAME);
    expect(fs.existsSync(file)).toBe(true);
    const record = JSON.parse(fs.readFileSync(file, "utf-8").trim());
    expect(record.level).toBe("info");
    expect(record.component).toBe("harness");
    expect(record.event).toBe("turn.start");
    expect(record.correlation.sessionId).toBe("s1");
    expect(record.timestamp).toBeTruthy();
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("redacts secrets in messages, errors and metadata", async () => {
    const { StructuredLogger } = await import("../logger");
    const log = new StructuredLogger();
    const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
    log.error("provider", "request.failed", {
      message: `upstream rejected ${secret}`,
      error: { message: `Authorization: Bearer ${secret}` },
      metadata: { attemptKey: secret, nested: { token: secret } },
    });

    const raw = fs.readFileSync(path.join(tmpDir, "logs", "toolnet.jsonl"), "utf-8");
    expect(raw).not.toContain(secret);
    const record = JSON.parse(raw.trim());
    expect(record.metadata.attemptKey).not.toContain(secret);
    expect(record.error.message).not.toContain(secret);
  });

  it("honours the minimum level", async () => {
    const { StructuredLogger } = await import("../logger");
    const log = new StructuredLogger({ minLevel: "warn" });
    log.debug("a", "b");
    log.info("a", "b");
    log.warn("a", "b");
    expect(log.buffered().map((r) => r.level)).toEqual(["warn"]);
  });

  it("keeps an in-memory ring bounded", async () => {
    const { StructuredLogger } = await import("../logger");
    const log = new StructuredLogger({ fileEnabled: false, bufferSize: 5 });
    for (let i = 0; i < 50; i++) log.info("a", `e${i}`);
    const buffered = log.buffered();
    expect(buffered.length).toBe(5);
    expect(buffered[buffered.length - 1].event).toBe("e49");
  });

  it("rotates instead of growing without bound", async () => {
    const { StructuredLogger, getLogFilePath, LOG_MAX_BYTES } = await import("../logger");
    const log = new StructuredLogger();
    log.info("a", "seed");
    // Fill the live file past the cap, then log once more.
    fs.writeFileSync(getLogFilePath(), "x".repeat(LOG_MAX_BYTES + 1));
    log.info("a", "after-rotation");

    const dir = path.join(tmpDir, "logs");
    expect(fs.existsSync(path.join(dir, "toolnet.1.jsonl"))).toBe(true);
    const live = fs.statSync(getLogFilePath()).size;
    expect(live).toBeLessThan(LOG_MAX_BYTES);
  });

  it("never throws when the log destination is unusable", async () => {
    const { StructuredLogger } = await import("../logger");
    const blocker = path.join(tmpDir, "blocked");
    fs.writeFileSync(blocker, "not a directory");
    const log = new StructuredLogger();
    // Redirect the home at a regular file: every write path must fail safely.
    process.env.TOOLNETCLI_CONFIG_DIR = blocker;
    expect(() => log.error("a", "b", { message: "boom" })).not.toThrow();
  });

  it("drops rotated files past the retention window", async () => {
    const { cleanOldLogs } = await import("../logger");
    const dir = path.join(tmpDir, "logs");
    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, "toolnet.1.jsonl");
    fs.writeFileSync(stale, "{}\n");
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    fs.utimesSync(stale, old / 1000, old / 1000);

    expect(cleanOldLogs(14)).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
  });
});

describe("metrics", () => {
  it("counts and accumulates durations", async () => {
    const { MetricsRegistry } = await import("../metrics");
    const registry = new MetricsRegistry();
    registry.increment("tool.call.count", { labels: { tool: "read" } });
    registry.observeDuration("tool.call.duration", 25, { tool: "read" });
    registry.observeDuration("tool.call.duration", 15, { tool: "read" });

    const sample = registry.snapshot().find((s) => s.name === "tool.call.duration")!;
    expect(sample.count).toBe(2);
    expect(sample.sumMs).toBe(40);
    expect(sample.labels).toEqual({ tool: "read" });
  });

  it("rejects high-cardinality label keys and bounds label values", async () => {
    const { sanitizeLabels } = await import("../metrics");
    const labels = sanitizeLabels({
      sessionId: "per-session-id",
      tool: "Read File!",
      error_class: "x".repeat(200),
    });
    expect(labels?.sessionId).toBeUndefined();
    expect(labels?.tool).toBe("read_file");
    expect((labels?.error_class ?? "").length).toBeLessThanOrEqual(64);
  });

  it("bounds the number of tracked series", async () => {
    const { MetricsRegistry } = await import("../metrics");
    const registry = new MetricsRegistry();
    for (let i = 0; i < 700; i++) registry.increment("model.request.count", { labels: { model: `m${i}` } });
    expect(registry.snapshot().length).toBeLessThanOrEqual(500);
  });
});

describe("trace store", () => {
  it("records duration and status, and links children to a parent span", async () => {
    const { TraceStore } = await import("../trace");
    const store = new TraceStore();
    const parent = store.start("agent_turn", "turn", { traceId: "t1", sessionId: "s1" });
    const child = store.start("model_request", "request", parent.correlation, { parentSpanId: parent.spanId });
    store.end(child.spanId, "ok");
    store.end(parent.spanId, "ok");

    expect(store.forTrace("t1").length).toBe(2);
    const ended = store.forTrace("t1").find((s) => s.kind === "model_request")!;
    expect(ended.parentSpanId).toBe(parent.spanId);
    expect(ended.status).toBe("ok");
    expect(typeof ended.durationMs).toBe("number");
  });

  it("closes spans on failure and rethrows the original error", async () => {
    const { TraceStore } = await import("../trace");
    const store = new TraceStore();
    await expect(
      store.withSpan("tool_call", "shell", { traceId: "t2" }, async () => {
        throw new Error("tool exploded");
      }),
    ).rejects.toThrow("tool exploded");

    const span = store.snapshot({ traceId: "t2" })[0];
    expect(span.status).toBe("error");
    expect(span.errorCode).toBeTruthy();
  });

  it("bounds retained spans", async () => {
    const { TraceStore } = await import("../trace");
    const store = new TraceStore();
    for (let i = 0; i < 620; i++) {
      const span = store.start("tool_call", `t${i}`, { traceId: "t3" });
      store.end(span.spanId, "ok");
    }
    expect(store.snapshot({ limit: 1_000 }).length).toBeLessThanOrEqual(500);
  });
});

describe("bounded redacted error evidence", () => {
  it("truncates an unbounded provider body and strips secrets", async () => {
    const { boundedBodySnippet, PROVIDER_BODY_LIMIT } = await import("../redact");
    const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
    const body = `${secret} upstream rejected the request ${"detail ".repeat(2_000)}`;
    const snippet = boundedBodySnippet(body);
    expect(snippet).not.toContain(secret);
    expect(snippet.length).toBeLessThanOrEqual(PROVIDER_BODY_LIMIT + 20);
    // Useful context survives alongside the redaction.
    expect(snippet).toContain("upstream rejected");
    expect(snippet).toContain("truncated");
  });

  it("fails closed on a credential-shaped blob rather than storing it", async () => {
    const { boundedBodySnippet } = await import("../redact");
    // A single 10k alphanumeric run is indistinguishable from a token; it must
    // not be persisted even though that costs diagnostic detail.
    const snippet = boundedBodySnippet(`error ${"y".repeat(10_000)}`);
    expect(snippet).not.toContain("yyyy");
    expect(snippet).toContain("error");
  });

  it("keeps the status and code, which are what diagnosis needs", async () => {
    const { redactedErrorEvidence } = await import("../redact");
    const err = Object.assign(new Error("HTTP 503: upstream unavailable"), { code: "ETIMEDOUT" });
    const evidence = redactedErrorEvidence(err);
    expect(evidence.status).toBe(503);
    expect(evidence.code).toBe("ETIMEDOUT");
    expect(evidence.message).toContain("HTTP 503");
  });
});

describe("health snapshot", () => {
  it("reports components without probing paid APIs and is read-only", async () => {
    const { getHealthSnapshot } = await import("../healthSnapshot");
    const sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "abc.json"), "{}");
    const indexBefore = fs.existsSync(path.join(sessionsDir, "index.json"))
      ? fs.statSync(path.join(sessionsDir, "index.json")).mtimeMs
      : null;

    const snapshot = getHealthSnapshot();
    const names = snapshot.components.map((c) => c.component);
    expect(names).toContain("session_store");
    expect(names).toContain("provider_registry");
    expect(names).toContain("sessions");
    expect(["healthy", "degraded", "unavailable", "unknown"]).toContain(snapshot.summary);
    expect(snapshot.version).toBeTruthy();

    const sessions = snapshot.components.find((c) => c.component === "sessions")!;
    expect(sessions.detail).toContain("1 session");

    // A read-only probe must not create or rewrite the session index.
    const indexPath = path.join(sessionsDir, "index.json");
    const indexAfter = fs.existsSync(indexPath) ? fs.statSync(indexPath).mtimeMs : null;
    expect(indexAfter).toBe(indexBefore);
  });

  it("stays fast with a large session directory (no record scanning)", async () => {
    const { getHealthSnapshot } = await import("../healthSnapshot");
    const sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    for (let i = 0; i < 2_000; i++) {
      fs.writeFileSync(path.join(sessionsDir, `s${i}.json`), `{"id":"s${i}","messages":[{"role":"user","content":"hi"}]}`);
    }
    const started = Date.now();
    const snapshot = getHealthSnapshot();
    const elapsed = Date.now() - started;
    const sessions = snapshot.components.find((c) => c.component === "sessions")!;
    expect(sessions.detail).toContain("2000 session");
    // Parsing 2000 records takes an order of magnitude longer than a listing.
    expect(elapsed).toBeLessThan(1_000);
  });
});
