/**
 * Phase 76B.3–76B.10 — Teamwork Engine
 *
 * A dependency scheduler, nothing more. It owns no provider call, no tool
 * executor and no agent loop: each node is handed to the shared
 * BackgroundJobService, whose work function is a normal scoped subagent run on
 * the shared Agent Engine.
 *
 *   TeamNode → BackgroundJob → SubagentManager → Agent Engine → result
 *
 * Guarantees:
 *   - independent nodes run in parallel, bounded by the shared job scheduler
 *   - dependent nodes receive ONLY declared dependency outputs
 *   - failures propagate as `skipped` unless a condition opts in
 *   - retries are bounded and never blind (permission denial is not retried)
 *   - timeouts abort the child AND its process tree
 *   - cancelling the plan cancels every live node
 */

import type { SandboxMode } from "../../lib/security/types";
import type { ToolPermissionScope } from "../agent/agents/types";
import {
  backgroundJobs as defaultJobs,
  type BackgroundJobService,
  type BackgroundJobSnapshot,
  type BackgroundJobStatus,
} from "../background";
import { agentRegistry, type AgentRegistry } from "../agent/agents/registry";
import { subagentManager as defaultManager, type SubagentManager } from "../agent/agents/manager";
import { validateTeamworkPlan } from "./validation";
import { hookRegistry } from "../hooks";
import {
  MAX_DEPENDENCY_OUTPUT_CHARS,
  type TeamCondition,
  type TeamNode,
  type TeamNodeResult,
  type TeamNodeStatus,
  type TeamworkPlan,
  type TeamworkResult,
  type TeamworkStatus,
} from "./types";

export interface TeamworkEngineDeps {
  jobs?: BackgroundJobService;
  manager?: SubagentManager;
  registry?: AgentRegistry;
}

export interface TeamworkRunOptions {
  plan: TeamworkPlan;
  parentSessionId: string;
  parentPermission: ToolPermissionScope;
  /** Depth of the sponsoring turn: a primary agent is 0. */
  parentDepth: number;
  maxDepth?: number;

  cwd?: string;
  workspaceRoot?: string;
  sandboxMode?: SandboxMode;
  signal?: AbortSignal;

  requestApproval?: (input: { name: string; args: unknown; reason?: string }) => Promise<boolean>;

  /** Observability hook. Never used for control flow. */
  onNodeEvent?: (event: {
    nodeId: string;
    agent: string;
    status: TeamNodeStatus | "running" | "queued";
    attempt: number;
    jobId?: string;
    durationMs?: number;
    errorKind?: string;
  }) => void;
}

const DEFAULT_NODE_TIMEOUT_MS = 10 * 60 * 1000;

interface NodeState {
  node: TeamNode;
  attempts: number;
  result?: TeamNodeResult;
  jobId?: string;
  promise?: Promise<void>;
}

export class TeamworkEngine {
  private readonly jobs: BackgroundJobService;
  private readonly manager: SubagentManager;
  private readonly registry: AgentRegistry;

  constructor(deps: TeamworkEngineDeps = {}) {
    this.jobs = deps.jobs ?? defaultJobs;
    this.manager = deps.manager ?? defaultManager;
    this.registry = deps.registry ?? agentRegistry;
  }

  /**
   * Run a plan to completion. Validates first: an invalid plan never executes a
   * single node.
   */
  async run(options: TeamworkRunOptions): Promise<TeamworkResult> {
    const startedAt = Date.now();
    const plan = options.plan;
    const planId = plan?.id || `teamwork_${Date.now().toString(36)}`;

    const issues = validateTeamworkPlan(plan, {
      agents: this.registry.list().map((a) => ({ id: a.id, mode: a.mode })),
    });

    if (issues.length > 0) {
      return {
        id: planId,
        status: "error",
        nodes: {},
        durationMs: Date.now() - startedAt,
        error: `Plan rejected: ${issues.map((i) => i.message).join(" ")}`,
        issues,
      };
    }

    const states = new Map<string, NodeState>();
    for (const node of plan.nodes) {
      states.set(node.id, { node, attempts: 0 });
    }

    const execution = this.schedule(states, planId, options);
    try {
      await execution;
    } catch {
      // Scheduling never throws for expected failures; a defensive catch keeps
      // a plan run from surfacing as an unhandled rejection.
    }

    return this.buildResult(states, planId, startedAt, options.signal?.aborted === true);
  }

  // ── Scheduling ─────────────────────────────────────────────────────────────

  private async schedule(
    states: Map<string, NodeState>,
    planId: string,
    options: TeamworkRunOptions
  ): Promise<void> {
    const onAbort = () => {
      // Cancelling the plan cancels every live node immediately.
      for (const state of states.values()) {
        if (state.jobId && !state.result) this.jobs.cancel(state.jobId, "Teamwork plan cancelled");
      }
    };

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      for (;;) {
        if (options.signal?.aborted) {
          // Let the already-cancelled jobs settle so their results are real
          // rather than guessed, then close out whatever never started.
          const inFlight = [...states.values()].filter((s) => s.promise);
          if (inFlight.length > 0) {
            await Promise.allSettled(inFlight.map((s) => s.promise as Promise<void>));
            continue;
          }
          this.markAbortedRemaining(states);
          return;
        }

        const ready = [...states.values()].filter((s) => !s.result && !s.promise && this.isReady(s, states));

        if (ready.length === 0) {
          const pending = [...states.values()].filter((s) => s.promise);
          if (pending.length === 0) break; // nothing runnable and nothing in flight

          // Wait for the first node to settle, then re-plan.
          await Promise.race(pending.map((s) => s.promise as Promise<void>));
          continue;
        }

        for (const state of ready) {
          state.promise = this.runNode(state, states, planId, options).finally(() => {
            state.promise = undefined;
          });
        }

        // Let the launched work reach "running" before re-evaluating readiness.
        await Promise.resolve();
      }
    } finally {
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
    }

    // Nodes that could never run because a dependency never completed.
    this.markUnreachableSkipped(states);
  }

  /** A node is ready when every dependency is settled and its condition allows it. */
  private isReady(state: NodeState, states: Map<string, NodeState>): boolean {
    const depIds = [...new Set(state.node.dependsOn || [])];
    const deps = depIds.map((id) => states.get(id));

    // An unresolvable dependency means this node can never run — validation
    // rejects such plans, so reaching here means the graph changed underneath us.
    if (deps.some((dep) => !dep)) {
      this.markSkipped(state, `Skipped: unknown dependency ${depIds.join(", ")}`);
      return false;
    }

    if (deps.some((dep) => !dep!.result)) return false;

    const failedDeps = deps.filter((dep) => dep!.result!.status !== "completed");

    if (failedDeps.length === 0) {
      // Everything upstream succeeded. An `on_failure` node has no failure to
      // react to, so it is done.
      if (state.node.condition === "on_failure") {
        this.markSkipped(state, "Skipped: no dependency failed");
        return false;
      }
      return true;
    }

    // Upstream failed: only `always` / `on_failure` nodes still run.
    const condition = state.node.condition ?? "on_success";
    if (condition === "always" || condition === "on_failure") return true;

    this.markSkipped(
      state,
      `Skipped: dependency ${failedDeps.map((d) => d!.node.id).join(", ")} did not succeed`
    );
    return false;
  }

  /** Terminal, non-executing outcome. Never overwrites a real result. */
  private markSkipped(state: NodeState, reason: string): void {
    if (state.result) return;
    state.result = this.skippedResult(state.node, reason);
  }

  /** Execute one node, applying retry policy and a hard timeout. */
  private async runNode(
    state: NodeState,
    states: Map<string, NodeState>,
    planId: string,
    options: TeamworkRunOptions
  ): Promise<void> {
    const node = state.node;
    const maxAttempts = Math.max(1, Math.min(Number(node.retry?.maxAttempts ?? 1) || 1, 5));
    const startedAt = Date.now();
    // Mutable so a `teamwork.node.before` transform carries across retries — a
    // rewritten prompt must not silently revert on the second attempt.
    let prompt = this.composeNodePrompt(node, states);

    let lastResult: TeamNodeResult | undefined;

    while (state.attempts < maxAttempts) {
      state.attempts++;
      const attempt = state.attempts;

      // Phase 77.11 — `teamwork.node.before` fires in the ENGINE, before any
      // child is spawned, so a veto guarantees "no subagent, no tool call, no
      // process". A policy veto cannot be fixed by retrying, so a deny is
      // terminal for this node and dependents see a deterministic failure.
      const beforeReport = await hookRegistry.run(
        "teamwork.node.before",
        {
          teamworkId: planId,
          nodeId: node.id,
          agent: node.agent,
          attempt,
          dependsOn: [...(node.dependsOn ?? [])],
        },
        { prompt, title: node.title, agent: node.agent },
        { signal: options.signal },
      );

      if (beforeReport.deniedBy) {
        lastResult = this.failedResult(node, attempt, startedAt, beforeReport.deniedBy.reason, "denied");
        options.onNodeEvent?.({
          nodeId: node.id,
          agent: node.agent,
          status: "error",
          attempt,
          errorKind: "denied",
        });
        break;
      }

      const transformedPrompt = (beforeReport.output as { prompt?: unknown } | undefined)?.prompt;
      if (typeof transformedPrompt === "string" && transformedPrompt.length > 0) {
        prompt = transformedPrompt;
      }

      options.onNodeEvent?.({ nodeId: node.id, agent: node.agent, status: "running", attempt });
      const job = this.startNodeJob(node, prompt, planId, options);
      state.jobId = job.id;

      options.onNodeEvent?.({
        nodeId: node.id,
        agent: node.agent,
        status: "running",
        attempt,
        jobId: job.id,
      });

      const settled = await this.awaitNode(job.id, node.timeoutMs ?? DEFAULT_NODE_TIMEOUT_MS, options);

      const result = this.toNodeResult(node, settled, attempt, startedAt);
      lastResult = result;

      // `teamwork.node.after` receives the NORMALIZED node result — the same
      // shape the plan aggregates — so a plugin never has to understand child
      // envelopes or background job records.
      await hookRegistry.run(
        "teamwork.node.after",
        {
          teamworkId: planId,
          nodeId: node.id,
          agent: node.agent,
          attempt,
          status: result.status,
          errorKind: result.errorKind,
          durationMs: result.durationMs,
          childSessionId: result.childSessionId,
        },
        { ...result },
        { signal: options.signal },
      );

      if (result.status === "completed") break;
      if (!this.isRetryable(result)) break;
      if (state.attempts >= maxAttempts) break;

      options.onNodeEvent?.({
        nodeId: node.id,
        agent: node.agent,
        status: result.status,
        attempt,
        jobId: job.id,
        errorKind: `${result.errorKind || "error"}:retrying`,
      });
    }

    state.result =
      lastResult ??
      this.failedResult(node, state.attempts, startedAt, "Node did not execute", "runtime");

    options.onNodeEvent?.({
      nodeId: node.id,
      agent: node.agent,
      status: state.result.status,
      attempt: state.attempts,
      ...(state.result.jobId ? { jobId: state.result.jobId } : {}),
      durationMs: state.result.durationMs,
      ...(state.result.errorKind ? { errorKind: state.result.errorKind } : {}),
    });
  }

  /**
   * Start the node as a background job on the shared scheduler. Concurrency is
   * therefore bounded in exactly one place.
   */
  private startNodeJob(
    node: TeamNode,
    prompt: string,
    planId: string,
    options: TeamworkRunOptions
  ): BackgroundJobSnapshot {
    const childSessionId = this.manager.allocateSessionId(options.parentSessionId, node.agent);

    return this.jobs.start({
      type: "teamwork",
      title: node.title || node.id,
      parentSessionId: options.parentSessionId,
      childSessionId,
      metadata: {
        teamworkId: planId,
        nodeId: node.id,
        agent: node.agent,
      },
      run: (signal) =>
        this.manager.run({
          agentId: node.agent,
          description: node.title,
          prompt,
          parentSessionId: options.parentSessionId,
          parentPermission: options.parentPermission,
          parentDepth: options.parentDepth,
          ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
          cwd: options.cwd,
          workspaceRoot: options.workspaceRoot,
          sandboxMode: options.sandboxMode,
          signal,
          requestApproval: options.requestApproval,
          sessionId: childSessionId,
        }),
    });
  }

  /** Wait for a node, converting a timeout into a real abort. */
  private async awaitNode(
    jobId: string,
    timeoutMs: number,
    options: TeamworkRunOptions
  ): Promise<{ job?: BackgroundJobSnapshot; timedOut: boolean }> {
    const waited = await this.jobs.wait(jobId, timeoutMs);

    if (!waited) return { timedOut: false };
    if (!waited.timedOut) return { job: waited.job, timedOut: false };

    // Timeout: kill the child (its tools and process tree) rather than leaving
    // an orphan running behind a finished plan.
    this.jobs.cancel(jobId, `Node timed out after ${timeoutMs}ms`);
    const after = this.jobs.get(jobId);
    return { job: after, timedOut: true };
  }

  private toNodeResult(
    node: TeamNode,
    settled: { job?: BackgroundJobSnapshot; timedOut: boolean },
    attempts: number,
    startedAt: number
  ): TeamNodeResult {
    const durationMs = Date.now() - startedAt;
    const job = settled.job;

    if (!job) {
      return this.failedResult(node, attempts, startedAt, "Node job disappeared", "runtime");
    }

    if (settled.timedOut) {
      return {
        ...this.failedResult(node, attempts, startedAt, `Node timed out`, "timeout"),
        jobId: job.id,
        durationMs,
      };
    }

    if (job.status === "completed") {
      const envelope = job.result as
        | { status?: string; summary?: string; output?: string; agent?: string; error?: string }
        | undefined;

      // A subagent reports failure in its RESULT envelope, not by throwing, so a
      // "completed" job can still carry a failed child. Projecting that as a
      // successful node would be fake success — the node status must come from
      // the child's own verdict.
      if (envelope?.status === "error") {
        const message = envelope.error || envelope.summary || `Node ${node.id} failed`;
        return {
          ...this.failedResult(node, attempts, startedAt, message, "runtime"),
          ...(job.childSessionId ? { childSessionId: job.childSessionId } : {}),
          jobId: job.id,
          durationMs,
        };
      }

      if (envelope?.status === "cancelled") {
        return {
          nodeId: node.id,
          agent: node.agent,
          status: "cancelled",
          summary: envelope.summary || `Node ${node.id} was cancelled`,
          ...(job.childSessionId ? { childSessionId: job.childSessionId } : {}),
          jobId: job.id,
          durationMs,
          attempts,
          errorKind: "cancelled",
        };
      }

      return {
        nodeId: node.id,
        agent: node.agent,
        status: "completed",
        summary: envelope?.summary || `${node.agent} completed`,
        ...(envelope?.output ? { output: envelope.output } : {}),
        ...(job.childSessionId ? { childSessionId: job.childSessionId } : {}),
        jobId: job.id,
        durationMs,
        attempts,
      };
    }

    const status: TeamNodeStatus = job.status === "cancelled" ? "cancelled" : "error";
    const error = job.error || `Node ended with status ${job.status}`;

    return {
      nodeId: node.id,
      agent: node.agent,
      status,
      summary: error,
      ...(job.childSessionId ? { childSessionId: job.childSessionId } : {}),
      jobId: job.id,
      durationMs,
      attempts,
      error,
      errorKind: job.errorKind ?? status,
    };
  }

  /**
   * Retry only what can plausibly succeed on a second attempt. A permission
   * denial or a cancellation is deterministic — retrying it is just noise.
   */
  private isRetryable(result: TeamNodeResult): boolean {
    if (result.status === "cancelled" || result.status === "skipped") return false;
    const kind = result.errorKind;
    return kind !== "permission" && kind !== "cancelled";
  }

  private composeNodePrompt(node: TeamNode, states: Map<string, NodeState>): string {
    const deps = [...new Set(node.dependsOn || [])]
      .map((id) => states.get(id)?.result)
      .filter((r): r is TeamNodeResult => Boolean(r));

    if (deps.length === 0) return node.prompt;

    const blocks = deps.map((dep) => {
      const output = truncate(dep.output ?? dep.summary, MAX_DEPENDENCY_OUTPUT_CHARS);
      return [
        `  <node id="${dep.nodeId}" agent="${dep.agent}" status="${dep.status}">`,
        `    <summary>${dep.summary}</summary>`,
        ...(output ? [`    <output>`, output, `    </output>`] : []),
        `  </node>`,
      ].join("\n");
    });

    return [
      node.prompt,
      "",
      "<dependency_outputs>",
      ...blocks,
      "</dependency_outputs>",
      "",
      "Use the dependency outputs above as established facts. Do not re-run their work.",
    ].join("\n");
  }

  // ── Result assembly ────────────────────────────────────────────────────────

  private markAbortedRemaining(states: Map<string, NodeState>): void {
    for (const state of states.values()) {
      if (state.result) continue;
      state.result = {
        nodeId: state.node.id,
        agent: state.node.agent,
        status: "cancelled",
        summary: "Cancelled: the plan was cancelled",
        durationMs: 0,
        attempts: state.attempts,
        errorKind: "cancelled",
      };
    }
  }

  /** Nodes whose dependencies can no longer settle are skipped, never hung. */
  private markUnreachableSkipped(states: Map<string, NodeState>): void {
    for (const state of states.values()) {
      if (state.result) continue;
      state.result = this.skippedResult(state.node, "Skipped: dependencies did not complete");
    }
  }

  private buildResult(
    states: Map<string, NodeState>,
    planId: string,
    startedAt: number,
    aborted: boolean
  ): TeamworkResult {
    const nodes: Record<string, TeamNodeResult> = {};
    for (const [id, state] of states) {
      nodes[id] =
        state.result ??
        this.failedResult(state.node, state.attempts, startedAt, "Node never executed", "runtime");
    }

    return {
      id: planId,
      status: this.planStatus(states, aborted),
      nodes,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * A failed node only fails the plan when nothing recovers from it. Any node
   * with an `on_failure`/`always` condition declares that its dependencies'
   * failures are handled, so those upstream errors are not fatal.
   */
  private planStatus(states: Map<string, NodeState>, aborted: boolean): TeamworkStatus {
    if (aborted) return "cancelled";

    const handled = this.handledNodeIds(states);
    for (const [id, state] of states) {
      const result = state.result;
      if (!result) return "error";
      if (result.status === "error" && !handled.has(id)) return "error";
      if (result.status === "cancelled") return "cancelled";
    }

    return "completed";
  }

  /** Dependencies (transitively) of every recovery node. */
  private handledNodeIds(states: Map<string, NodeState>): Set<string> {
    const handled = new Set<string>();
    const queue: string[] = [];

    for (const state of states.values()) {
      const condition = state.node.condition ?? "on_success";
      if (condition === "on_failure" || condition === "always") queue.push(state.node.id);
    }

    while (queue.length > 0) {
      const id = queue.shift() as string;
      const state = states.get(id);
      if (!state) continue;
      for (const dependency of state.node.dependsOn || []) {
        if (handled.has(dependency)) continue;
        handled.add(dependency);
        queue.push(dependency);
      }
    }

    return handled;
  }

  private skippedResult(node: TeamNode, reason: string): TeamNodeResult {
    return {
      nodeId: node.id,
      agent: node.agent,
      status: "skipped",
      summary: reason,
      durationMs: 0,
      attempts: 0,
    };
  }

  private failedResult(
    node: TeamNode,
    attempts: number,
    startedAt: number,
    error: string,
    errorKind: string
  ): TeamNodeResult {
    return {
      nodeId: node.id,
      agent: node.agent,
      status: "error",
      summary: error,
      durationMs: Date.now() - startedAt,
      attempts,
      error,
      errorKind,
    };
  }
}

function truncate(value: string, max: number): string {
  const text = value ?? "";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

/** Convenience: statuses that count as "settled" for dependency purposes. */
export function isSettledStatus(status: BackgroundJobStatus): boolean {
  return status === "completed" || status === "error" || status === "cancelled";
}

/** Re-exported for callers that want to describe a condition in a UI. */
export type { TeamCondition };
