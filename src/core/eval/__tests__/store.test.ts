import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EvalStore } from "../store";
import { EVAL_RUN_SCHEMA_VERSION } from "../schema";
import type { EvalRunRecord } from "../types";

let dir: string;
let store: EvalStore;

function record(overrides: Partial<EvalRunRecord> = {}): EvalRunRecord {
  return {
    schemaVersion: EVAL_RUN_SCHEMA_VERSION,
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
    suiteId: "text",
    suiteVersion: "1.0.0",
    model: "model-a",
    provider: "openrouter",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 10,
    passed: 1,
    failed: 0,
    metrics: {
      passRate: 1,
      meanDurationMs: 10,
      meanInputTokens: 1,
      meanOutputTokens: 1,
      totalToolCalls: 0,
      totalFailedToolCalls: 0,
      byType: { TEXT: { passed: 1, total: 1 } },
    },
    cases: [
      {
        caseId: "text-exact",
        name: "Exact",
        type: "TEXT",
        pass: true,
        score: 1,
        detail: "exact match",
        durationMs: 10,
        inputTokens: 1,
        outputTokens: 1,
        toolCalls: 0,
        failedToolCalls: 0,
        duplicateToolCalls: 0,
        retries: 0,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "phase80-store-"));
  store = new EvalStore({ dir });
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("Phase 80 — EvalStore", () => {
  it("appends and reads back records in order", () => {
    const first = record({ runId: "run-1" });
    const second = record({ runId: "run-2" });
    expect(store.append(first)).toBe(true);
    expect(store.append(second)).toBe(true);

    expect(store.list().map((entry) => entry.runId)).toEqual(["run-1", "run-2"]);
    expect(store.listNewestFirst().map((entry) => entry.runId)).toEqual(["run-2", "run-1"]);
    expect(store.get("run-1")?.runId).toBe("run-1");
  });

  it("writes the store file with mode 0600", () => {
    store.append(record());
    expect(fs.statSync(store.indexPath).mode & 0o777).toBe(0o600);
  });

  it("returns an empty list when nothing was stored", () => {
    expect(store.list()).toEqual([]);
  });

  it("skips a torn final line without losing earlier results", () => {
    store.append(record({ runId: "run-good" }));
    fs.appendFileSync(store.indexPath, '{"runId":"torn"', "utf8");
    expect(store.list().map((entry) => entry.runId)).toEqual(["run-good"]);
  });

  it("skips records written by a newer schema", () => {
    store.append(record({ runId: "run-current" }));
    fs.appendFileSync(
      store.indexPath,
      JSON.stringify(record({ runId: "run-future", schemaVersion: EVAL_RUN_SCHEMA_VERSION + 1 })) + "\n",
      "utf8",
    );
    expect(store.list().map((entry) => entry.runId)).toEqual(["run-current"]);
  });

  it("filters by model and by suite", () => {
    store.append(record({ runId: "run-a", model: "a", suiteId: "coding" }));
    store.append(record({ runId: "run-b", model: "b", suiteId: "text" }));
    expect(store.byModel("a").map((entry) => entry.runId)).toEqual(["run-a"]);
    expect(store.byModel("openrouter/a").map((entry) => entry.runId)).toEqual(["run-a"]);
    expect(store.bySuite("text").map((entry) => entry.runId)).toEqual(["run-b"]);
  });

  it("projects stored cases into performance samples", () => {
    store.append(record({ runId: "run-samples" }));
    const samples = store.samples();
    expect(samples).toHaveLength(1);
    expect(samples[0].modelId).toBe("openrouter/model-a");
  });

  it("clears the history", () => {
    store.append(record());
    expect(store.clear()).toBe(true);
    expect(store.list()).toEqual([]);
  });
});
