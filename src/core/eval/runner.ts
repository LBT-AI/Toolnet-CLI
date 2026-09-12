/**
 * Phase 80 §9/§12/§13/§14 — EvalRunner.
 *
 * Drives every case through the PRODUCTION path:
 *
 *   EvalRunner → AgentHarness → ModelRouter → ProviderRegistry → ModelAdapter
 *              → provider
 *
 * It never calls `provider.chat` itself and never builds a second agent loop.
 * Observations come from three real sources, not from model narration:
 *
 *   1. harness events       → tool calls (selection, failure, duplicates)
 *   2. the `model.after` hook → normalized usage tokens
 *   3. the filesystem / real post-command exit codes → side effects
 *
 * Every case runs in a throwaway workspace; fixtures are copied in first so a
 * failed case can never leave the repo dirty.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentHarness } from "../../lib/harness/agentHarness";
import type { HarnessConfig } from "../../lib/harness/types";
import { hookRegistry } from "../hooks";
import type { HookInvocation } from "../hooks/types";
import { modelRouter } from "../models/router";
import { EVAL_RUN_SCHEMA_VERSION } from "./schema";
import { graderFor, stableStringify } from "./graders";
import { EvalStore } from "./store";
import type {
  EvalCase,
  EvalCaseResult,
  EvalFailureClass,
  EvalObservation,
  EvalRunRecord,
  ObservedToolCall,
  EvalSuite,
} from "./types";

/** Minimal harness surface the runner depends on (keeps the seam testable). */
export interface EvalHarness {
  on(listener: (event: { type: string; payload?: any }) => void): () => void;
  execute(options: Record<string, unknown>): Promise<{
    success: boolean;
    output: string;
    tokensUsed: number;
    durationMs: number;
    error?: string;
  }>;
}

export interface EvalRunnerOptions {
  store?: EvalStore;
  /** Directory holding fixture trees. */
  fixturesDir?: string;
  /** Root for per-case workspaces (defaults to the OS temp dir). */
  workspacesRoot?: string;
  /** Test seam — build the harness. Defaults to a real AgentHarness. */
  harnessFactory?: (config: HarnessConfig) => EvalHarness;
  /** External cancellation for a whole run. */
  signal?: AbortSignal;
  onCaseResult?: (result: EvalCaseResult) => void;
  /** Keep per-case workspaces for debugging (default false). */
  keepWorkspaces?: boolean;
  maxTurns?: number;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

const DEFAULT_CASE_TIMEOUT_MS = 60_000;

/** Resolve the fixtures directory in source and bundled layouts. */
export function resolveFixturesDir(): string {
  const candidates = [
    path.join(import.meta.dir ?? "", "fixtures"),
    path.join(process.cwd(), "src", "core", "eval", "fixtures"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return candidates[1];
}

export class EvalRunner {
  private readonly options: EvalRunnerOptions;

  constructor(options: EvalRunnerOptions = {}) {
    this.options = options;
  }

  private get store(): EvalStore {
    return this.options.store ?? new EvalStore();
  }

  /**
   * Run a whole suite against one model reference (resolved through the router).
   * The suite is never aborted by a single case failure.
   */
  async runSuite(suite: EvalSuite, model: string): Promise<EvalRunRecord> {
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = new Date();
    const startedMs = Date.now();
    const identity = this.identify(model);

    const cases: EvalCaseResult[] = [];
    for (const entry of suite.cases) {
      if (this.options.signal?.aborted) break;
      const result = await this.runCase(entry, { model, runId });
      cases.push(result);
      this.options.onCaseResult?.(result);
    }

    const passed = cases.filter((entry) => entry.pass).length;
    const record: EvalRunRecord = {
      schemaVersion: EVAL_RUN_SCHEMA_VERSION,
      runId,
      suiteId: suite.id,
      suiteVersion: suite.version,
      model: identity.model,
      provider: identity.provider,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      passed,
      failed: cases.length - passed,
      metrics: buildMetrics(cases),
      cases,
      ...(suite.cases.length === 0 ? { notes: ["suite contains no cases"] } : {}),
    };

    this.store.append(record);
    return record;
  }

  /** Run one case in an isolated workspace. */
  async runCase(entry: EvalCase, context: { model: string; runId: string }): Promise<EvalCaseResult> {
    const startedMs = Date.now();
    const workspace = this.createWorkspace(entry);
    const usage: UsageTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const owner = `eval:${context.runId}:${entry.id}`;

    // Usage comes from the real `model.after` hook edge (Phase 77.11), which is
    // the same observation a plugin would get. No harness modification needed.
    hookRegistry.register({
      name: "model.after",
      owner,
      failurePolicy: "ignore",
      handler: (invocation: HookInvocation) => {
        const payload = invocation.output as { usage?: Partial<UsageTotals> } | undefined;
        usage.inputTokens += payload?.usage?.inputTokens ?? 0;
        usage.outputTokens += payload?.usage?.outputTokens ?? 0;
        usage.totalTokens += payload?.usage?.totalTokens ?? 0;
      },
    });

    const observed: ObservedToolCall[] = [];
    const filesRead = new Set<string>();
    const filesWritten = new Set<string>();
    let cancelled = false;
    let runtimeError: string | undefined;
    let threw = false;
    let output = "";

    const controller = new AbortController();
    const timeoutMs = entry.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS;
    const timer = setTimeout(() => {
      cancelled = true;
      controller.abort();
    }, entry.cancelAfterMs ?? timeoutMs);
    timer.unref?.();
    this.options.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    try {
      const harness = this.buildHarness(entry, workspace, context, controller.signal);

      harness.on((event) => {
        const payload = event.payload ?? {};
        // Only `tool:start` begins a real execution. `tool:queued` fires for
        // calls that may be de-duplicated and never run, so counting it would
        // double-count every executed call.
        if (event.type === "tool:start") {
          observed.push({
            id: String(payload.id ?? `${observed.length}`),
            name: String(payload.toolName ?? "unknown"),
            arguments: payload.toolArgs,
            ok: false,
          });
          trackFile(entry, filesRead, filesWritten, payload.toolName, payload.toolArgs);
          return;
        }
        if (event.type === "tool:complete") {
          markLast(observed, String(payload.id ?? ""), String(payload.toolName ?? ""), true);
          return;
        }
        if (event.type === "tool:error") {
          markLast(observed, String(payload.id ?? ""), String(payload.toolName ?? ""), false, String(payload.reason ?? ""));
        }
      });

      const result = await harness.execute({
        prompt: entry.prompt,
        mode: "HEADLESS",
        signal: controller.signal,
        maxTurns: entry.maxTurns ?? this.options.maxTurns ?? 8,
        timeoutMs,
        sessionId: `${context.runId}-${entry.id}`,
      });
      output = result.output ?? "";
      if (!result.success && result.error) {
        // A cancellation is a run STATE, not a runtime defect. The harness
        // reports it as `success:false` rather than throwing, and an aborted
        // provider call surfaces as "The operation was aborted" — both are
        // cancellation, not a runtime defect.
        if (/cancel|abort/i.test(result.error) || controller.signal.aborted) cancelled = true;
        else runtimeError = result.error;
      }
    } catch (error) {
      // The controller aborts on cancellation AND on timeout; either way this is
      // a run state, never a model-quality signal.
      if (controller.signal.aborted) {
        cancelled = true;
      } else if (error instanceof Error && (error.name === "AbortError" || /abort|cancel/i.test(error.message))) {
        cancelled = true;
      } else {
        threw = true;
        runtimeError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      clearTimeout(timer);
      hookRegistry.unregisterOwner(owner);
    }

    const postCommand = entry.postCommand ? runPostCommand(entry, workspace) : { exitCodes: [], output: [] };

    const observation: EvalObservation = {
      output,
      toolCalls: observed,
      workspaceRoot: workspace,
      filesRead: [...filesRead],
      filesWritten: [...filesWritten],
      exitCodes: postCommand.exitCodes,
      postCommandOutput: postCommand.output,
      cancelled,
      runtimeError,
      threw,
      durationMs: Date.now() - startedMs,
    };

    const graded = gradeCase(entry, observation);
    const duplicates = countDuplicateToolCalls(observed);

    const caseResult: EvalCaseResult = {
      caseId: entry.id,
      name: entry.name,
      type: entry.type,
      pass: graded.pass,
      score: graded.score,
      detail: graded.detail,
      durationMs: observation.durationMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      toolCalls: observed.length,
      failedToolCalls: observed.filter((call) => !call.ok).length,
      duplicateToolCalls: duplicates,
      retries: duplicates,
      ...(graded.pass ? {} : { failureClass: classifyFailure(entry, observation) }),
      output: output.slice(0, 2000),
    };

    if (!this.options.keepWorkspaces) {
      try {
        fs.rmSync(workspace, { recursive: true, force: true });
      } catch {}
    }

    return caseResult;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private identify(model: string): { model: string; provider: string } {
    try {
      const resolved = modelRouter.resolve({ model, policy: "explicit" });
      return { model: resolved.model.apiModelId, provider: resolved.provider.id };
    } catch {
      // Unresolvable references still run (the harness degrades to the legacy
      // provider path); identity is reported honestly rather than guessed.
      return { model, provider: "unknown" };
    }
  }

  private createWorkspace(entry: EvalCase): string {
    const root = this.options.workspacesRoot ?? os.tmpdir();
    fs.mkdirSync(root, { recursive: true });
    const workspace = fs.mkdtempSync(path.join(root, "toolnet-eval-"));
    if (entry.fixture) {
      const source = path.join(this.options.fixturesDir ?? resolveFixturesDir(), entry.fixture);
      try {
        if (fs.existsSync(source)) fs.cpSync(source, workspace, { recursive: true });
      } catch {
        // A missing/broken fixture must not crash the run — the case will fail
        // on its filesystem grader, which is the honest outcome.
      }
    }
    // Pre-clean assertion targets so an "expect absent" grader is meaningful.
    for (const relative of entry.cleanupPaths ?? []) {
      try {
        fs.rmSync(path.join(workspace, relative), { force: true, recursive: true });
      } catch {}
    }
    return workspace;
  }

  private buildHarness(
    entry: EvalCase,
    workspace: string,
    context: { model: string; runId: string },
    signal: AbortSignal,
  ): EvalHarness {
    void signal;
    const config: HarnessConfig = {
      workspaceRoot: workspace,
      currentCwd: workspace,
      model: context.model,
      sessionId: `${context.runId}-${entry.id}`,
      sandboxMode: "workspace",
      maxTurns: entry.maxTurns ?? this.options.maxTurns ?? 8,
      timeoutMs: entry.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS,
    };
    return this.options.harnessFactory
      ? this.options.harnessFactory(config)
      : (new AgentHarness(config) as unknown as EvalHarness);
  }
}

// ── Observation helpers ─────────────────────────────────────────────────────

function markLast(
  observed: ObservedToolCall[],
  id: string,
  name: string,
  ok: boolean,
  reason?: string,
): void {
  // Match by id when present, else the most recent still-pending call.
  for (let i = observed.length - 1; i >= 0; i--) {
    const candidate = observed[i];
    if (id && candidate.id === id) {
      candidate.ok = ok;
      if (reason) candidate.reason = reason;
      return;
    }
  }
  for (let i = observed.length - 1; i >= 0; i--) {
    if (!observed[i].ok && (name === "" || observed[i].name === name)) {
      observed[i].ok = ok;
      if (reason) observed[i].reason = reason;
      return;
    }
  }
}

const READ_TOOLS = new Set(["read_file", "list_files", "glob", "grep", "search", "view_file"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file", "patch", "create_file", "append_file", "multi_edit"]);

function trackFile(
  entry: EvalCase,
  reads: Set<string>,
  writes: Set<string>,
  toolName: unknown,
  args: unknown,
): void {
  const name = String(toolName ?? "");
  const record = (args ?? {}) as Record<string, unknown>;
  const target = record.path ?? record.file ?? record.filePath ?? record.filename;
  if (typeof target !== "string" || !target) return;
  if (WRITE_TOOLS.has(name)) writes.add(target);
  else if (READ_TOOLS.has(name)) reads.add(target);
  else if (name === "bash" || name === "shell" || name === "execute_command") {
    void entry;
  }
}

export function countDuplicateToolCalls(calls: ObservedToolCall[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const call of calls) {
    const signature = `${call.name}:${stableStringify(call.arguments)}`;
    if (seen.has(signature)) duplicates += 1;
    seen.add(signature);
  }
  return duplicates;
}

function runPostCommand(entry: EvalCase, workspace: string): { exitCodes: number[]; output: string[] } {
  const command = entry.postCommand;
  if (!command) return { exitCodes: [], output: [] };
  try {
    const result = spawnSync(command.command, command.args, {
      cwd: workspace,
      encoding: "utf8",
      timeout: command.timeoutMs ?? 30_000,
      env: { ...process.env, ...(entry.env ?? {}) },
    });
    return {
      exitCodes: [typeof result.status === "number" ? result.status : 1],
      output: [String(result.stdout ?? "").slice(0, 2000), String(result.stderr ?? "").slice(0, 2000)],
    };
  } catch (error) {
    return { exitCodes: [1], output: [error instanceof Error ? error.message : String(error)] };
  }
}

/** A runtime error means the CASE failed, but not because the model was bad. */
function gradeCase(entry: EvalCase, observation: EvalObservation) {
  const specs = [entry.grader, ...(entry.graders ?? [])];
  // A grader that explicitly asserts on run state owns the outcome; otherwise a
  // runtime error is a CORE_RUNTIME failure regardless of text.
  const gradedByRunState = specs.some((spec) => spec.kind === "run-state");
  if (observation.runtimeError && !gradedByRunState) {
    return {
      pass: false,
      score: 0,
      detail: `runtime error before grading: ${observation.runtimeError}`,
    };
  }

  const results = specs.map((spec) => ({ spec, result: graderFor(spec)(observation, spec) }));
  const failed = results.filter((entryResult) => !entryResult.result.pass);
  if (failed.length === 0) {
    const score = results.reduce((sum, entryResult) => sum + entryResult.result.score, 0) / results.length;
    return { pass: true, score: Math.round(score * 1000) / 1000, detail: results.map((r) => r.result.detail).join(" | ") };
  }
  return {
    pass: false,
    score: 0,
    detail: failed.map((r) => `${r.spec.kind}: ${r.result.detail}`).join(" | "),
  };
}

/**
 * Classify WHY a case failed. Deliberately distinguishes runtime/provider
 * problems from model-compliance problems so a provider outage is never
 * reported as a model-quality regression.
 */
export function classifyFailure(entry: EvalCase, observation: EvalObservation): EvalFailureClass {
  const detail = `${observation.runtimeError ?? ""} ${observation.postCommandOutput.join(" ")}`;

  if (observation.cancelled && entry.cancelAfterMs === undefined) return "TIMEOUT";
  if (observation.cancelled) return "CANCELLED";
  if (/abort|cancel/i.test(detail)) return "CANCELLED";
  if (entry.cancelAfterMs !== undefined) return "CANCELLED";
  if (observation.runtimeError && /timeout|timed out/i.test(observation.runtimeError)) return "TIMEOUT";
  if (/permission|denied|not permitted|forbidden/i.test(detail)) return "PERMISSION";
  if (/HTTP\s+4\d\d|unauthor|invalid (request|api)|malformed|bad request/i.test(detail)) return "PROVIDER_PROTOCOL";
  if (/HTTP\s+5\d\d|ECONNREFUSED|ENOTFOUND|fetch failed|socket hang up/i.test(detail)) return "PROVIDER_PROTOCOL";

  // A thrown exception is a genuine runtime crash and outranks the tool check.
  if (observation.threw) return "CORE_RUNTIME";

  // The model produced no tool call where one was required → compliance. This
  // is checked BEFORE the generic runtime fallback: the harness's completion
  // gate reports "no mutation happened" as a run error, but the CAUSE is the
  // model narrating instead of acting, not a runtime defect.
  if (requiresToolCall(entry) && observation.toolCalls.length === 0) return "MODEL_COMPLIANCE";
  if (observation.runtimeError) return "CORE_RUNTIME";

  if (entry.grader.kind === "file-mutation" && observation.filesWritten.length === 0) {
    return "MODEL_COMPLIANCE";
  }
  if (observation.toolCalls.some((call) => !call.ok)) return "TOOL_FAILURE";
  return "MODEL_COMPLIANCE";
}

/** True when the case's graders demand at least one tool execution. */
function requiresToolCall(entry: EvalCase): boolean {
  const specs = [entry.grader, ...(entry.graders ?? [])];
  return specs.some(
    (spec) =>
      spec.kind === "tool-call" ||
      spec.kind === "file-mutation" ||
      spec.kind === "command-exit",
  );
}

export function buildMetrics(cases: EvalCaseResult[]): EvalRunRecord["metrics"] {
  const byType: Record<string, { passed: number; total: number }> = {};
  let duration = 0;
  let input = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  let failedToolCalls = 0;
  let cost = 0;
  let costSeen = false;

  for (const entry of cases) {
    duration += entry.durationMs;
    input += entry.inputTokens;
    outputTokens += entry.outputTokens;
    toolCalls += entry.toolCalls;
    failedToolCalls += entry.failedToolCalls;
    if (typeof entry.costUsd === "number") {
      cost += entry.costUsd;
      costSeen = true;
    }
    const bucket = byType[entry.type] ?? { passed: 0, total: 0 };
    bucket.total += 1;
    if (entry.pass) bucket.passed += 1;
    byType[entry.type] = bucket;
  }

  const count = cases.length || 1;
  const passed = cases.filter((entry) => entry.pass).length;
  return {
    passRate: Math.round((passed / count) * 1000) / 1000,
    meanDurationMs: Math.round(duration / count),
    meanInputTokens: Math.round(input / count),
    meanOutputTokens: Math.round(outputTokens / count),
    totalToolCalls: toolCalls,
    totalFailedToolCalls: failedToolCalls,
    ...(costSeen ? { totalCostUsd: Math.round(cost * 1e6) / 1e6 } : {}),
    byType,
  };
}
