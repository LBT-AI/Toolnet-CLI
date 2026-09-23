import { describe, expect, test } from "bun:test";
import { CONTEXT_EVAL_CASES, runContextEval } from "../../eval/contextEval";
import { buildMetrics } from "../../eval/runner";
import type { EvalCaseResult } from "../../eval/types";

describe("context eval suite", () => {
  test("every deterministic case passes", async () => {
    const report = await runContextEval();
    const failures = report.results.filter((result) => !result.passed);
    expect(failures.map((failure) => `${failure.id}: ${failure.detail}`)).toEqual([]);
    expect(report.passed).toBe(CONTEXT_EVAL_CASES.length);
    expect(report.failed).toBe(0);
  });

  test("a subset can be replayed by id", async () => {
    const report = await runContextEval(["output-capacity-reserved", "no-progress-compaction-terminates"]);
    expect(report.results.map((result) => result.id)).toEqual([
      "output-capacity-reserved",
      "no-progress-compaction-terminates",
    ]);
    expect(report.failed).toBe(0);
  });

  test("compaction cases report a measurable before/after", async () => {
    const report = await runContextEval(["large-transcript-compacts"]);
    const result = report.results[0];
    expect(result.passed).toBe(true);
    expect(result.beforeTokens).toBeGreaterThan(result.afterTokens!);
  });
});

describe("eval context metrics", () => {
  const base = (overrides: Partial<EvalCaseResult>): EvalCaseResult => ({
    caseId: "c",
    name: "case",
    type: "TOOL",
    pass: true,
    score: 1,
    detail: "",
    durationMs: 1,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    duplicateToolCalls: 0,
    retries: 0,
    ...overrides,
  });

  test("context metrics aggregate only across cases that reported them", () => {
    const metrics = buildMetrics([
      base({ context: { estimatedInputTokens: 1000, actualInputTokens: 900, compactions: 1, cacheHits: 2 } }),
      base({ context: { estimatedInputTokens: 3000, compactions: 1 } }),
      base({}),
    ]);
    expect(metrics.context).toBeDefined();
    expect(metrics.context!.meanEstimatedInputTokens).toBe(2000);
    expect(metrics.context!.meanActualInputTokens).toBe(450);
    expect(metrics.context!.totalCompactions).toBe(2);
    expect(metrics.context!.meanCacheHits).toBe(1);
  });

  test("a run with no context metrics stays backward compatible", () => {
    const metrics = buildMetrics([base({})]);
    expect(metrics.context).toBeUndefined();
  });
});
