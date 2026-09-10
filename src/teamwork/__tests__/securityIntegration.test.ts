import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { ToolGateway } from "../../lib/security/toolGateway";
import { ToolRateLimiter, toolRateLimiter } from "../../lib/security/toolRateLimiter";
import { setSandboxMode } from "../../lib/permissions";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Security Integration — Rate Limiting + Audit + Secret Scanning", () => {
  beforeEach(() => {
    setSandboxMode("workspace");
    toolRateLimiter.resetAll();
  });

  afterEach(() => {
    setSandboxMode("workspace");
    toolRateLimiter.resetAll();
  });

  test("normal read-only tool call is not rate-limited", async () => {
    const tmpFile = path.join(process.cwd(), "toolnet-integration-" + Math.random().toString(36).slice(2) + ".txt");
    fs.writeFileSync(tmpFile, "hello");

    const res = await ToolGateway.execute(
      { name: "read_file", args: { path: tmpFile } },
      { cwd: process.cwd(), sessionId: "integration-session", source: "tui" }
    );

    expect(res.allowed).toBe(true);
    expect(res.decision).toBe("ALLOW");
    fs.unlinkSync(tmpFile);
  });

  test("abusive same-tool loop is rate-limited", async () => {
    const limiter = new ToolRateLimiter({
      maxPerTurn: 2,
      maxPerMinute: 100,
      maxConcurrent: 10,
      maxPerSession: 1000,
    });
    toolRateLimiter.resetAll();

    const sessionId = "abuse-session";
    const now = Date.now();

    const allowed1 = limiter.check({ sessionId, toolName: "shell", now });
    expect(allowed1.allowed).toBe(true);
    limiter.record({ sessionId, toolName: "shell", now });

    const allowed2 = limiter.check({ sessionId, toolName: "shell", now: now + 1 });
    expect(allowed2.allowed).toBe(true);
    limiter.record({ sessionId, toolName: "shell", now: now + 1 });

    const allowed3 = limiter.check({ sessionId, toolName: "shell", now: now + 2 });
    expect(allowed3.allowed).toBe(false);
    expect(allowed3.reason).toContain("per-turn limit");
  });

  test("permission flow still works under rate limiter", async () => {
    const limiter = new ToolRateLimiter({
      maxPerTurn: 10,
      maxPerMinute: 100,
      maxConcurrent: 10,
      maxPerSession: 1000,
    });
    toolRateLimiter.resetAll();

    const res = await ToolGateway.execute(
      { name: "read_file", args: { path: "/etc/passwd" } },
      { cwd: process.cwd(), sessionId: "perm-session", source: "headless" }
    );

    expect(res.allowed).toBe(false);
    expect(res.decision).toBe("DENY");
    expect(res.reason).toContain("outside workspace");
  });
});
