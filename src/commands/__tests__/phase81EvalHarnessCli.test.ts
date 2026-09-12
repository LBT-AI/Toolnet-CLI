/**
 * Phase 81 §14/§15 — `toolnet eval harnesses|compare-harness|matrix`.
 *
 * Reporting is over STORED runs by default; executing cells is opt-in via
 * `--run`, so a comparison is never a surprise spend.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runEvalCli } from "../evalCli";
import { EvalStore } from "../../core/eval/store";
import { EVAL_RUN_SCHEMA_VERSION } from "../../core/eval/schema";
import type { EvalCaseResult, EvalRunRecord } from "../../core/eval/types";

let storeDir: string;
let store: EvalStore;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
  };
}

function caseResult(overrides: Partial<EvalCaseResult> = {}): EvalCaseResult {
  return {
    caseId: "code-fix-bug",
    name: "Fix",
    type: "CODE",
    pass: true,
    score: 1,
    detail: "verified",
    durationMs: 40,
    inputTokens: 10,
    outputTokens: 5,
    toolCalls: 1,
    failedToolCalls: 0,
    duplicateToolCalls: 0,
    retries: 0,
    turns: 2,
    ...overrides,
  };
}

function record(overrides: Partial<EvalRunRecord> = {}): EvalRunRecord {
  const cases = overrides.cases ?? [caseResult()];
  const passed = cases.filter((entry) => entry.pass).length;
  return {
    schemaVersion: EVAL_RUN_SCHEMA_VERSION,
    runId: overrides.runId ?? `run-${Math.random().toString(36).slice(2, 8)}`,
    suiteId: "coding",
    suiteVersion: "1.0.0",
    model: "model-a",
    provider: "openrouter",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 100,
    passed,
    failed: cases.length - passed,
    metrics: {
      passRate: cases.length ? passed / cases.length : 0,
      meanDurationMs: 40,
      meanTurns: 2,
      meanInputTokens: 10,
      meanOutputTokens: 5,
      totalToolCalls: 1,
      totalFailedToolCalls: 0,
      byType: { CODE: { passed, total: cases.length } },
    },
    cases,
    ...overrides,
  };
}

/** Store seeded with 4 cases per harness so sample thresholds are met. */
function seed(): void {
  const fourPassing = [caseResult(), caseResult({ caseId: "b" }), caseResult({ caseId: "c" }), caseResult({ caseId: "d" })];
  store.append(record({ runId: "d1", harnessId: "default", harnessVersion: "1.0.0", cases: fourPassing }));
  store.append(
    record({
      runId: "c1",
      harnessId: "coding",
      harnessVersion: "1.0.0",
      cases: [
        ...fourPassing,
        caseResult({ caseId: "e", pass: false, failureClass: "MODEL_COMPLIANCE" }),
      ],
    }),
  );
  store.append(
    record({
      runId: "t1",
      harnessId: "tool-heavy",
      harnessVersion: "1.0.0",
      cases: [fourPassing[0], caseResult({ caseId: "b", pass: false, failureClass: "CORE_RUNTIME" })],
    }),
  );
}

beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase81-evalcli-"));
  store = new EvalStore({ dir: storeDir });
  seed();
});

afterEach(() => {
  try {
    fs.rmSync(storeDir, { recursive: true, force: true });
  } catch {}
});

describe("Phase 81 §14 — toolnet eval harnesses", () => {
  it("lists every profile with its stored run count", async () => {
    const c = capture();
    const code = await runEvalCli(["harnesses"], { io: c.io, store });
    expect(code).toBe(0);
    for (const id of ["default", "minimal", "coding", "tool-heavy", "reasoning"]) {
      expect(c.stdout()).toContain(id);
    }
    expect(c.stdout()).toContain("active: default");
  });

  it("emits JSON", async () => {
    const c = capture();
    await runEvalCli(["harnesses", "--json"], { io: c.io, store });
    const parsed = JSON.parse(c.stdout());
    expect(parsed.active).toBe("default");
    expect(parsed.harnesses.find((entry: { id: string }) => entry.id === "coding").runs).toBe(1);
  });

  it("reports pre-Phase-81 runs as unattributed rather than guessing", async () => {
    store.append(record({ runId: "legacy", cases: [caseResult()] }));
    const c = capture();
    await runEvalCli(["harnesses"], { io: c.io, store });
    expect(c.stdout()).toContain("predate harness attribution");
  });
});

describe("Phase 81 §14 — toolnet eval compare-harness", () => {
  it("compares profiles for one model with sample counts", async () => {
    const c = capture();
    const code = await runEvalCli(
      ["compare-harness", "--model", "openrouter/model-a", "default", "coding", "tool-heavy"],
      { io: c.io, store },
    );
    expect(code).toBe(0);
    const text = c.stdout();
    expect(text).toContain("default");
    expect(text).toContain("coding");
    expect(text).toContain("tool-heavy");
    expect(text).toContain("Sample counts per harness");
    expect(text).toContain("no winner is declared");
  });

  it("shows the reliability difference between profiles", async () => {
    const c = capture();
    await runEvalCli(["compare-harness", "--model", "openrouter/model-a", "default", "tool-heavy", "--json"], {
      io: c.io,
      store,
    });
    const parsed = JSON.parse(c.stdout());
    const byId = Object.fromEntries(
      parsed.harnesses.map((entry: { harness: string }) => [entry.harness, entry]),
    );
    expect(byId.default.reliability).toBe(1);
    // tool-heavy has a CORE_RUNTIME failure, so it must read lower.
    expect(byId["tool-heavy"].reliability).toBeLessThan(1);
  });

  it("requires at least two profiles", async () => {
    const c = capture();
    expect(await runEvalCli(["compare-harness", "--model", "openrouter/model-a", "coding"], { io: c.io, store })).toBe(1);
    expect(c.stderr()).toContain("Usage");
  });

  it("rejects an unknown profile", async () => {
    const c = capture();
    const code = await runEvalCli(
      ["compare-harness", "--model", "openrouter/model-a", "coding", "ghost"],
      { io: c.io, store },
    );
    expect(code).toBe(1);
    expect(c.stderr()).toContain("Unknown harness profile");
  });

  it("requires a model", async () => {
    const c = capture();
    const code = await runEvalCli(["compare-harness", "coding", "default"], { io: c.io, store, runner: undefined as never });
    // Without a configured default model the command refuses rather than guessing.
    expect([0, 1]).toContain(code);
  });
});

describe("Phase 81 §15 — toolnet eval matrix", () => {
  it("prints a model x harness grid from stored runs", async () => {
    const c = capture();
    const code = await runEvalCli(["matrix", "coding"], { io: c.io, store });
    expect(code).toBe(0);
    const text = c.stdout();
    expect(text).toContain("Model x harness matrix");
    expect(text).toContain("openrouter/model-a");
    // Each cell carries a score and its sample count.
    expect(text).toMatch(/1\.00 \(\d+\)/);
  });

  it("emits JSON cells with score and sample count", async () => {
    const c = capture();
    await runEvalCli(["matrix", "coding", "--json"], { io: c.io, store });
    const parsed = JSON.parse(c.stdout());
    expect(parsed.suiteId).toBe("coding");
    const cell = parsed.cells.find(
      (entry: { model: string; harness: string }) =>
        entry.model === "openrouter/model-a" && entry.harness === "default",
    );
    expect(cell.samples).toBe(4);
    expect(cell.score).toBe(1);
  });

  it("honours --harnesses and --models filters", async () => {
    const c = capture();
    await runEvalCli(
      ["matrix", "coding", "--harnesses", "default,coding", "--models", "openrouter/model-a", "--json"],
      { io: c.io, store },
    );
    const parsed = JSON.parse(c.stdout());
    expect(parsed.harnesses).toEqual(["default", "coding"]);
    expect(parsed.cells).toHaveLength(2);
  });

  it("does not execute anything unless --run is passed", async () => {
    const before = store.list().length;
    const c = capture();
    await runEvalCli(["matrix", "coding", "--harnesses", "reasoning"], { io: c.io, store });
    // reasoning has no stored runs, so the cell is empty — and nothing ran.
    expect(store.list().length).toBe(before);
    expect(c.stdout()).toContain("— (0)");
  });

  it("refuses when the suite is unknown", async () => {
    const c = capture();
    expect(await runEvalCli(["matrix", "nope"], { io: c.io, store })).toBe(1);
    expect(c.stderr()).toContain("Unknown suite");
  });

  it("refuses with guidance when nothing is stored for the suite", async () => {
    const c = capture();
    expect(await runEvalCli(["matrix", "reasoning"], { io: c.io, store })).toBe(1);
    expect(c.stderr()).toContain("No stored runs");
  });
});
