/**
 * Phase 80 §15 — EvalStore.
 *
 * No database dependency: one append-only JSONL file under
 * `~/.toolnetcli/evals/runs.jsonl`. Properties that matter:
 *
 *  - APPEND-SAFE: one record per line; a torn final line is skipped, never
 *    fatal, and never destroys earlier results.
 *  - VERSIONED: a record written by a newer schema is skipped (not misread).
 *  - SECRET-FREE: records contain ids, counts and grader details only. No
 *    prompt secrets, no credentials, no raw provider payloads.
 */

import fs from "node:fs";
import path from "node:path";
import { ensureToolnetDir, getToolnetHome } from "../../lib/toolnetHome";
import { EVAL_RUN_SCHEMA_VERSION } from "./schema";
import type { PerformanceSample } from "../models/performance";
import type { EvalRunRecord } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getEvalsDir(): string {
  return path.join(getToolnetHome(), "evals");
}

export function getEvalIndexPath(): string {
  return path.join(getEvalsDir(), "runs.jsonl");
}

/** Structural validation — a partially-written line is discarded. */
function isValidRecord(value: unknown): value is EvalRunRecord {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== EVAL_RUN_SCHEMA_VERSION) return false;
  if (typeof value.runId !== "string" || typeof value.suiteId !== "string") return false;
  if (typeof value.model !== "string" || typeof value.provider !== "string") return false;
  if (!Array.isArray(value.cases)) return false;
  return true;
}

export interface EvalStoreOptions {
  dir?: string;
}

export class EvalStore {
  private readonly dir: string;

  constructor(options: EvalStoreOptions = {}) {
    this.dir = options.dir ?? getEvalsDir();
  }

  get indexPath(): string {
    return path.join(this.dir, "runs.jsonl");
  }

  /** Append one run. Returns false when it could not be persisted. */
  append(record: EvalRunRecord): boolean {
    try {
      ensureToolnetDir(this.dir);
      fs.appendFileSync(this.indexPath, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
      try {
        fs.chmodSync(this.indexPath, 0o600);
      } catch {}
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read every valid run, oldest first. Invalid/torn/newer-schema lines are
   * skipped silently: a corrupt tail must never hide earlier results.
   */
  list(): EvalRunRecord[] {
    let text: string;
    try {
      if (!fs.existsSync(this.indexPath)) return [];
      text = fs.readFileSync(this.indexPath, "utf8");
    } catch {
      return [];
    }

    const records: EvalRunRecord[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // torn line
      }
      if (isValidRecord(parsed)) records.push(parsed);
    }
    return records;
  }

  /** Newest first. */
  listNewestFirst(): EvalRunRecord[] {
    return this.list().reverse();
  }

  get(runId: string): EvalRunRecord | undefined {
    return this.list().find((record) => record.runId === runId);
  }

  byModel(modelId: string): EvalRunRecord[] {
    return this.list().filter((record) => record.model === modelId || `${record.provider}/${record.model}` === modelId);
  }

  /** All records for a suite, oldest first. */
  bySuite(suiteId: string): EvalRunRecord[] {
    return this.list().filter((record) => record.suiteId === suiteId);
  }

  /** Samples across every stored run, for performance-profile aggregation. */
  samples(): PerformanceSample[] {
    const samples: PerformanceSample[] = [];
    for (const record of this.list()) {
      for (const entry of record.cases) {
        samples.push({
          modelId: `${record.provider}/${record.model}`,
          providerId: record.provider,
          dimension: entry.type === "TOOL" ? "toolUse" : dimensionForType(entry.type),
          success: entry.pass,
          durationMs: entry.durationMs,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          costUsd: entry.costUsd,
          toolCalls: entry.toolCalls,
          failedToolCalls: entry.failedToolCalls,
          failureClass: entry.failureClass,
        });
      }
    }
    return samples;
  }

  /** Delete the whole history (used by `toolnet eval results --clear`). */
  clear(): boolean {
    try {
      fs.rmSync(this.indexPath, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}

function dimensionForType(type: string): PerformanceSample["dimension"] {
  switch (type) {
    case "CODE":
      return "coding";
    case "REASONING":
      return "reasoning";
    case "STRUCTURED_OUTPUT":
      return "structuredOutput";
    default:
      return undefined;
  }
}
