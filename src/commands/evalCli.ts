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
import { BUILTIN_SUITES, EvalRunner, EvalStore, findSuite, harnessVersionOf, profilesFromRecords, resolveHarnessId, type EvalRunRecord } from "../core/eval";
import { MIN_SAMPLES, type ModelPerformanceProfile } from "../core/models/performance";
import { harnessRegistry, currentHarnessSettings } from "../core/harness";

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

  # Phase 81 — cross-harness measurement (same model, different policy)
  toolnet eval harnesses                  List harness profiles and run counts.
  toolnet eval run <suite> --harness <id> Run a suite under one harness profile.
  toolnet eval compare-harness --model <m> <h1> <h2> [...]
                                          Compare profiles for one model.
  toolnet eval matrix <suite> [--models a,b] [--harnesses x,y]
                                          Model x harness grid from stored runs.
                                          Add --run to execute the missing cells.

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
    case "harnesses":
      return listHarnesses(io, json, store);
    case "compare-harness":
    case "compare-harnesses":
      return compareHarnesses(args, positional, io, json, store, deps);
    case "matrix":
      return harnessMatrix(args, positional, io, json, store, deps);
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

  // Phase 81 §14 — an explicit profile is validated before anything runs.
  const harness = resolveHarnessId(flagValue(args, "--harness") ?? currentHarnessSettings().profile);
  if (!harnessRegistry.has(harness)) {
    io.err(`Unknown harness profile '${harness}'. Known: ${harnessRegistry.ids().join(", ")}.`);
    return 1;
  }

  const runner = deps.runner ?? new EvalRunner({ store: deps.store });

  try {
    const record = await runner.runSuite(suite, model, { harness });
    if (json) {
      io.out(JSON.stringify(record, null, 2));
      return record.failed === 0 ? 0 : 1;
    }
    io.out(
      `Run ${record.runId}  suite=${record.suiteId}  model=${record.provider}/${record.model}  harness=${record.harnessId}`,
    );
    io.out("─".repeat(78));
    for (const entry of record.cases) {
      const mark = entry.pass ? "PASS" : "FAIL";
      io.out(`  ${pad(mark, 5)} ${pad(entry.caseId, 24)} ${pad(`${Math.round(entry.durationMs)}ms`, 8)} ${entry.pass ? "" : `[${entry.failureClass}] `}${entry.detail}`);
    }
    io.out("");
    io.out(`Passed ${record.passed}/${record.cases.length}  passRate=${record.metrics.passRate}  mean=${record.metrics.meanDurationMs}ms  turns=${record.metrics.meanTurns ?? 0}  tools=${record.metrics.totalToolCalls} (failed ${record.metrics.totalFailedToolCalls})`);
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

// ── Phase 81 §14/§15 — cross-harness comparison ──────────────────────────────

interface HarnessAggregate {
  harness: string;
  harnessVersion: string;
  runs: number;
  cases: number;
  success: number;
  toolUse: number | null;
  toolUseSamples: number;
  reliability: number | null;
  meanTurns: number | null;
  meanLatencyMs: number | null;
}

/**
 * Aggregate stored runs for one (model, harness) pair.
 *
 * Records with no harness identity are NOT attributed to any profile — they are
 * counted as unattributed and reported, because guessing "default" would make a
 * comparison silently wrong.
 */
function aggregateHarness(
  records: EvalRunRecord[],
  model: string,
  harness: string,
): HarnessAggregate {
  const wantedModel = normalizeModel(model);
  const matching = records.filter((record) => {
    if (resolveHarnessId(record.harnessId) !== harness) return false;
    if (record.harnessId === undefined) return false;
    const qualified = normalizeModel(`${record.provider}/${record.model}`);
    return (
      normalizeModel(record.model) === wantedModel ||
      qualified === wantedModel ||
      `${record.provider}/${record.model}` === model
    );
  });

  const cases = matching.flatMap((record) => record.cases);
  const passed = cases.filter((entry) => entry.pass).length;
  const toolCases = cases.filter((entry) => entry.type === "TOOL" || entry.type === "CODE");
  const reliable = cases.filter(
    (entry) =>
      entry.failureClass !== "CORE_RUNTIME" && entry.failureClass !== "PROVIDER_PROTOCOL",
  ).length;
  const turnsSeen = cases.filter((entry) => typeof entry.turns === "number");

  return {
    harness,
    harnessVersion: harnessVersionOf(harness),
    runs: matching.length,
    cases: cases.length,
    success: cases.length > 0 ? round3(passed / cases.length) : 0,
    toolUse:
      toolCases.length > 0
        ? round3(toolCases.filter((entry) => entry.pass).length / toolCases.length)
        : null,
    toolUseSamples: toolCases.length,
    reliability: cases.length > 0 ? round3(reliable / cases.length) : null,
    meanTurns:
      turnsSeen.length > 0
        ? Math.round(
            (turnsSeen.reduce((sum, entry) => sum + (entry.turns ?? 0), 0) / turnsSeen.length) * 10,
          ) / 10
        : null,
    meanLatencyMs:
      cases.length > 0
        ? Math.round(cases.reduce((sum, entry) => sum + entry.durationMs, 0) / cases.length)
        : null,
  };
}

function listHarnesses(io: EvalCliIO, json: boolean, store: EvalStore): number {
  const records = store.list();
  const active = currentHarnessSettings().profile;
  const unattributed = records.filter((record) => record.harnessId === undefined).length;

  const rows = harnessRegistry.list().map((profile) => ({
    id: profile.id,
    version: profile.version,
    description: profile.description,
    active: profile.id === active,
    runs: records.filter((record) => record.harnessId === profile.id).length,
  }));

  if (json) {
    io.out(JSON.stringify({ active, unattributed, harnesses: rows }, null, 2));
    return 0;
  }

  io.out(`Harness profiles (${rows.length})   active: ${active}`);
  io.out("─".repeat(86));
  io.out(`${pad("", 3)}${pad("PROFILE", 14)}${pad("VERSION", 9)}${pad("RUNS", 7)}DESCRIPTION`);
  for (const row of rows) {
    io.out(
      `${pad(row.active ? "*" : " ", 3)}${pad(row.id, 14)}${pad(`v${row.version}`, 9)}${pad(String(row.runs), 7)}${row.description}`,
    );
  }
  if (unattributed > 0) {
    io.out("");
    io.out(`${unattributed} stored run(s) predate harness attribution and are excluded from comparisons.`);
  }
  return 0;
}

async function compareHarnesses(
  args: string[],
  positional: string[],
  io: EvalCliIO,
  json: boolean,
  store: EvalStore,
  deps: EvalCliDeps,
): Promise<number> {
  const model = flagValue(args, "--model") ?? defaultModel();
  const harnesses = positional.slice(1).map((entry) => resolveHarnessId(entry));

  if (!model) {
    io.err("No model selected. Pass --model <provider/model>.");
    return 1;
  }
  if (harnesses.length < 2) {
    io.err("Usage: toolnet eval compare-harness --model <model> <harnessA> <harnessB> [...]");
    io.err(`Harnesses: ${harnessRegistry.ids().join(", ")}`);
    return 1;
  }
  const unknown = harnesses.filter((id) => !harnessRegistry.has(id));
  if (unknown.length > 0) {
    io.err(`Unknown harness profile(s): ${unknown.join(", ")}. Known: ${harnessRegistry.ids().join(", ")}.`);
    return 1;
  }

  // --run executes each profile on the production path. Without it the command
  // is pure reporting over stored results, so it is never a surprise spend.
  const suiteId = flagValue(args, "--suite");
  if (suiteId || args.includes("--run")) {
    const id = suiteId ?? "coding";
    const suite = findSuite(id);
    if (!suite) {
      io.err(`Unknown suite '${id}'. Known: ${BUILTIN_SUITES.map((entry) => entry.id).join(", ")}.`);
      return 1;
    }
    const runner = deps.runner ?? new EvalRunner({ store });
    for (const id of harnesses) {
      io.out(`Running suite '${suite.id}' for ${model} under harness '${id}'…`);
      await runner.runSuite(suite, model, { harness: id });
    }
  }

  const records = store.list();
  const rows = harnesses.map((id) => aggregateHarness(records, model, id));

  if (json) {
    io.out(JSON.stringify({ model, harnesses: rows }, null, 2));
    return 0;
  }

  io.out(`Harness comparison — model ${model}`);
  io.out("─".repeat(86));
  io.out(
    `${pad("HARNESS", 14)}${pad("SUCCESS", 10)}${pad("TOOL USE", 12)}${pad("RELIABILITY", 13)}${pad("TURNS", 8)}${pad("LATENCY", 10)}SAMPLES`,
  );
  for (const row of rows) {
    io.out(
      `${pad(row.harness, 14)}${pad(formatRate(row.success), 10)}${pad(formatRate(row.toolUse), 12)}` +
        `${pad(formatRate(row.reliability), 13)}${pad(formatTurns(row.meanTurns), 8)}` +
        `${pad(row.meanLatencyMs === null ? "—" : `${row.meanLatencyMs}ms`, 10)}${row.cases}`,
    );
  }
  io.out("");
  io.out(
    `Sample counts per harness: ${rows.map((row) => `${row.harness}=${row.cases}`).join(", ")}. ` +
      `Below ${MIN_SAMPLES} samples a rate reads 'insufficient'; no winner is declared.`,
  );
  return 0;
}

interface MatrixCell {
  model: string;
  harness: string;
  score: number | null;
  samples: number;
}

async function harnessMatrix(
  args: string[],
  positional: string[],
  io: EvalCliIO,
  json: boolean,
  store: EvalStore,
  deps: EvalCliDeps,
): Promise<number> {
  const suiteId = positional[1];
  if (!suiteId) {
    io.err("Usage: toolnet eval matrix <suite> [--models a,b] [--harnesses x,y] [--run]");
    io.err(`Suites: ${BUILTIN_SUITES.map((entry) => entry.id).join(", ")}`);
    return 1;
  }
  const suite = findSuite(suiteId);
  if (!suite) {
    io.err(`Unknown suite '${suiteId}'.`);
    return 1;
  }

  const models = splitList(flagValue(args, "--models"));
  const harnesses = (splitList(flagValue(args, "--harnesses")) ?? harnessRegistry.ids()).map(
    (entry) => resolveHarnessId(entry),
  );
  const unknown = harnesses.filter((id) => !harnessRegistry.has(id));
  if (unknown.length > 0) {
    io.err(`Unknown harness profile(s): ${unknown.join(", ")}.`);
    return 1;
  }

  const records = store.list().filter((record) => record.suiteId === suite.id);
  // Stored models when none were named — the matrix never invents model ids.
  const modelIds =
    models && models.length > 0
      ? models
      : [...new Set(records.map((record) => `${record.provider}/${record.model}`))];

  if (modelIds.length === 0) {
    io.err(
      `No stored runs for suite '${suite.id}'. Run one first: toolnet eval run ${suite.id} --model <model> --harness <profile>`,
    );
    return 1;
  }

  // §15 — executing cells is opt-in; the default is a report over stored data.
  if (args.includes("--run")) {
    const runner = deps.runner ?? new EvalRunner({ store });
    for (const model of modelIds) {
      for (const harness of harnesses) {
        const have = aggregateHarness(records, model, harness).cases;
        if (have > 0) continue;
        io.out(`Running suite '${suite.id}' for ${model} under harness '${harness}'…`);
        await runner.runSuite(suite, model, { harness });
      }
    }
    return printMatrix(io, json, suite.id, store.list().filter((record) => record.suiteId === suite.id), modelIds, harnesses);
  }

  return printMatrix(io, json, suite.id, records, modelIds, harnesses);
}

function printMatrix(
  io: EvalCliIO,
  json: boolean,
  suiteId: string,
  records: EvalRunRecord[],
  modelIds: string[],
  harnesses: string[],
): number {
  const cells: MatrixCell[] = [];
  for (const model of modelIds) {
    for (const harness of harnesses) {
      const aggregate = aggregateHarness(records, model, harness);
      cells.push({
        model,
        harness,
        score: aggregate.cases > 0 ? aggregate.success : null,
        samples: aggregate.cases,
      });
    }
  }

  if (json) {
    io.out(JSON.stringify({ suiteId, harnesses, models: modelIds, cells }, null, 2));
    return 0;
  }

  const modelColumn = Math.max(20, ...modelIds.map((model) => model.length + 2));
  io.out(`Model x harness matrix — suite '${suiteId}'`);
  io.out("─".repeat(modelColumn + harnesses.length * 16));
  io.out(`${pad("MODEL", modelColumn)}${harnesses.map((entry) => pad(cellLabel(entry), 16)).join("")}`);
  for (const model of modelIds) {
    const row = harnesses
      .map((harness) => {
        const cell = cells.find((entry) => entry.model === model && entry.harness === harness);
        if (!cell || cell.score === null) return pad("— (0)", 16);
        return pad(`${cell.score.toFixed(2)} (${cell.samples})`, 16);
      })
      .join("");
    io.out(`${pad(model, modelColumn)}${row}`);
  }
  io.out("");
  io.out(
    `Each cell is 'success rate (sample count)'. Fewer than ${MIN_SAMPLES} samples is not a result. ` +
      "Add --run to execute missing cells on the production path.",
  );
  return 0;
}

function cellLabel(harness: string): string {
  return harness.length > 14 ? `${harness.slice(0, 13)}…` : harness;
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatRate(value: number | null): string {
  if (value === null) return "—";
  return value.toFixed(2);
}

function formatTurns(value: number | null): string {
  return value === null ? "—" : String(value);
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
