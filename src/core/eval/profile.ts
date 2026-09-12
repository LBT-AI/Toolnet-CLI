/**
 * Phase 80 §16 — Model performance profiles from eval results.
 *
 * Thin projection layer: the aggregation rules live in
 * `src/core/models/performance.ts` (deterministic and unit-tested); this module
 * only maps stored `EvalRunRecord`s and live case results into samples.
 *
 * A profile with no usable score is still returned (`insufficient` lists what is
 * missing) so callers can show "insufficient_data" honestly instead of an
 * invented benchmark number.
 */

import {
  aggregatePerformance,
  indexProfiles,
  type ModelPerformanceProfile,
  type PerformanceSample,
} from "../models/performance";
import type { EvalCaseResult, EvalRunRecord } from "./types";

/** Map one graded case into a performance sample. */
export function sampleFromCase(
  record: Pick<EvalRunRecord, "provider" | "model">,
  entry: EvalCaseResult,
  dimension: PerformanceSample["dimension"],
): PerformanceSample {
  return {
    modelId: `${record.provider}/${record.model}`,
    providerId: record.provider,
    dimension,
    success: entry.pass,
    durationMs: entry.durationMs,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    costUsd: entry.costUsd,
    toolCalls: entry.toolCalls,
    failedToolCalls: entry.failedToolCalls,
    failureClass: entry.failureClass,
  };
}

function dimensionForType(type: EvalCaseResult["type"]): PerformanceSample["dimension"] {
  switch (type) {
    case "CODE":
      return "coding";
    case "REASONING":
      return "reasoning";
    case "STRUCTURED_OUTPUT":
      return "structuredOutput";
    case "TOOL":
      return "toolUse";
    default:
      return undefined;
  }
}

/** Every sample across a set of stored runs. */
export function samplesFromRecords(records: EvalRunRecord[]): PerformanceSample[] {
  const samples: PerformanceSample[] = [];
  for (const record of records) {
    for (const entry of record.cases) {
      samples.push(sampleFromCase(record, entry, dimensionForType(entry.type)));
    }
  }
  return samples;
}

/**
 * Build one profile per model from a sample set, grouped by model id so samples
 * from different suites merge into a single view of the model.
 */
export function profilesFromSamples(samples: PerformanceSample[]): ModelPerformanceProfile[] {
  const byModel = new Map<string, PerformanceSample[]>();
  for (const sample of samples) {
    const bucket = byModel.get(sample.modelId) ?? [];
    bucket.push(sample);
    byModel.set(sample.modelId, bucket);
  }

  const profiles: ModelPerformanceProfile[] = [];
  for (const [, bucket] of byModel) {
    const profile = aggregatePerformance(bucket);
    if (profile) profiles.push(profile);
  }
  return profiles.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

export function profilesFromRecords(records: EvalRunRecord[]): ModelPerformanceProfile[] {
  return profilesFromSamples(samplesFromRecords(records));
}

/** All profiles indexed by canonical model id, newest profile per model wins. */
export function indexRecords(records: EvalRunRecord[]): Map<string, ModelPerformanceProfile> {
  return indexProfiles(profilesFromRecords(records));
}

/** Base id without a provider prefix, for tolerant lookups. */
export function profilesByModelAlias(
  profiles: ModelPerformanceProfile[],
): Map<string, ModelPerformanceProfile> {
  const map = new Map<string, ModelPerformanceProfile>();
  for (const profile of profiles) {
    map.set(profile.modelId, profile);
    const separator = profile.modelId.indexOf("/");
    if (separator !== -1) map.set(profile.modelId.slice(separator + 1), profile);
  }
  return map;
}
