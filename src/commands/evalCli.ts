/**
 * Phase 80 §18/§19 — `toolnet eval`.
 *
 * Formatting + orchestration only. Every measurement comes from the canonical
 * eval layer, which itself runs through the production AgentHarness path. This
 * module never calls a provider and never constructs a harness directly.
 *
 * Model comparison deliberately refuses to declare a winner on thin data: the
 * sample count is always printed, and a dimension with too few samples reads
 * `insufficient`.
 */

import { getAppConfig } from "../lib/appConfig";
import { modelCatalog, providerRegistry } from "../core/models";
import { BUILTIN_SUITES, EvalRunner, EvalStore, findSuite, profilesFromRecords, type EvalRunRecord } from "../core/eval";
import { MIN_SAMPLES, type ModelPerformanceProfile } from "../core/models/performance";

export interface EvalCliIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIo: EvalCliIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export const EVAL_CLI_USAGE = `ToolNet eval — deterministic model evaluation on the production agent path

USAGE:
  toolnet eval list                       List built-in suites and recent runs.
  toolnet eval run <suite> [--model <m>]  Run a suite through AgentHarness.
                                          Defaults to the configured model.
  toolnet eval compare <a> <b>            Compare two models from stored results.
                                          Add --suite <id> to run both first.
  toolnet eval results [--limit <n>]      Show stored run history.
  toolnet eval show <runId>               Show one run's per-case detail.

NOTES:
  · Graders are deterministic — a model that narrates an edit without calling a
    tool fails. No LLM judge is used in this phase.
  · Code fixtures run in throwaway workspaces; real test commands are executed.
  · Comparisons print the sample count and never call a winner on thin data.`;

export interface EvalCliDeps {
  io?: EvalCliIO;
  store?: EvalStore;
  runner?: EvalRunner;
}

export async function runEvalCli(args: string[], deps: EvalCliDeps = {}): Promise<number> {
  const io = deps.io ?? defaultIo;
  const store = deps.store ?? new EvalStore();
  const json = args.includes("--json");
  const positional = args.filter((arg) => !arg.startsWith("--") && !isFlagValue(args, arg));
  const action = (positional[0] ?? "list").toLowerCase();

  if (args.includes("--help") || args.includes("-h")) {
    io.out(EVAL_CLI_USAGE);
    return 0;
  }

  switch (action) {
    case "list":
      return listSuites(io, json, store);
    case "run":
      return runSuiteCommand(args, positional, io, json, deps);
    case "compare":
      return compareModels(args, positional, io, json, store, deps);
    case "results":
      return listResults(args, io, json, store);
    case "show":
      return showRun(positional[1], io, json, store);
    default:
      io.err(`Unknown eval subcommand: ${action}`);
      io.err(EVAL_CLI_USAGE);
      return 1;
  }
}

// ── list ────────────────────────────────────────────────────────────────────

function listSuites(io: EvalCliIO, json: boolean, store: EvalStore): number {
  const runs = store.listNewestFirst();
  if (json) {
    io.out(JSON.stringify({ suites: BUILTIN_SUITES.map(summarizeSuite), runs: runs.slice(0, 10) }, null, 2));
    return 0;
  }
  io.out(`Suites (${BUILTIN_SUITES.length})`);
  io.out("─".repeat(78));
  for (const suite of BUILTIN_SUITES) {
    io.out(`  ${pad(suite.id, 12)} ${pad(`v${suite.version}`, 8)} ${pad(`${suite.cases.length} cases`, 10)} ${suite.description}`);
  }
  io.out("");
  if (runs.length === 0) {
    io.out("No eval runs recorded yet. Try: toolnet eval run text");
    return 0;
  }
  io.out(`Recent runs (${runs.length})`);
  io.out("─".repeat(78));
  for (const run of runs.slice(0, 10)) {
    io.out(`  ${pad(run.runId, 22)} ${pad(run.suiteId, 12)} ${pad(`${run.provider}/${run.model}`, 34)} ${run.passed}/${run.cases.length} passed`);
  }
  return 0;
}

function summarizeSuite(suite: (typeof BUILTIN_SUITES)[number]) {
  return { id: suite.id, version: suite.version, name: suite.name, cases: suite.cases.length };
}

// ── run ─────────────────────────────────────────────────────────────────────

async function runSuiteCommand(
  args: string[],
  positional: string[],
  io: EvalCliIO,
  json: boolean,
  deps: EvalCliDeps,
): Promise<number> {
  const suiteId = positional[1];
  if (!suiteId) {
    io.err("Usage: toolnet eval run <suite> [--model <provider/model>]");
    io.err(`Suites: ${BUILTIN_SUITES.map((suite) => suite.id).join(", ")}`);
    return 1;
  }

  const suite = findSuite(suiteId);
  if (!suite) {
    io.err(`Unknown suite '${suiteId}'. Known: ${BUILTIN_SUITES.map((entry) => entry.id).join(", ")}.`);
    return 1;
  }

  const model = flagValue(args, "--model") ?? defaultModel();
  if (!model) {
    io.err("No model selected. Pass --model <provider/model> or set one with `toolnet model set`.");
    return 1;
  }

  const runner = deps.runner ?? new EvalRunner({ store: deps.store });

  try {
    const record = await runner.runSuite(suite, model);
    if (json) {
      io.out(JSON.stringify(record, null, 2));
      return record.failed === 0 ? 0 : 1;
    }
    io.out(`Run ${record.runId}  suite=${record.suiteId}  model=${record.provider}/${record.model}`);
    io.out("─".repeat(78));
    for (const entry of record.cases) {
      const mark = entry.pass ? "PASS" : "FAIL";
      io.out(`  ${pad(mark, 5)} ${pad(entry.caseId, 24)} ${pad(`${Math.round(entry.durationMs)}ms`, 8)} ${entry.pass ? "" : `[${entry.failureClass}] `}${entry.detail}`);
    }
    io.out("");
    io.out(`Passed ${record.passed}/${record.cases.length}  passRate=${record.metrics.passRate}  mean=${record.metrics.meanDurationMs}ms  tools=${record.metrics.totalToolCalls} (failed ${record.metrics.totalFailedToolCalls})`);
    return record.failed === 0 ? 0 : 1;
  } catch (error) {
    io.err(`Eval run failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// ── compare ─────────────────────────────────────────────────────────────────

async function compareModels(
  args: string[],
  positional: string[],
  io: EvalCliIO,
  json: boolean,
  store: EvalStore,
  deps: EvalCliDeps,
): Promise<number> {
  const modelA = positional[1];
  const modelB = positional[2];
  if (!modelA || !modelB) {
    io.err("Usage: toolnet eval compare <modelA> <modelB> [--suite <id>]");
    return 1;
  }

  const suiteId = flagValue(args, "--suite");
  if (suiteId) {
    const suite = findSuite(suiteId);
    if (!suite) {
      io.err(`Unknown suite '${suiteId}'.`);
      return 1;
    }
    const runner = deps.runner ?? new EvalRunner({ store });
    for (const model of [modelA, modelB]) {
      io.out(`Running suite '${suite.id}' for ${model}…`);
      await runner.runSuite(suite, model);
    }
  }

  const records = store.list();
  const profileA = profileFor(records, modelA);
  const profileB = profileFor(records, modelB);

  if (!profileA && !profileB) {
    io.err(
      `No stored results for '${modelA}' or '${modelB}'. Run a suite first or pass --suite <id>.`,
    );
    return 1;
  }

  const rows = comparisonRows(profileA, profileB);

  if (json) {
    io.out(JSON.stringify({ a: modelA, b: modelB, profileA: profileA ?? null, profileB: profileB ?? null, rows }, null, 2));
    return 0;
  }

  io.out(`Comparison: ${modelA}  vs  ${modelB}`);
  io.out("─".repeat(70));
  io.out(`${pad("Metric", 18)}${pad("A", 24)}${"B"}`);
  for (const row of rows) {
    io.out(`${pad(row.metric, 18)}${pad(row.a, 24)}${row.b}`);
  }
  io.out("");
  io.out(
    `Sample counts — A=${profileA?.samples ?? 0}, B=${profileB?.samples ?? 0}. ` +
      `Fewer than ${MIN_SAMPLES} samples reads 'insufficient'; no winner is declared.`,
  );
  return 0;
}

interface ComparisonRow {
  metric: string;
  a: string;
  b: string;
}

export function comparisonRows(
  a: ModelPerformanceProfile | undefined,
  b: ModelPerformanceProfile | undefined,
): ComparisonRow[] {
  const metric = (label: string, key: keyof ModelPerformanceProfile["scores"]): ComparisonRow => ({
    metric: label,
    a: formatScore(a, key),
    b: formatScore(b, key),
  });

  return [
    metric("Coding", "coding"),
    metric("Tool use", "toolUse"),
    metric("Reasoning", "reasoning"),
    metric("Structured", "structuredOutput"),
    metric("Reliability", "reliability"),
    metric("Latency score", "latency"),
    metric("Cost efficiency", "costEfficiency"),
    { metric: "Samples", a: String(a?.samples ?? 0), b: String(b?.samples ?? 0) },
  ];
}

function formatScore(
  profile: ModelPerformanceProfile | undefined,
  key: keyof ModelPerformanceProfile["scores"],
): string {
  const value = profile?.scores[key];
  if (typeof value === "number") return value.toFixed(3);
  return "insufficient";
}

function profileFor(records: EvalRunRecord[], model: string): ModelPerformanceProfile | undefined {
  const wanted = normalizeModel(model);
  const matching = records.filter((record) => {
    const qualified = normalizeModel(`${record.provider}/${record.model}`);
    return normalizeModel(record.model) === wanted || qualified === wanted || `${record.provider}/${record.model}` === model;
  });
  if (matching.length === 0) return undefined;
  const profiles = profilesFromRecords(matching);
  return profiles.find((entry) => normalizeModel(entry.modelId) === wanted) ?? profiles[0];
}

function normalizeModel(model: string): string {
  return model.trim().toLowerCase();
}

// ── results / show ──────────────────────────────────────────────────────────

function listResults(args: string[], io: EvalCliIO, json: boolean, store: EvalStore): number {
  const limit = Number(flagValue(args, "--limit") ?? "20");
  const records = store.listNewestFirst().slice(0, Number.isFinite(limit) && limit > 0 ? limit : 20);

  if (json) {
    io.out(JSON.stringify(records, null, 2));
    return 0;
  }
  if (records.length === 0) {
    io.out("No eval results stored yet.");
    return 0;
  }
  io.out(`Eval results (${records.length})`);
  io.out("─".repeat(96));
  io.out(`${pad("RUN ID", 22)}${pad("SUITE", 12)}${pad("MODEL", 34)}${pad("PASSED", 8)}${pad("RATE", 8)}DURATION`);
  for (const run of records) {
    io.out(
      `${pad(run.runId, 22)}${pad(run.suiteId, 12)}${pad(`${run.provider}/${run.model}`, 34)}` +
        `${pad(`${run.passed}/${run.cases.length}`, 8)}${pad(String(run.metrics.passRate), 8)}${run.durationMs}ms`,
    );
  }
  return 0;
}

function showRun(runId: string | undefined, io: EvalCliIO, json: boolean, store: EvalStore): number {
  if (!runId) {
    io.err("Usage: toolnet eval show <runId>");
    return 1;
  }
  const record = store.get(runId);
  if (!record) {
    io.err(`No stored run with id '${runId}'.`);
    return 1;
  }
  if (json) {
    io.out(JSON.stringify(record, null, 2));
    return 0;
  }
  io.out(`Run ${record.runId}  suite=${record.suiteId} v${record.suiteVersion}`);
  io.out(`Model ${record.provider}/${record.model}  started=${record.startedAt}  duration=${record.durationMs}ms`);
  io.out(`Passed ${record.passed}/${record.cases.length}  passRate=${record.metrics.passRate}`);
  io.out("─".repeat(96));
  for (const entry of record.cases) {
    io.out(
      `  ${pad(entry.pass ? "PASS" : "FAIL", 5)}${pad(entry.caseId, 24)}${pad(entry.type, 20)}` +
        `tools=${entry.toolCalls}(failed ${entry.failedToolCalls}) in=${entry.inputTokens} out=${entry.outputTokens} ${Math.round(entry.durationMs)}ms`,
    );
    if (!entry.pass) io.out(`        [${entry.failureClass}] ${entry.detail}`);
  }
  return 0;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function defaultModel(): string | undefined {
  try {
    const configured = getAppConfig().defaultModel?.trim();
    if (configured) return configured;
  } catch {}
  // Fall back to the first registered model so a fresh workspace still runs.
  try {
    const provider = providerRegistry.enabled()[0];
    if (!provider) return undefined;
    const model = modelCatalog.listByProvider(provider.id)[0];
    return model ? model.id : undefined;
  } catch {
    return undefined;
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function isFlagValue(args: string[], arg: string): boolean {
  const index = args.indexOf(arg);
  return index > 0 && args[index - 1].startsWith("--");
}

function pad(value: string, width: number): string {
  const text = value.length > width - 1 ? `${value.slice(0, width - 2)}…` : value;
  return text.padEnd(width, " ");
}
