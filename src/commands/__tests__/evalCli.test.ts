import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runEvalCli, comparisonRows } from "../evalCli";
import { EvalRunner } from "../../core/eval/runner";
import { EvalStore } from "../../core/eval/store";
import { EVAL_RUN_SCHEMA_VERSION } from "../../core/eval/schema";
import type { EvalRunRecord } from "../../core/eval/types";

let dir: string;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
  };
}

function record(overrides: Partial<EvalRunRecord> = {}): EvalRunRecord {
  return {
    schemaVersion: EVAL_RUN_SCHEMA_VERSION,
    runId: overrides.runId ?? "run-1",
    suiteId: "coding",
    suiteVersion: "1.0.0",
    model: "model-a",
    provider: "openrouter",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 100,
    passed: 1,
    failed: 1,
    metrics: {
      passRate: 0.5,
      meanDurationMs: 50,
      meanInputTokens: 10,
      meanOutputTokens: 5,
      totalToolCalls: 2,
      totalFailedToolCalls: 1,
      byType: { CODE: { passed: 1, total: 2 } },
    },
    cases: [
      {
        caseId: "code-fix-bug",
        name: "Fix",
        type: "CODE",
        pass: true,
        score: 1,
        detail: "verified on disk",
        durationMs: 40,
        inputTokens: 10,
        outputTokens: 5,
        toolCalls: 1,
        failedToolCalls: 0,
        duplicateToolCalls: 0,
        retries: 0,
      },
      {
        caseId: "code-run-test",
        name: "Run",
        type: "CODE",
        pass: false,
        score: 0,
        detail: "tool-call: narrated",
        durationMs: 60,
        inputTokens: 10,
        outputTokens: 5,
        toolCalls: 1,
        failedToolCalls: 1,
        duplicateToolCalls: 0,
        retries: 0,
        failureClass: "MODEL_COMPLIANCE",
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "phase80-evalcli-"));
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("Phase 80 — `toolnet eval`", () => {
  it("lists suites without needing stored results", async () => {
    const { io, stdout } = capture();
    const code = await runEvalCli(["list"], { io, store: new EvalStore({ dir }) });

    expect(code).toBe(0);
    expect(stdout()).toContain("coding");
    expect(stdout()).toContain("tool");
    expect(stdout()).toContain("structured");
  });

  it("reports an unknown suite with a non-zero exit code", async () => {
    const { io, stderr } = capture();
    const code = await runEvalCli(["run", "nope"], { io, store: new EvalStore({ dir }) });
    expect(code).toBe(1);
    expect(stderr()).toContain("Unknown suite");
  });

  it("forwards the requested model reference to the runner", async () => {
    const store = new EvalStore({ dir });
    const seen: string[] = [];
    const stub = {
      runSuite: async (_suite: unknown, model: string) => {
        seen.push(model);
        return record({ failed: 0, passed: 1, cases: [record().cases[0]] });
      },
    } as unknown as EvalRunner;

    const { io } = capture();
    const code = await runEvalCli(["run", "text", "--model", "openrouter/model-a"], { io, store, runner: stub });
    expect(code).toBe(0);
    expect(seen).toEqual(["openrouter/model-a"]);
  });

  it("runs a suite through the injected runner and reports per-case results", async () => {
    const store = new EvalStore({ dir });
    const stub = {
      runSuite: async () => record(),
    } as unknown as EvalRunner;

    const { io, stdout } = capture();
    const code = await runEvalCli(["run", "coding", "--model", "openrouter/model-a"], { io, store, runner: stub });

    expect(code).toBe(1); // one case failed
    expect(stdout()).toContain("PASS");
    expect(stdout()).toContain("FAIL");
    expect(stdout()).toContain("MODEL_COMPLIANCE");
    expect(stdout()).toContain("Passed 1/2");
  });

  it("returns zero when every case passes", async () => {
    const store = new EvalStore({ dir });
    const passing = record({ failed: 0, passed: 1, cases: [record().cases[0]] });
    const stub = { runSuite: async () => passing } as unknown as EvalRunner;

    const { io } = capture();
    expect(await runEvalCli(["run", "text", "--model", "m"], { io, store, runner: stub })).toBe(0);
  });

  it("shows stored run history and one run's detail", async () => {
    const store = new EvalStore({ dir });
    store.append(record());

    const listed = capture();
    expect(await runEvalCli(["results"], { io: listed.io, store })).toBe(0);
    expect(listed.stdout()).toContain("run-1");

    const shown = capture();
    expect(await runEvalCli(["show", "run-1"], { io: shown.io, store })).toBe(0);
    expect(shown.stdout()).toContain("code-fix-bug");

    const missing = capture();
    expect(await runEvalCli(["show", "ghost"], { io: missing.io, store })).toBe(1);
  });

  it("compares two models from stored results and prints the sample counts", async () => {
    const store = new EvalStore({ dir });
    store.append(record({ runId: "run-a", model: "model-a", provider: "openrouter" }));
    store.append(record({ runId: "run-b", model: "model-b", provider: "openrouter" }));

    const { io, stdout } = capture();
    const code = await runEvalCli(["compare", "openrouter/model-a", "openrouter/model-b"], { io, store });

    expect(code).toBe(0);
    expect(stdout()).toContain("Comparison");
    expect(stdout()).toContain("Samples");
    expect(stdout()).toContain("insufficient");
    expect(stdout()).toContain("no winner is declared");
  });

  it("refuses to compare when neither model has stored results", async () => {
    const { io, stderr } = capture();
    const code = await runEvalCli(["compare", "a", "b"], { io, store: new EvalStore({ dir }) });
    expect(code).toBe(1);
    expect(stderr()).toContain("No stored results");
  });

  it("never declares a winner on thin data", () => {
    const rows = comparisonRows(
      { modelId: "openrouter/a", providerId: "openrouter", samples: 1, scores: {}, insufficient: ["coding"], updatedAt: 0 },
      undefined,
    );
    const coding = rows.find((row) => row.metric === "Coding");
    expect(coding?.a).toBe("insufficient");
    expect(coding?.b).toBe("insufficient");
  });
});
