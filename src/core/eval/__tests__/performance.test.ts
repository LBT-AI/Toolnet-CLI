import { describe, expect, it } from "bun:test";
import {
  MIN_SAMPLES,
  aggregatePerformance,
  indexProfiles,
  isProfileEmpty,
  type PerformanceSample,
} from "../../models/performance";
import { profilesFromSamples, profilesFromRecords, samplesFromRecords } from "../profile";
import type { EvalRunRecord } from "../types";
import { EVAL_RUN_SCHEMA_VERSION } from "../schema";

function sample(overrides: Partial<PerformanceSample> = {}): PerformanceSample {
  return {
    modelId: "openrouter/model-a",
    providerId: "openrouter",
    success: true,
    durationMs: 500,
    costUsd: 0.01,
    toolCalls: 0,
    failedToolCalls: 0,
    ...overrides,
  };
}

describe("Phase 80 — performance profiles", () => {
  it("returns null for an empty sample set", () => {
    expect(aggregatePerformance([])).toBeNull();
  });

  it("marks every dimension insufficient below the minimum sample count", () => {
    const profile = aggregatePerformance([sample(), sample()]);
    expect(profile?.samples).toBe(2);
    expect(profile?.insufficient).toContain("reliability");
    expect(profile?.scores.reliability).toBeUndefined();
  });

  it("scores reliability once enough samples exist", () => {
    const profile = aggregatePerformance([
      sample({ success: true }),
      sample({ success: true }),
      sample({ success: false }),
    ]);
    expect(profile?.scores.reliability).toBeCloseTo(0.667, 2);
  });

  it("only scores a dimension from its own cases", () => {
    const profile = aggregatePerformance([
      sample({ dimension: "coding", success: true }),
      sample({ dimension: "coding", success: true }),
      sample({ dimension: "coding", success: false }),
      sample({ dimension: "reasoning", success: false }),
    ]);
    expect(profile?.scores.coding).toBeCloseTo(0.667, 2);
    // reasoning had only one case → insufficient, never a low score.
    expect(profile?.scores.reasoning).toBeUndefined();
    expect(profile?.insufficient).toContain("reasoning");
  });

  it("penalizes failed tool calls inside otherwise successful cases", () => {
    const clean = aggregatePerformance([
      sample({ toolCalls: 1, failedToolCalls: 0, dimension: "toolUse" }),
      sample({ toolCalls: 1, failedToolCalls: 0, dimension: "toolUse" }),
      sample({ toolCalls: 1, failedToolCalls: 0, dimension: "toolUse" }),
    ]);
    const dirty = aggregatePerformance([
      sample({ toolCalls: 1, failedToolCalls: 1, dimension: "toolUse" }),
      sample({ toolCalls: 1, failedToolCalls: 1, dimension: "toolUse" }),
      sample({ toolCalls: 1, failedToolCalls: 1, dimension: "toolUse" }),
    ]);
    expect(clean?.scores.toolUse).toBeGreaterThan(dirty?.scores.toolUse ?? 0);
  });

  it("scores latency and cost from observed values", () => {
    const fast = aggregatePerformance([
      sample({ durationMs: 100, costUsd: 0.001 }),
      sample({ durationMs: 100, costUsd: 0.001 }),
      sample({ durationMs: 100, costUsd: 0.001 }),
    ]);
    const slow = aggregatePerformance([
      sample({ durationMs: 6000, costUsd: 0.5 }),
      sample({ durationMs: 6000, costUsd: 0.5 }),
      sample({ durationMs: 6000, costUsd: 0.5 }),
    ]);
    expect(fast?.scores.latency).toBeGreaterThan(slow?.scores.latency ?? 0);
    expect(fast?.scores.costEfficiency).toBeGreaterThan(slow?.scores.costEfficiency ?? 0);
  });

  it("leaves latency and cost unscored when the provider reported nothing", () => {
    const profile = aggregatePerformance([
      sample({ durationMs: undefined, costUsd: undefined }),
      sample({ durationMs: undefined, costUsd: undefined }),
      sample({ durationMs: undefined, costUsd: undefined }),
    ]);
    expect(profile?.insufficient).toContain("latency");
    expect(profile?.insufficient).toContain("costEfficiency");
  });

  it("believes the documented minimum sample constant", () => {
    expect(MIN_SAMPLES).toBeGreaterThanOrEqual(3);
  });

  it("indexes profiles by model with the newest winning", () => {
    const older = aggregatePerformance([
      sample({ success: true }),
      sample({ success: true }),
      sample({ success: true }),
    ])!;
    const newer = { ...older, updatedAt: older.updatedAt + 1000, samples: 9 };
    const map = indexProfiles([older, newer]);
    expect(map.get("openrouter/model-a")?.samples).toBe(9);
  });

  it("detects an empty profile", () => {
    expect(isProfileEmpty(undefined)).toBe(true);
    expect(isProfileEmpty({ modelId: "m", providerId: "p", samples: 0, scores: {}, insufficient: [], updatedAt: 0 })).toBe(true);
  });

  it("groups samples per model when building profiles", () => {
    const profiles = profilesFromSamples([
      sample({ modelId: "openrouter/a" }),
      sample({ modelId: "openrouter/a" }),
      sample({ modelId: "openrouter/a" }),
      sample({ modelId: "toolnet/b" }),
    ]);
    expect(profiles.map((profile) => profile.modelId)).toEqual(["openrouter/a", "toolnet/b"]);
    expect(profiles[0].samples).toBe(3);
  });

  it("maps stored run cases into samples and profiles", () => {
    const record: EvalRunRecord = {
      schemaVersion: EVAL_RUN_SCHEMA_VERSION,
      runId: "r1",
      suiteId: "coding",
      suiteVersion: "1.0.0",
      model: "model-a",
      provider: "openrouter",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 100,
      passed: 1,
      failed: 0,
      metrics: {
        passRate: 1,
        meanDurationMs: 100,
        meanInputTokens: 5,
        meanOutputTokens: 5,
        totalToolCalls: 1,
        totalFailedToolCalls: 0,
        byType: {},
      },
      cases: [
        {
          caseId: "code-fix-bug",
          name: "Fix",
          type: "CODE",
          pass: true,
          score: 1,
          detail: "",
          durationMs: 100,
          inputTokens: 5,
          outputTokens: 5,
          toolCalls: 1,
          failedToolCalls: 0,
          duplicateToolCalls: 0,
          retries: 0,
        },
      ],
    };

    const samples = samplesFromRecords([record]);
    expect(samples).toHaveLength(1);
    expect(samples[0].modelId).toBe("openrouter/model-a");
    expect(samples[0].dimension).toBe("coding");

    const profiles = profilesFromRecords([record]);
    expect(profiles[0].providerId).toBe("openrouter");
  });
});
