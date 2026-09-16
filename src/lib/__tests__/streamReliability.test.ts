import { describe, it, expect } from "bun:test";
import {
  validateStreamTerminal,
  requireStreamTerminal,
  StreamIncompleteError,
  StreamStallWatch,
  STREAM_STALL_TIMEOUT_MS,
} from "../streamReliability";

describe("stream terminal validation", () => {
  it("a stream with a finish reason is complete regardless of usage presence", () => {
    expect(validateStreamTerminal({ sawChunk: true, sawFinishReason: true, sawUsage: false })).toBe("complete");
    expect(validateStreamTerminal({ sawChunk: true, sawFinishReason: true, sawUsage: true })).toBe("complete");
    // Tool-call-only streams still end with a terminal reason.
    expect(validateStreamTerminal({ sawChunk: true, sawFinishReason: true, sawUsage: false })).toBe("complete");
  });

  it("silent EOF after content is INCOMPLETE — never fake success", () => {
    expect(validateStreamTerminal({ sawChunk: true, sawFinishReason: false, sawUsage: false })).toBe("incomplete");
  });

  it("an empty connection that closes without evidence is INCOMPLETE", () => {
    expect(validateStreamTerminal({ sawChunk: false, sawFinishReason: false, sawUsage: false })).toBe("incomplete");
  });

  it("usage alone does not certify completion (protocol evidence is the finish reason)", () => {
    expect(validateStreamTerminal({ sawChunk: true, sawFinishReason: false, sawUsage: true })).toBe("incomplete");
  });

  it("requireStreamTerminal throws a typed retryable STREAM_INCOMPLETE error carrying evidence", () => {
    let caught: unknown;
    try {
      requireStreamTerminal({ sawChunk: true, sawFinishReason: false, sawUsage: false });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StreamIncompleteError);
    const err = caught as StreamIncompleteError;
    expect(err.retryable).toBe(true);
    expect(err.failureKind).toBe("STREAM_INCOMPLETE");
    expect(err.observation.sawChunk).toBe(true);
    expect(err.message.toLowerCase()).toContain("terminal");
  });

  it("requireStreamTerminal passes a complete stream through silently", () => {
    expect(() =>
      requireStreamTerminal({ sawChunk: true, sawFinishReason: true, sawUsage: true }),
    ).not.toThrow();
  });
});

describe("stream stall watch", () => {
  it("fires exactly once after the inactivity deadline and aborts the request", async () => {
    let stalls = 0;
    const watch = new StreamStallWatch(25, () => stalls++);
    watch.start();
    await new Promise((r) => setTimeout(r, 60));
    expect(stalls).toBe(1);
    expect(watch.stalled).toBe(true);
    watch.complete();
  });

  it("arriving chunks keep re-arming the deadline — a live stream never stalls", async () => {
    let stalls = 0;
    const watch = new StreamStallWatch(30, () => stalls++);
    watch.start();
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 12));
      watch.noteChunk();
    }
    expect(stalls).toBe(0);
    watch.complete();
  });

  it("complete() after a clean end leaves stalled false (a clean end is not inactivity)", async () => {
    let stalls = 0;
    const watch = new StreamStallWatch(20, () => stalls++);
    watch.start();
    await new Promise((r) => setTimeout(r, 5));
    watch.complete();
    await new Promise((r) => setTimeout(r, 40));
    expect(stalls).toBe(0);
    expect(watch.stalled).toBe(false);
  });

  it("a completed watch can be re-armed for the next request", async () => {
    let stalls = 0;
    const watch = new StreamStallWatch(20, () => stalls++);
    watch.start();
    watch.complete();
    watch.start();
    await new Promise((r) => setTimeout(r, 45));
    expect(stalls).toBe(1);
    watch.complete();
  });

  it("rejects non-positive or non-finite windows", () => {
    expect(() => new StreamStallWatch(0, () => undefined)).toThrow();
    expect(() => new StreamStallWatch(-5, () => undefined)).toThrow();
    expect(() => new StreamStallWatch(Number.NaN, () => undefined)).toThrow();
  });

  it("default window is bounded (never an infinite wait)", () => {
    expect(Number.isFinite(STREAM_STALL_TIMEOUT_MS)).toBe(true);
    expect(STREAM_STALL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(STREAM_STALL_TIMEOUT_MS).toBeLessThan(10 * 60 * 1000);
  });

  it("a throwing onStall callback cannot crash the consuming loop", async () => {
    const watch = new StreamStallWatch(15, () => {
      throw new Error("callback bug");
    });
    watch.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(watch.stalled).toBe(true);
    watch.complete();
  });
});
