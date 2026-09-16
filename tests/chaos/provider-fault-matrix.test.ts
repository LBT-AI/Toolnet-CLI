/**
 * Deterministic chaos: provider fault matrix.
 *
 * Each case scripts one upstream fault, then asserts the FINAL system state —
 * how many attempts were made, whether the operation was allowed to fail, and
 * how the failure was classified. The invariant under test throughout: a
 * half-finished request is never reported as success, and no retry loop is
 * unbounded.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { OpenAICompatibleProvider } from "../../src/providers/openaiCompatible";
import { classifyProviderFailure } from "../../src/core/models/failureKind";
import { requireStreamTerminal } from "../../src/lib/streamReliability";
import { createFaultServer, createResetServer, type FaultServer } from "./helpers/faultServer";

let server: FaultServer | null = null;

afterEach(() => {
  server?.close();
  server = null;
});

function provider(url: string) {
  return new OpenAICompatibleProvider({ id: "fault", name: "Fault", baseUrl: url, apiKey: "test-key" });
}

const request = { model: "fault-model", messages: [{ role: "user" as const, content: "hi" }] };

describe("transient upstream faults", () => {
  it("a 503 followed by success is retried and the caller sees no error", async () => {
    server = createFaultServer({ statuses: [503, 200], turns: [{ content: "recovered" }] });
    const res = await provider(server.url).chat(request);
    expect(res.choices[0].message.content).toBe("recovered");
    expect(server.attempts()).toBe(2);
  });

  it("a permanent 503 fails after a bounded number of attempts", async () => {
    server = createFaultServer({ statuses: [503], errorBody: "upstream down" });
    let caught: unknown;
    try {
      await provider(server.url).chat(request);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(server.attempts()).toBeLessThanOrEqual(3);
    const classified = classifyProviderFailure(caught);
    expect(classified.retryable).toBe(true);
    expect(classified.affectsHealth).toBe(true);
  });

  it("a connection reset is retried and stays bounded", async () => {
    server = await createResetServer();
    let caught: unknown;
    try {
      await provider(server.url).chat(request);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(server.attempts()).toBeLessThanOrEqual(3);
    expect(classifyProviderFailure(caught).kind).toBe("network");
    expect(classifyProviderFailure(caught).retryable).toBe(true);
  });
});

describe("Retry-After", () => {
  it("honours a small Retry-After instead of the exponential default", async () => {
    server = createFaultServer({ statuses: [429, 200], headers: { "retry-after": "0" }, turns: [{ content: "after wait" }] });
    const started = Date.now();
    const res = await provider(server.url).chat(request);
    const elapsed = Date.now() - started;
    expect(res.choices[0].message.content).toBe("after wait");
    // The exponential default would have slept ~1s before the second attempt.
    expect(elapsed).toBeLessThan(900);
  });

  it("bounds an absurd Retry-After instead of sleeping forever", async () => {
    server = createFaultServer({
      statuses: [503, 200],
      headers: { "retry-after": "86400" },
      turns: [{ content: "capped" }],
    });
    const signal = new AbortController();
    setTimeout(() => signal.abort(), 250);
    const started = Date.now();
    await expect(provider(server.url).chat({ ...request, signal: signal.signal })).rejects.toThrow();
    // An unbounded 24h sleep would hang the test; the retry delay must be
    // interruptible by the caller's AbortSignal.
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("terminal upstream faults", () => {
  it("an exhausted quota 429 is NOT retried", async () => {
    server = createFaultServer({
      statuses: [429],
      errorBody: JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details" } }),
    });
    let caught: unknown;
    try {
      await provider(server.url).chat(request);
    } catch (err) {
      caught = err;
    }
    expect(server.attempts()).toBe(1);
    const classified = classifyProviderFailure(caught);
    expect(classified.kind).toBe("quota");
    expect(classified.retryable).toBe(false);
    expect(classified.affectsHealth).toBe(false);
  });

  it("a 401 is terminal and never retried", async () => {
    server = createFaultServer({ statuses: [401], errorBody: "invalid api key" });
    let caught: unknown;
    try {
      await provider(server.url).chat(request);
    } catch (err) {
      caught = err;
    }
    expect(server.attempts()).toBe(1);
    expect(classifyProviderFailure(caught).kind).toBe("auth");
    expect(classifyProviderFailure(caught).retryable).toBe(false);
  });

  it("a cancelled request is never retried", async () => {
    server = createFaultServer({ statuses: [503], headers: { "retry-after": "10" } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    let caught: unknown;
    try {
      await provider(server.url).chat({ ...request, signal: controller.signal });
    } catch (err) {
      caught = err;
    }
    expect(classifyProviderFailure(caught).kind).toBe("cancelled");
    expect(server.attempts()).toBe(1);
  });
});

describe("stream faults", () => {
  it("a truncated stream is classified STREAM_INCOMPLETE, never success", async () => {
    server = createFaultServer({ truncateStream: true, turns: [{ content: "half an answer" }] });
    const chunks: unknown[] = [];
    let finishReason: string | undefined;
    for await (const chunk of provider(server.url).stream({ ...request })) {
      chunks.push(chunk);
      const reason = (chunk as { choices?: Array<{ finish_reason?: string }> }).choices?.[0]?.finish_reason;
      if (reason) finishReason = reason;
    }

    // The provider yielded bytes, so a naive caller would call this a success.
    expect(chunks.length).toBeGreaterThan(1);
    expect(finishReason).toBeUndefined();

    let caught: unknown;
    try {
      requireStreamTerminal({ sawChunk: chunks.length > 0, sawFinishReason: finishReason != null, sawUsage: false });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const classified = classifyProviderFailure(caught);
    expect(classified.kind).toBe("stream-incomplete");
    expect(classified.retryable).toBe(true);
  });

  it("a complete stream still validates cleanly", async () => {
    server = createFaultServer({ turns: [{ content: "whole answer" }] });
    let finishReason: string | undefined;
    let sawChunk = false;
    for await (const chunk of provider(server.url).stream({ ...request })) {
      sawChunk = true;
      const reason = (chunk as { choices?: Array<{ finish_reason?: string }> }).choices?.[0]?.finish_reason;
      if (reason) finishReason = reason;
    }
    expect(sawChunk).toBe(true);
    expect(() => requireStreamTerminal({ sawChunk, sawFinishReason: finishReason != null, sawUsage: false })).not.toThrow();
  });

  it("surfaces Retry-After on a streaming failure so callers can honour it", async () => {
    server = createFaultServer({ statuses: [429], headers: { "retry-after": "7" }, errorBody: "slow down" });
    let message = "";
    try {
      for await (const _chunk of provider(server.url).stream({ ...request })) {
        // no chunks expected
      }
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("HTTP 429");
    expect(message).toContain("Retry-After: 7");
  });
});
