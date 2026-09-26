import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runBoundedCompaction,
  withCompactionLock,
  isCompactionInFlight,
  DEFAULT_MAX_PASSES,
} from "../compaction";
import type { PruneStepResult, SummaryStepResult } from "../compaction";
import { computeContextBudget } from "../budget";
import { ContextCache, hashContent, tokenCacheKey } from "../cache";
import { ContextManager } from "../manager";
import { sessionStore } from "../../session/store";
import { normalizeWorkspaceIdentity } from "../../session/workspace";
import { readJournal, readCheckpoints } from "../../session/journal";
import { sessionPathsFor } from "../../session/paths";
import type { EstimatableMessage } from "../estimator";

function filler(targetTokens: number): EstimatableMessage {
  // ~3.8 characters per token for latin prose.
  return { role: "user", content: "x".repeat(targetTokens * 4) };
}

const pruneNothing = (): PruneStepResult => ({ messages: [], prunedCount: 0 });

describe("bounded compaction", () => {
  test("does not run at all when the context is inside its budget", async () => {
    const messages: EstimatableMessage[] = [{ role: "user", content: "small task" }];
    const outcome = await runBoundedCompaction({ messages, model: "openai/gpt-4o" });
    expect(outcome.compacted).toBe(false);
    expect(outcome.failure).toBe("nothing_to_compact");
    expect(outcome.passes).toBe(0);
    expect(outcome.messages).toBe(messages);
  });

  test("a verified overflow forces a run even inside the estimated budget", async () => {
    const messages: EstimatableMessage[] = [{ role: "user", content: "small task" }];
    const outcome = await runBoundedCompaction({
      messages,
      model: "openai/gpt-4o",
      overflowObserved: true,
      prune: () => pruneNothing(),
    });
    expect(outcome.compacted).toBe(false);
    // It ran (no longer "nothing to compact") and stopped with a real reason.
    expect(outcome.failure).not.toBe("nothing_to_compact");
  });

  test("a pass that reduces nothing terminates the run instead of repeating", async () => {
    const messages: EstimatableMessage[] = [filler(40_000)];
    const outcome = await runBoundedCompaction({
      messages,
      model: "openai/gpt-4o",
      force: true,
      summarize: () => ({ compacted: true, messages }),
    });
    expect(outcome.compacted).toBe(false);
    expect(outcome.failure).toBe("no_reduction");
    expect(outcome.passes).toBeLessThanOrEqual(DEFAULT_MAX_PASSES);
  });

  test("a pass that makes the estimate larger is refused", async () => {
    const messages: EstimatableMessage[] = [filler(40_000)];
    const outcome = await runBoundedCompaction({
      messages,
      model: "openai/gpt-4o",
      force: true,
      summarize: () => ({ compacted: true, messages: [...messages, filler(5_000)] }),
    });
    expect(outcome.compacted).toBe(false);
    expect(outcome.failure).toBe("increased");
  });

  test("a reduction too small to matter is reported as insufficient, not as success", async () => {
    const messages: EstimatableMessage[] = [filler(100_000)];
    const trimmed: EstimatableMessage[] = [{ role: "user", content: "x".repeat(100_000 * 4 - 4) }];
    const outcome = await runBoundedCompaction({
      messages,
      model: "openai/gpt-4o",
      force: true,
      summarize: () => ({ compacted: true, messages: trimmed }),
    });
    expect(outcome.compacted).toBe(false);
    expect(outcome.failure).toBe("insufficient_reduction");
  });

  test("progress is required proportionally, so a narrow window can still compact", async () => {
    const messages: EstimatableMessage[] = [filler(4_000)];
    const trimmed: EstimatableMessage[] = [{ role: "user", content: "x".repeat(1_000 * 4) }];
    const outcome = await runBoundedCompaction({
      messages,
      model: "openai/gpt-4o",
      force: true,
      summarize: () => ({ compacted: true, messages: trimmed }),
    });
    expect(outcome.compacted).toBe(true);
    expect(outcome.savedTokens).toBeGreaterThan(0);
    expect(outcome.record).toBeDefined();
  });

  test("a refused summary is never retried", async () => {
    let attempts = 0;
    const messages: EstimatableMessage[] = [filler(40_000)];
    const outcome = await runBoundedCompaction({
      messages,
      model: "openai/gpt-4o",
      force: true,
      prune: () => ({ messages: [filler(20_000)], prunedCount: 1 }),
      summarize: () => {
        attempts += 1;
        return { compacted: false, messages, reason: "tool-call pairs broken" };
      },
    });
    expect(attempts).toBe(1);
    // The refusal only rules out further summarization. Reduction the cleanup
    // pass already achieved is real and is kept, so the run succeeds as a prune.
    expect(outcome.compacted).toBe(true);
    expect(outcome.record?.strategy).toBe("prune");
  });

  test("a refused summary with nothing else to fall back on fails deterministically", async () => {
    const messages: EstimatableMessage[] = [filler(40_000)];
    const outcome = await runBoundedCompaction({
      messages,
      model: "openai/gpt-4o",
      force: true,
      summarize: () => ({ compacted: false, messages, reason: "tool-call pairs broken" }),
    });
    expect(outcome.compacted).toBe(false);
    expect(outcome.failure).toBe("refused_integrity");
    expect(outcome.messages).toBe(messages);
  });

  test("passes are bounded, so a strategy that keeps succeeding cannot loop forever", async () => {
    const messages: EstimatableMessage[] = [filler(60_000)];
    let calls = 0;
    const outcome = await runBoundedCompaction({
      messages,
      model: "openai/gpt-4o",
      force: true,
      maxPasses: 1,
      summarize: () => {
        calls += 1;
        return { compacted: true, messages: [{ role: "user", content: "x".repeat(20_000) }] };
      },
    });
    expect(calls).toBeLessThanOrEqual(1);
    expect(outcome.passes).toBeLessThanOrEqual(1);
  });

  test("a pre-aborted signal cancels before any step runs", async () => {
    const messages: EstimatableMessage[] = [filler(40_000)];
    let calls = 0;
    const outcome = await runBoundedCompaction({
      messages,
      model: "openai/gpt-4o",
      force: true,
      signal: AbortSignal.abort(),
      summarize: () => {
        calls += 1;
        return { compacted: true, messages: [] };
      },
    });
    expect(calls).toBe(0);
    expect(outcome.failure).toBe("cancelled");
    expect(outcome.compacted).toBe(false);
  });

  test("an abort observed mid-run stops the remaining passes", async () => {
    const controller = new AbortController();
    const messages: EstimatableMessage[] = [filler(60_000)];
    const outcome = await runBoundedCompaction({
      messages,
      model: "openai/gpt-4o",
      force: true,
      signal: controller.signal,
      prune: () => {
        controller.abort();
        return { messages: [{ role: "user", content: "x" }], prunedCount: 1 };
      },
    });
    expect(outcome.failure).toBe("cancelled");
  });

  test("a prune-only strategy reports success when it alone clears the requirement", async () => {
    const messages: EstimatableMessage[] = [filler(60_000)];
    const outcome = await runBoundedCompaction({
      messages,
      model: "openai/gpt-4o",
      force: true,
      prune: () => ({ messages: [{ role: "user", content: "x".repeat(4_000) }], prunedCount: 3 }),
    });
    expect(outcome.compacted).toBe(true);
    expect(outcome.record?.strategy).toBe("prune");
  });

  test("compaction for one session serializes rather than racing", async () => {
    const order: string[] = [];
    const first = withCompactionLock("sess-1", async () => {
      order.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first:end");
    });
    const second = withCompactionLock("sess-1", () => {
      order.push("second:start");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
    // Once the queue drains the lock must be RELEASED. A retained entry would
    // leak per session and, because cleanup used to be inverted, could also let
    // a settling first compaction delete a queued second one's lock.
    expect(isCompactionInFlight("sess-1")).toBe(false);
  });
});

describe("context cache", () => {
  test("file content is verified before it is trusted, so an edit is a miss", () => {
    const cache = new ContextCache();
    let content = "version one";
    let stat = { size: content.length, mtimeMs: 1000 };
    const read = () => content;

    const first = cache.getFile("/tmp/a.ts", () => stat, read);
    expect(first).toEqual({ content: "version one", hit: false });

    const second = cache.getFile("/tmp/a.ts", () => stat, read);
    expect(second?.hit).toBe(true);

    content = "version two, longer";
    stat = { size: content.length, mtimeMs: 2000 };
    const third = cache.getFile("/tmp/a.ts", () => stat, read);
    expect(third).toEqual({ content: "version two, longer", hit: false });
    expect(cache.stats().invalidations).toBeGreaterThan(0);
  });

  test("a missing file invalidates any entry rather than serving stale content", () => {
    const cache = new ContextCache();
    cache.setFile("/tmp/gone.ts", "stale", { size: 5, mtimeMs: 1 });
    expect(cache.getFile("/tmp/gone.ts", () => null, () => null)).toBeNull();
    expect(cache.stats().entries).toBe(0);
  });

  test("explicit invalidation covers a same-size write in the same millisecond", () => {
    const cache = new ContextCache();
    let content = "AAAA";
    const stat = { size: 4, mtimeMs: 777 };
    cache.getFile("/tmp/same.ts", () => stat, () => content);
    content = "BBBB";
    cache.invalidatePath("/tmp/same.ts");
    expect(cache.getFile("/tmp/same.ts", () => stat, () => content)).toEqual({ content: "BBBB", hit: false });
  });

  test("the cache is bounded by entry count and evicts deterministically", () => {
    const cache = new ContextCache({ maxEntries: 2 });
    cache.setFile("/a", "a".repeat(10), { size: 10, mtimeMs: 1 });
    cache.setFile("/b", "b".repeat(10), { size: 10, mtimeMs: 1 });
    cache.setFile("/c", "c".repeat(10), { size: 10, mtimeMs: 1 });
    expect(cache.stats().entries).toBeLessThanOrEqual(2);
    expect(cache.stats().evictions).toBeGreaterThan(0);
  });

  test("the cache is bounded by bytes", () => {
    const cache = new ContextCache({ maxEntries: 1000, maxBytes: 1024 });
    for (let i = 0; i < 50; i++) {
      cache.setFile(`/file-${i}`, "z".repeat(500), { size: 500, mtimeMs: 1 });
    }
    expect(cache.stats().bytes).toBeLessThanOrEqual(1024);
  });

  test("a token estimate is keyed by content, so changed text is a different entry", () => {
    const cache = new ContextCache();
    const key = tokenCacheKey("hello world", "m");
    expect(cache.getTokenEstimate(key)).toBeNull();
    cache.setTokenEstimate(key, { tokens: 3, confidence: "low", source: "estimated" });
    expect(cache.getTokenEstimate(key)).toEqual({ tokens: 3, confidence: "low", source: "estimated" });
    expect(cache.getTokenEstimate(tokenCacheKey("hello world!", "m"))).toBeNull();
    expect(hashContent("a")).not.toBe(hashContent("b"));
  });

  test("clearing the cache leaves no derived state behind", () => {
    const cache = new ContextCache();
    cache.setFile("/a", "aaa", { size: 3, mtimeMs: 1 });
    cache.setTokenEstimate(tokenCacheKey("a", "m"), { tokens: 1, confidence: "low", source: "estimated" });
    cache.clear();
    const stats = cache.stats();
    expect(stats.entries).toBe(0);
    expect(stats.bytes).toBe(0);
    // A cleared cache still answers, it just answers cold.
    expect(cache.getFile("/a", () => ({ size: 3, mtimeMs: 1 }), () => "aaa")?.hit).toBe(false);
  });
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-context-"));
  process.env.TOOLNETCLI_SESSIONS_DIR = tmpDir;
  sessionStore.resetCache();
});

afterEach(() => {
  delete process.env.TOOLNETCLI_SESSIONS_DIR;
  sessionStore.resetCache();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe("context manager", () => {
  test("a normal short request is returned untouched and never compacts", async () => {
    const events: string[] = [];
    const manager = new ContextManager();
    const messages: EstimatableMessage[] = [
      { role: "system", content: "instructions" },
      { role: "user", content: "say hello" },
    ];
    const result = await manager.prepare({
      messages,
      model: "openai/gpt-4o",
      onEvent: (event) => events.push(event.type),
      summarize: () => {
        throw new Error("compaction must not run for a short request");
      },
    });
    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
    expect(events).toEqual(["context:planned"]);
  });

  test("compaction is reported through the context lifecycle events", async () => {
    const events: string[] = [];
    const manager = new ContextManager();
    const result = await manager.prepare({
      messages: [filler(60_000)],
      model: "openai/gpt-4o",
      force: true,
      onEvent: (event) => events.push(event.type),
      summarize: () => ({ compacted: true, messages: [{ role: "user", content: "x".repeat(4_000) }] }),
    });
    expect(result.compacted).toBe(true);
    expect(events).toContain("context:planned");
    expect(events).toContain("context:compaction_started");
    expect(events).toContain("context:compaction_completed");
  });

  test("a compaction that cannot progress reports failure instead of looping", async () => {
    const events: string[] = [];
    let attempts = 0;
    const manager = new ContextManager();
    const messages: EstimatableMessage[] = [filler(60_000)];
    const result = await manager.prepare({
      messages,
      model: "openai/gpt-4o",
      force: true,
      onEvent: (event) => events.push(event.type),
      summarize: () => {
        attempts += 1;
        return { compacted: true, messages };
      },
    });
    expect(result.compacted).toBe(false);
    expect(attempts).toBeLessThanOrEqual(1);
    expect(events).toContain("context:compaction_failed");
  });

  test("compaction does not terminate the task: the working window survives", async () => {
    const manager = new ContextManager();
    const result = await manager.prepare({
      messages: [filler(60_000), { role: "user", content: "keep going" }],
      model: "openai/gpt-4o",
      force: true,
      summarize: (current) => ({
        compacted: true,
        messages: [
          { role: "assistant", content: "[Context Compaction Summary]\nprevious work summarized" },
          ...current.slice(-1),
        ],
      }),
    });
    expect(result.compacted).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages.some((message) => message.content === "keep going")).toBe(true);
    // The turn is still active: compaction is a lifecycle event, not an answer.
    expect(result.budget.estimatedInput).toBeLessThan(60_000);
  });

  test("a successful compaction is journaled and checkpointed for the session", async () => {
    const workspace = normalizeWorkspaceIdentity(tmpDir);
    const session = sessionStore.create({ title: "context", workspace });
    const manager = new ContextManager();
    const result = await manager.prepare({
      messages: [filler(60_000)],
      model: "openai/gpt-4o",
      force: true,
      sessionId: session.id,
      summarize: () => ({ compacted: true, messages: [{ role: "user", content: "x".repeat(4_000) }] }),
    });
    expect(result.compacted).toBe(true);

    const paths = sessionPathsFor(session.id, tmpDir);
    const journal = readJournal(paths.journal);
    expect(journal.events.some((event) => event.type === "context.compaction")).toBe(true);
    const checkpoints = readCheckpoints(paths.checkpoints);
    expect(checkpoints.checkpoints.length).toBeGreaterThan(0);
    const reloaded = sessionStore.load(session.id);
    expect(reloaded?.checkpointHead).toBeTruthy();
    expect(result.record?.sourceEventRange).toBeDefined();
  });

  test("a context optimization never creates session files for an unknown session id", async () => {
    const manager = new ContextManager();
    const result = await manager.prepare({
      messages: [filler(60_000)],
      model: "openai/gpt-4o",
      force: true,
      sessionId: "sess_does_not_exist_9999",
      summarize: () => ({ compacted: true, messages: [{ role: "user", content: "x".repeat(4_000) }] }),
    });
    expect(result.compacted).toBe(true);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  test("planning and budgeting are local work: no provider is contacted", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("the context layer must not perform network calls");
    }) as unknown as typeof fetch;
    try {
      const manager = new ContextManager();
      const result = await manager.prepare({
        messages: [filler(60_000)],
        model: "openai/gpt-4o",
        force: true,
        summarize: () => ({ compacted: true, messages: [{ role: "user", content: "x".repeat(4_000) }] }),
      });
      expect(result.compacted).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the reported budget matches the projected request size", () => {
    const manager = new ContextManager();
    const budget = manager.budget({ messages: [filler(1_000)], model: "openai/gpt-4o" });
    expect(manager.projected(budget)).toBe(budget.reservedSystem + budget.reservedTools + budget.estimatedInput);
    expect(computeContextBudget({ messages: [filler(1_000)], model: "openai/gpt-4o" }).contextWindow).toBe(
      budget.contextWindow,
    );
  });
});
