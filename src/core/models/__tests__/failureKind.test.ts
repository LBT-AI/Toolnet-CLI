/**
 * Failure classification contract.
 *
 * The retry matrix is the single source of truth for "may we try again?" and
 * "does this say anything about the provider's health?". These tests pin the
 * classes that decide whether a run retries, falls back, or stops.
 */
import { describe, expect, it } from "bun:test";
import {
  classifyProviderFailure,
  failureProfile,
  isQuotaExhaustedMessage,
  isRetryableKind,
  affectsProviderHealth,
  type FailureKind,
} from "../failureKind";
import { StreamIncompleteError } from "../../../lib/streamReliability";

const RETRYABLE_CASES: Array<[string, FailureKind]> = [
  ["HTTP 500", "unavailable"],
  ["HTTP 502", "unavailable"],
  ["HTTP 503", "unavailable"],
  ["HTTP 504", "timeout"],
  ["HTTP 429: rate limit exceeded", "rate-limit"],
  ["ECONNRESET", "network"],
  ["socket hang up", "network"],
  ["fetch failed", "network"],
];

const TERMINAL_CASES: Array<[string, FailureKind]> = [
  ["HTTP 401: unauthorized", "auth"],
  ["HTTP 403: forbidden", "auth"],
  ["HTTP 400: malformed request", "bad-request"],
  ["HTTP 422: invalid argument", "bad-request"],
];

describe("retry matrix — transport failures", () => {
  it.each(RETRYABLE_CASES)("%s is retryable", (message, kind) => {
    const c = classifyProviderFailure(new Error(message));
    expect(c.kind).toBe(kind);
    expect(c.retryable).toBe(true);
  });

  it.each(TERMINAL_CASES)("%s is terminal", (message, kind) => {
    const c = classifyProviderFailure(new Error(message));
    expect(c.kind).toBe(kind);
    expect(c.retryable).toBe(false);
  });
});

describe("cancellation is never retried", () => {
  it("an AbortError is a cancellation, not a retry", () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    const c = classifyProviderFailure(err);
    expect(c.kind).toBe("cancelled");
    expect(c.retryable).toBe(false);
    expect(c.affectsHealth).toBe(false);
  });

  it("a timeout abort stays a retryable timeout", () => {
    const err = new Error("Request timed out");
    err.name = "TimeoutError";
    const c = classifyProviderFailure(err);
    expect(c.kind).toBe("timeout");
    expect(c.retryable).toBe(true);
  });
});

describe("permission and bad input never poison provider health", () => {
  it("a permission denial is terminal and health-neutral", () => {
    const c = classifyProviderFailure(new Error("permission denied by sandbox policy"));
    expect(c.kind).toBe("permission");
    expect(c.retryable).toBe(false);
    expect(c.affectsHealth).toBe(false);
  });

  it("bad user input is terminal and health-neutral", () => {
    const c = classifyProviderFailure(new Error("invalid tool arguments"));
    expect(c.kind).toBe("bad-request");
    expect(c.affectsHealth).toBe(false);
  });
});

describe("quota exhaustion", () => {
  it("is recognised from provider wording", () => {
    for (const text of [
      "insufficient_quota",
      "You exceeded your current quota, please check your plan",
      "billing hard limit reached",
      "Your credit balance is too low",
      "payment required",
    ]) {
      expect(isQuotaExhaustedMessage(text), text).toBe(true);
    }
    expect(isQuotaExhaustedMessage("HTTP 429: rate limit exceeded")).toBe(false);
  });

  it("is terminal and does not count against provider health", () => {
    const c = classifyProviderFailure(new Error("HTTP 429: insufficient_quota"));
    expect(c.kind).toBe("quota");
    expect(c.retryable).toBe(false);
    expect(c.affectsHealth).toBe(false);
  });
});

describe("stream incompleteness", () => {
  it("a truncated stream is retryable but not silently successful", () => {
    const err = new StreamIncompleteError({ sawChunk: true, sawFinishReason: false, sawUsage: false });
    const c = classifyProviderFailure(err);
    expect(c.kind).toBe("stream-incomplete");
    expect(c.retryable).toBe(true);
    expect(c.affectsHealth).toBe(true);
  });

  it("structural evidence beats message wording", () => {
    const err = Object.assign(new Error("bad request"), { failureKind: "STREAM_INCOMPLETE" });
    expect(classifyProviderFailure(err).kind).toBe("stream-incomplete");
  });
});

describe("taxonomy completeness", () => {
  it("every kind has a retry/health profile", () => {
    const kinds = [
      "rate-limit",
      "timeout",
      "network",
      "server",
      "auth",
      "unavailable",
      "stream-incomplete",
      "quota",
      "bad-request",
      "permission",
      "cancelled",
      "schema",
      "unknown",
    ] as const;
    for (const kind of kinds) {
      const profile = failureProfile(kind);
      expect(profile.kind).toBe(kind);
      expect(typeof profile.retryable).toBe("boolean");
      expect(typeof profile.affectsHealth).toBe("boolean");
      expect(isRetryableKind(kind)).toBe(profile.retryable);
      expect(affectsProviderHealth(kind)).toBe(profile.affectsHealth);
    }
  });

  it("an unrecognised failure is terminal and health-neutral, never a silent retry", () => {
    const c = classifyProviderFailure(new Error("something novel happened"));
    expect(c.kind).toBe("unknown");
    expect(c.retryable).toBe(false);
    expect(c.affectsHealth).toBe(false);
  });
});
