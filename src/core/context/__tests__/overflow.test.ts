import { describe, test, expect } from "bun:test";
import {
  ContextOverflowError,
  classifyContextFailure,
  isContextOverflow,
  asContextOverflow,
  isTerminalWithoutCompaction,
} from "../overflow";
import type { OverflowKind } from "../types";

describe("context overflow classification", () => {
  test("the shapes providers actually use are recognised as overflow", () => {
    const samples = [
      { message: "This model's maximum context length is 128000 tokens" },
      { message: "context_length_exceeded" },
      { message: "The request is too large for the model" },
      { message: "prompt is too long: 200000 tokens > 128000 maximum" },
      { message: "Please reduce the length of the messages" },
      { message: "Token count exceeds the model limit" },
      { message: "Input is too long for the requested model" },
      { message: "The context window exceeded the allowed size" },
      { message: "context length limit reached" },
    ];
    for (const sample of samples) {
      const classification = classifyContextFailure(sample);
      expect(classification.kind).toBe("context_overflow");
      expect(classification.compactionMayHelp).toBe(true);
      // Overflow is not retryable as-is: the same payload fails identically.
      expect(classification.retryable).toBe(false);
    }
  });

  test("only overflow claims compaction can help", () => {
    const kinds: Array<[OverflowKind, Parameters<typeof classifyContextFailure>[0]]> = [
      ["rate_limit", { status: 429 }],
      ["auth", { status: 401 }],
      ["auth", { status: 403 }],
      ["bad_request", { status: 400 }],
      ["unavailable", { status: 503 }],
      ["cancelled", { name: "AbortError" }],
    ];
    for (const [kind, input] of kinds) {
      const classification = classifyContextFailure(input);
      expect(classification.kind).toBe(kind);
      expect(classification.compactionMayHelp).toBe(false);
    }
  });

  test("an explicit status wins over prose that happens to mention tokens", () => {
    const classification = classifyContextFailure({
      status: 429,
      message: "rate limit reached for tokens per minute",
    });
    expect(classification.kind).toBe("rate_limit");
    expect(classification.retryable).toBe(true);
  });

  test("413 is overflow even without matching wording", () => {
    const classification = classifyContextFailure({ status: 413, message: "payload" });
    expect(classification.kind).toBe("context_overflow");
    expect(classification.matchedBy).toBe("status 413");
  });

  test("transient transport failures are retryable but not compaction candidates", () => {
    for (const input of [
      { message: "ECONNRESET" },
      { message: "request timed out" },
      { message: "provider overloaded, try again" },
      { status: 502, message: "bad gateway" },
    ]) {
      const classification = classifyContextFailure(input);
      expect(classification.kind).toBe("unavailable");
      expect(classification.retryable).toBe(true);
      expect(classification.compactionMayHelp).toBe(false);
    }
  });

  test("an unrecognised failure is unknown rather than guessed", () => {
    const classification = classifyContextFailure({ message: "something odd happened" });
    expect(classification.kind).toBe("unknown");
    expect(classification.retryable).toBe(false);
  });

  test("an empty input is still classified deterministically", () => {
    const classification = classifyContextFailure({});
    expect(classification.kind).toBe("unknown");
    expect(classification.matchedBy).toBe("no pattern matched");
  });

  test("the canonical error carries provenance and a usable message", () => {
    const error = asContextOverflow(
      { message: "maximum context length exceeded" },
      { provider: "openrouter", model: "some/model" },
    );
    expect(error).toBeInstanceOf(ContextOverflowError);
    expect(error?.code).toBe("CONTEXT_OVERFLOW");
    expect(error?.provider).toBe("openrouter");
    expect(error?.matchedBy.length).toBeGreaterThan(0);
    expect(isContextOverflow(error)).toBe(true);
  });

  test("a failure compaction cannot fix does not become an overflow error", () => {
    expect(asContextOverflow({ status: 429 })).toBeNull();
    expect(asContextOverflow({ status: 401 })).toBeNull();
    expect(asContextOverflow({ message: "invalid request" })).toBeNull();
  });

  test("overflow is detected from a plain error object and from a canonical one", () => {
    expect(isContextOverflow(new Error("context window exceeded"))).toBe(true);
    expect(isContextOverflow(new Error("ECONNRESET"))).toBe(false);
    expect(isContextOverflow(null)).toBe(false);
    expect(isContextOverflow({ code: "CONTEXT_OVERFLOW" })).toBe(true);
  });

  test("terminal failures are named so routing does not bounce between providers", () => {
    expect(isTerminalWithoutCompaction("context_overflow")).toBe(true);
    expect(isTerminalWithoutCompaction("auth")).toBe(true);
    expect(isTerminalWithoutCompaction("bad_request")).toBe(true);
    expect(isTerminalWithoutCompaction("cancelled")).toBe(true);
    expect(isTerminalWithoutCompaction("unavailable")).toBe(false);
    expect(isTerminalWithoutCompaction("rate_limit")).toBe(false);
  });
});
