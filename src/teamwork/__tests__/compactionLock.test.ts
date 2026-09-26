/**
 * Regression: per-session compaction serialization.
 *
 * The original `withCompactionLock` had an inverted cleanup guard
 * (`if (inFlight.get(key) === undefined) inFlight.delete(key)`) that NEVER
 * deleted, so the lock map leaked; and because it was not identity-based, a
 * finishing A could delete a queued B's lock. It was also never applied on the
 * canonical `ContextManager.prepare` path.
 *
 * Cases A–F below pin the contract: same session serializes, different
 * sessions stay independent, the lock is released on success AND failure, a
 * settling A never drops B's lock, and a later compaction still runs.
 */

import { describe, it, expect } from "bun:test";
import {
  withCompactionLock,
  isCompactionInFlight,
  compactionLockKey,
} from "../../core/context/compaction";
import { ContextManager } from "../../core/context/manager";
import { ContextEngine } from "../../lib/context/contextEngine";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── A–F: lock primitive ─────────────────────────────────────────────────────

describe("withCompactionLock — serialization & cleanup", () => {
  it("A. serializes two compactions for the SAME session (max 1 concurrent)", async () => {
    const key = compactionLockKey("sess-a");
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const releaseFirst = deferred<void>();

    const first = withCompactionLock(key, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push("start1");
      await releaseFirst.promise;
      order.push("end1");
      active--;
    });
    const second = withCompactionLock(key, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push("start2");
      active--;
    });

    await delay(10);
    expect(order).toEqual(["start1"]); // second queued, not started

    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual(["start1", "end1", "start2"]);
    expect(maxActive).toBe(1);
  });

  it("B. different sessions run independently", async () => {
    const keyA = compactionLockKey("sess-A");
    const keyB = compactionLockKey("sess-B");
    const blockA = deferred<void>();

    const a = withCompactionLock(keyA, () => blockA.promise);
    let bRan = false;
    const b = withCompactionLock(keyB, () => {
      bRan = true;
    });

    await delay(10);
    expect(bRan).toBe(true); // B is not blocked by A's session lock
    blockA.resolve();
    await Promise.all([a, b]);
  });

  it("C. releases the lock after success", async () => {
    const key = compactionLockKey("sess-c");
    const result = await withCompactionLock(key, () => 42);
    expect(result).toBe(42);
    expect(isCompactionInFlight(key)).toBe(false);
  });

  it("D. releases the lock after a failure", async () => {
    const key = compactionLockKey("sess-d");
    await expect(
      withCompactionLock(key, () => {
        throw new Error("compaction boom");
      }),
    ).rejects.toThrow("compaction boom");
    expect(isCompactionInFlight(key)).toBe(false);
  });

  it("E. a settling A must not delete B's queued lock", async () => {
    const key = compactionLockKey("sess-e");
    const finishA = deferred<void>();
    const finishB = deferred<void>();

    const a = withCompactionLock(key, () => finishA.promise);
    const b = withCompactionLock(key, () => finishB.promise);

    finishA.resolve();
    await a;
    await delay(10);

    // A has settled but B is still running: the lock must still exist.
    expect(isCompactionInFlight(key)).toBe(true);

    finishB.resolve();
    await b;
    expect(isCompactionInFlight(key)).toBe(false);
  });

  it("F. a later compaction still runs after a previous one settles", async () => {
    const key = compactionLockKey("sess-f");
    const seen: number[] = [];

    await withCompactionLock(key, () => {
      seen.push(1);
    });
    await withCompactionLock(key, () => {
      seen.push(2);
    });

    expect(seen).toEqual([1, 2]);
    expect(isCompactionInFlight(key)).toBe(false);
  });
});

// ── Canonical ContextManager.prepare path ───────────────────────────────────

describe("ContextManager.prepare — per-session compaction is serialized", () => {
  const bigMessages = Array.from({ length: 60 }, (_, i) => ({
    role: "user" as const,
    content: `message ${i} ${"padding ".repeat(60)}`,
  }));

  it("never runs two compactions for the same session concurrently", async () => {
    const manager = new ContextManager();
    let active = 0;
    let maxActive = 0;

    const summarize = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(20);
      active--;
      return { compacted: true, messages: [{ role: "user" as const, content: "summary" }] };
    };

    const base = {
      messages: bigMessages,
      force: true,
      minSavingsTokens: 1,
      minSavingsRatio: 0,
      summarize,
    };

    await Promise.all([
      manager.prepare({ ...base, sessionId: "sess-prep" }),
      manager.prepare({ ...base, sessionId: "sess-prep" }),
    ]);

    expect(maxActive).toBe(1);
    expect(isCompactionInFlight(compactionLockKey("sess-prep"))).toBe(false);
  });

  it("lets different sessions compact in parallel", async () => {
    const manager = new ContextManager();
    let active = 0;
    let maxActive = 0;

    const summarize = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(20);
      active--;
      return { compacted: true, messages: [{ role: "user" as const, content: "summary" }] };
    };

    const base = {
      messages: bigMessages,
      force: true,
      minSavingsTokens: 1,
      minSavingsRatio: 0,
      summarize,
    };

    await Promise.all([
      manager.prepare({ ...base, sessionId: "sess-par-A" }),
      manager.prepare({ ...base, sessionId: "sess-par-B" }),
    ]);

    expect(maxActive).toBe(2);
    expect(isCompactionInFlight(compactionLockKey("sess-par-A"))).toBe(false);
    expect(isCompactionInFlight(compactionLockKey("sess-par-B"))).toBe(false);
  });

  it("serializes the /compact entry (ContextEngine.compact) on the same lock", async () => {
    const engine = new ContextEngine();
    const key = compactionLockKey("sess-compact");
    const blocker = deferred<void>();
    const held = withCompactionLock(key, () => blocker.promise);

    let settled = false;
    const compacting = engine
      .compact([{ role: "user", content: "only a short turn" }], { sessionId: "sess-compact", force: true })
      .then(() => {
        settled = true;
      });

    await delay(10);
    expect(settled).toBe(false); // queued behind the held lock

    blocker.resolve();
    await held;
    await compacting;
    expect(settled).toBe(true);
  });

  it("does not acquire the lock when compaction is skipped", async () => {
    const manager = new ContextManager();
    const result = await manager.prepare({
      messages: [{ role: "user", content: "short turn" }],
      sessionId: "sess-skip",
    });
    expect(result.compacted).toBe(false);
    expect(isCompactionInFlight(compactionLockKey("sess-skip"))).toBe(false);
  });
});
