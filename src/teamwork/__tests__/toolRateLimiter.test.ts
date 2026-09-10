import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { ToolRateLimiter, toolRateLimiter } from "../../lib/security/toolRateLimiter";

describe("ToolRateLimiter", () => {
  beforeEach(() => {
    toolRateLimiter.resetAll();
  });

  afterEach(() => {
    toolRateLimiter.resetAll();
  });

  test("allows calls below limit", () => {
    const limiter = new ToolRateLimiter({
      maxPerMinute: 10,
      maxPerTurn: 10,
      maxConcurrent: 2,
      maxPerSession: 100,
    });

    const now = Date.now();
    const ctx = { sessionId: "s1", toolName: "read_file", now };

    expect(limiter.check(ctx).allowed).toBe(true);
    limiter.record(ctx);
    expect(limiter.check(ctx).allowed).toBe(true);
    limiter.record(ctx);
    expect(limiter.check(ctx).allowed).toBe(false);
  });

  test("exact limit is allowed, next call is blocked", () => {
    const limiter = new ToolRateLimiter({
      maxPerTurn: 2,
      maxPerMinute: 100,
      maxConcurrent: 10,
      maxPerSession: 1000,
    });

    const now = Date.now();
    const base = { sessionId: "s2", toolName: "write_file", now };

    expect(limiter.check(base).allowed).toBe(true);
    limiter.record(base);
    expect(limiter.check(base).allowed).toBe(true);
    limiter.record(base);
    expect(limiter.check(base).allowed).toBe(false);
  });

  test("concurrent execution limit is enforced", () => {
    const limiter = new ToolRateLimiter({
      maxPerMinute: 100,
      maxPerTurn: 100,
      maxConcurrent: 1,
      maxPerSession: 1000,
    });

    const now = Date.now();
    const ctx = { sessionId: "s3", toolName: "shell", now };

    expect(limiter.check(ctx).allowed).toBe(true);
    limiter.record(ctx);
    expect(limiter.check(ctx).allowed).toBe(false);
    expect(limiter.check(ctx).reason).toContain("Concurrent");

    limiter.release(ctx);
    expect(limiter.check(ctx).allowed).toBe(true);
  });

  test("per-session isolation works", () => {
    const limiter = new ToolRateLimiter({
      maxPerTurn: 2,
      maxPerMinute: 100,
      maxConcurrent: 10,
      maxPerSession: 1000,
    });

    const now = Date.now();
    const ctxA = { sessionId: "sa", toolName: "read_file", now };
    const ctxB = { sessionId: "sb", toolName: "read_file", now };

    limiter.record(ctxA);
    limiter.record(ctxA);
    expect(limiter.check(ctxA).allowed).toBe(false);
    expect(limiter.check(ctxB).allowed).toBe(true);
  });

  test("release decrements concurrent count", () => {
    const limiter = new ToolRateLimiter({
      maxPerMinute: 100,
      maxPerTurn: 100,
      maxConcurrent: 2,
      maxPerSession: 1000,
    });

    const now = Date.now();
    const ctx = { sessionId: "s4", toolName: "bash", now };

    limiter.record(ctx);
    limiter.record(ctx);
    expect(limiter.check({ ...ctx, toolName: "bash2" }).allowed).toBe(false);

    limiter.release(ctx);
    expect(limiter.check({ ...ctx, toolName: "bash2" }).allowed).toBe(true);
  });

  test("turn window resets after windowMs", () => {
    const limiter = new ToolRateLimiter({
      maxPerTurn: 2,
      maxPerMinute: 100,
      maxConcurrent: 10,
      maxPerSession: 1000,
      windowMs: 1000,
    });

    const now = Date.now();
    const ctx = { sessionId: "s5", toolName: "edit_file", now };

    limiter.record(ctx);
    limiter.record(ctx);
    expect(limiter.check(ctx).allowed).toBe(false);

    const future = now + 1001;
    expect(limiter.check({ ...ctx, now: future }).allowed).toBe(true);
  });

  test("session window resets after sessionWindowMs", () => {
    const limiter = new ToolRateLimiter({
      maxPerSession: 2,
      maxPerMinute: 100,
      maxPerTurn: 100,
      maxConcurrent: 10,
      sessionWindowMs: 1000,
    });

    const now = Date.now();
    const ctx = { sessionId: "s6", toolName: "grep", now };

    limiter.record(ctx);
    limiter.record(ctx);
    expect(limiter.check(ctx).allowed).toBe(false);

    const future = now + 1001;
    expect(limiter.check({ ...ctx, now: future }).allowed).toBe(true);
  });

  test("no sessionId bypasses rate limit", () => {
    const limiter = new ToolRateLimiter();
    const result = limiter.check({ sessionId: "", toolName: "read_file", now: Date.now() });
    expect(result.allowed).toBe(true);
  });
});
