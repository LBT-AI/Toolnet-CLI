import { describe, expect, it } from "bun:test";
import { FAILURE_THRESHOLD, ProviderHealthTracker, healthRank } from "../health";

describe("Phase 79 — provider health", () => {
  it("starts unknown with zero counters", () => {
    const tracker = new ProviderHealthTracker();
    const health = tracker.get("p");
    expect(health.state).toBe("unknown");
    expect(health.requestCount).toBe(0);
    expect(health.successCount).toBe(0);
    expect(health.failureCount).toBe(0);
  });

  it("moves to healthy on success", () => {
    const tracker = new ProviderHealthTracker();
    const health = tracker.recordSuccess("p", 100);
    expect(health.state).toBe("healthy");
    expect(health.successCount).toBe(1);
    expect(health.consecutiveFailures).toBe(0);
    expect(health.latencyMs).toBe(100);
  });

  it("degrades on the first failure and becomes unavailable after the threshold", () => {
    const tracker = new ProviderHealthTracker();
    expect(tracker.recordFailure("p", "e1").state).toBe("degraded");
    expect(tracker.recordFailure("p", "e2").state).toBe("degraded");

    for (let i = 2; i < FAILURE_THRESHOLD; i++) tracker.recordFailure("p", `e${i}`);
    expect(tracker.get("p").state).toBe("unavailable");
    expect(tracker.get("p").consecutiveFailures).toBe(FAILURE_THRESHOLD);
  });

  it("recovers to healthy after a success following failures", () => {
    const tracker = new ProviderHealthTracker();
    for (let i = 0; i < FAILURE_THRESHOLD; i++) tracker.recordFailure("p", "boom");
    expect(tracker.get("p").state).toBe("unavailable");

    const recovered = tracker.recordSuccess("p", 50);
    expect(recovered.state).toBe("healthy");
    expect(recovered.consecutiveFailures).toBe(0);
  });

  it("smooths latency with an EMA", () => {
    const tracker = new ProviderHealthTracker();
    tracker.recordSuccess("p", 100);
    const second = tracker.recordSuccess("p", 200);
    // 100 * 0.7 + 200 * 0.3
    expect(second.latencyMs).toBeCloseTo(130, 5);
  });

  it("ignores non-finite latency samples", () => {
    const tracker = new ProviderHealthTracker();
    tracker.recordSuccess("p", 100);
    const next = tracker.recordSuccess("p", Number.NaN);
    expect(next.latencyMs).toBe(100);
  });

  it("redacts credential-shaped text from the stored error", () => {
    const tracker = new ProviderHealthTracker();
    const health = tracker.recordFailure("p", "upstream said sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(health.lastError).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(health.lastError).toContain("[REDACTED]");
  });

  it("can be marked unavailable explicitly", () => {
    const tracker = new ProviderHealthTracker();
    tracker.markUnavailable("p", "auth rejected");
    expect(tracker.get("p").state).toBe("unavailable");
  });

  it("resets a single provider or everything", () => {
    const tracker = new ProviderHealthTracker();
    tracker.recordSuccess("a", 1);
    tracker.recordSuccess("b", 1);

    tracker.reset("a");
    expect(tracker.get("a").requestCount).toBe(0);
    expect(tracker.get("b").requestCount).toBe(1);

    tracker.reset();
    expect(tracker.get("b").requestCount).toBe(0);
  });

  it("ranks health states deterministically", () => {
    expect(healthRank("healthy")).toBeLessThan(healthRank("unknown"));
    expect(healthRank("unknown")).toBeLessThan(healthRank("degraded"));
    expect(healthRank("degraded")).toBeLessThan(healthRank("unavailable"));
  });
});
