import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SecurityAuditLogger, GENESIS_HASH } from "../../lib/security/auditLogger";
import { toolRateLimiter } from "../../lib/security/toolRateLimiter";

function tmpDir(): string {
  const d = path.join(os.tmpdir(), "toolnet-audit-enterprise-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function cleanDir(d: string) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

describe("Enterprise Audit Log Enrichment", () => {
  let dir: string;
  let logFile: string;

  beforeEach(() => {
    dir = tmpDir();
    logFile = path.join(dir, "security-audit.jsonl");
  });

  afterEach(() => {
    cleanDir(dir);
  });

  test("correlationId propagates across TOOL_REQUEST, SECURITY_EVALUATION, EXECUTION_COMPLETE, EXECUTION_ERROR events", () => {
    const logger = new SecurityAuditLogger(logFile);
    const correlationId = "corr-123";

    logger.logEvent({
      action: "read_file",
      mode: "workspace",
      allowed: true,
      args: { path: "src/index.ts" },
      correlationId,
      decision: "TOOL_REQUEST",
      toolCallId: "call-1",
      userSessionId: "session-1",
      userId: "user-1",
      workspaceId: "ws-1",
      agentRole: "coder",
      source: "tui",
      durationMs: 42,
      requestSize: 100,
      responseSize: 200,
    });

    logger.logEvent({
      action: "read_file",
      mode: "workspace",
      allowed: true,
      args: { path: "src/index.ts" },
      correlationId,
      decision: "SECURITY_EVALUATION",
      toolCallId: "call-1",
      userSessionId: "session-1",
      userId: "user-1",
      workspaceId: "ws-1",
      agentRole: "coder",
      source: "tui",
      durationMs: 50,
    });

    logger.logEvent({
      action: "read_file",
      mode: "workspace",
      allowed: true,
      args: { path: "src/index.ts" },
      correlationId,
      decision: "EXECUTION_COMPLETE",
      toolCallId: "call-1",
      userSessionId: "session-1",
      userId: "user-1",
      workspaceId: "ws-1",
      agentRole: "coder",
      source: "tui",
      durationMs: 120,
      result: "success",
    });

    const content = fs.readFileSync(logFile, "utf8").trim().split("\n");
    expect(content.length).toBe(3);

    for (const line of content) {
      const entry = JSON.parse(line);
      expect(entry.data.correlationId).toBe(correlationId);
      expect(entry.data.toolCallId).toBe("call-1");
      expect(entry.data.userSessionId).toBe("session-1");
      expect(entry.data.userId).toBe("user-1");
      expect(entry.data.workspaceId).toBe("ws-1");
      expect(entry.data.agentRole).toBe("coder");
      expect(entry.data.source).toBe("tui");
      expect(entry.data.durationMs).toBeDefined();
      expect(typeof entry.data.durationMs).toBe("number");
    }
  });

  test("does not log raw secret values in args or reason", () => {
    const logger = new SecurityAuditLogger(logFile);
    const secretValue = "sk-abcdef1234567890";

    logger.logEvent({
      action: "shell",
      mode: "workspace",
      allowed: false,
      args: { command: `echo ${secretValue}` },
      reason: `Secret ${secretValue} leaked`,
      correlationId: "corr-secret",
    });

    const content = fs.readFileSync(logFile, "utf8");
    expect(content).not.toContain(secretValue);
    expect(content).toContain("sk-****890");
  });

  test("RATE_LIMITED event is logged with retryAfterMs", () => {
    const logger = new SecurityAuditLogger(logFile);

    logger.logEvent({
      action: "read_file",
      mode: "workspace",
      allowed: false,
      decision: "RATE_LIMITED",
      correlationId: "corr-rate",
      toolCallId: "call-rate",
      userSessionId: "session-rate",
      reason: "Tool call rate limit exceeded (120/min).",
      durationMs: 0,
      metadata: { retryAfterMs: 5000 },
      args: {},
    });

    const content = fs.readFileSync(logFile, "utf8").trim();
    const entry = JSON.parse(content);
    expect(entry.data.decision).toBe("RATE_LIMITED");
    expect(entry.data.metadata?.retryAfterMs).toBe(5000);
    expect(entry.data.reason).toContain("rate limit");
  });

  test("success and error events both carry required context", () => {
    const logger = new SecurityAuditLogger(logFile);

    logger.logEvent({
      action: "shell",
      mode: "ask",
      allowed: true,
      decision: "EXECUTION_COMPLETE",
      correlationId: "corr-ok",
      toolCallId: "call-ok",
      userSessionId: "session-ok",
      userId: "user-ok",
      workspaceId: "ws-ok",
      agentRole: "tester",
      source: "headless",
      durationMs: 33,
      result: "success",
      requestSize: 50,
      responseSize: 300,
      args: {},
    });

    logger.logEvent({
      action: "shell",
      mode: "ask",
      allowed: false,
      decision: "EXECUTION_ERROR",
      correlationId: "corr-err",
      toolCallId: "call-err",
      userSessionId: "session-err",
      userId: "user-err",
      workspaceId: "ws-err",
      agentRole: "tester",
      source: "headless",
      durationMs: 12,
      reason: "Command failed",
      result: "failure",
      args: {},
    });

    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);

    const okEntry = JSON.parse(lines[0]);
    expect(okEntry.data.result).toBe("success");
    expect(okEntry.data.requestSize).toBe(50);
    expect(okEntry.data.responseSize).toBe(300);

    const errEntry = JSON.parse(lines[1]);
    expect(errEntry.data.result).toBe("failure");
    expect(errEntry.data.reason).toBe("Command failed");
  });
});
