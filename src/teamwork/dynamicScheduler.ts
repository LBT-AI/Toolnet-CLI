/**
 * Dynamic Agent Scheduler for ToolNet Teamwork v2
 * Target File: cli/src/teamwork/dynamicScheduler.ts
 *
 * Layer 4 Phase 2 — Scheduler Correctness + Budget Enforcement:
 *  - NO fake success: provider/network/auth failures are typed failures.
 *  - COMPLETED ⇔ outputResult.success === true.
 *  - Dependency gate: child READY only when ALL parents are COMPLETED AND
 *    outputResult.success === true. Failed dependency → child SKIPPED.
 *  - BudgetManager enforced at dispatch gates A–E; exhaustion →
 *    scheduler:budget_exhausted + pending tasks SKIPPED(BUDGET_EXCEEDED).
 *  - Retry policy: only retryable errors (transient network/timeout/429/5xx)
 *    are retried, bounded by maxAttempts, budget-checked before each retry.
 *  - Atomic claimReadyNode: a node transitions PENDING→READY→RUNNING once.
 *  - Terminal scheduler states are final: late worker completions cannot
 *    resurrect the scheduler or dispatch new tasks.
 */

import os from "os";
import { getGraphNodeArray } from "./smartPlanner";
import { executeSubagentTask } from "./subagentRuntime";
import { BudgetManager } from "./budget";
import type { SandboxMode } from "../lib/security/types";
import type {
  TaskGraph,
  TaskNode,
  SchedulerState,
  SchedulerStatus,
  TaskStatus,
  AgentRole,
  ExecutionMode,
  NodeOutputResult,
} from "./types";
import type { WorkerExecutionResult } from "./workerResult";
import { normalizeWorkerResult, workerResultFromError, classifyWorkerError, tokensOf } from "./workerResult";

export interface SchedulerOptions {
  gatewayUrl?: string;
  baseUrl?: string;
  model?: string;
  maxConcurrencyOverride?: number;
  /**
   * Layer 4 Phase 2 CONTRACT (structured):
   *   executorFn is a MODEL ORCHESTRATION hook, not a tool execution path.
   *   - Returns a WorkerExecutionResult (structured) OR a plain string.
   *     Strings are normalized via normalizeWorkerResult: non-empty string =
   *     explicit success; empty string/undefined = FAILURE (never success).
   *   - It is FORBIDDEN to use it as an arbitrary raw tool executor: any tool
   *     execution it needs must route through ToolGateway.execute() (single
   *     SecurityEngine chokepoint). The default worker (runDefaultWorker →
   *     executeSubagentTask → AgentHarness.dispatchTool) already does this.
   *   - Budget is enforced around executorFn like any other worker; a raw
   *     failure can never be interpreted as success by the scheduler.
   */
  executorFn?: (node: TaskNode, prompt: string) => Promise<string> | Promise<WorkerExecutionResult> | string | WorkerExecutionResult;
  /** Parent sandbox mode — child workers can never exceed it (Phase 2). */
  sandboxMode?: SandboxMode;
  /** Workspace root propagated to every worker's security context. */
  workspaceRoot?: string;
  /** Current working directory propagated to every worker. */
  cwd?: string;
  /** Session id propagated into the security context of all workers. */
  sessionId?: string;
  /** Base agent depth for workers (nested-spawn rules key off this). */
  agentDepth?: number;
  /** Hard cap on attempts per task (default 2, matching prior behavior). */
  defaultMaxAttempts?: number;
}

export type SchedulerEventType =
  | "scheduler:start"
  | "scheduler:pause"
  | "scheduler:resume"
  | "scheduler:complete"
  | "scheduler:failed"
  | "scheduler:budget_exhausted"
  | "task:ready"
  | "task:start"
  | "task:progress"
  | "task:complete"
  | "task:failed"
  | "task:skipped"
  | "task:retry"
  | "worker:scale";

export interface SchedulerEvent {
  type: SchedulerEventType;
  sessionId: string;
  timestamp: number;
  taskId?: string;
  node?: TaskNode;
  activeWorkers?: number;
  maxWorkers?: number;
  payload?: Record<string, any>;
}

export type EventCallback = (event: SchedulerEvent) => void;
export type NodeStatusCallback = (nodeId: string, status: TaskStatus, node: TaskNode) => void;

export const activeSchedulers: Set<DynamicScheduler> = new Set();

/** Terminal scheduler states: once set, no new dispatch and no resurrection. */
const TERMINAL_SCHEDULER_STATES: ReadonlySet<string> = new Set([
  "COMPLETED",
  "FAILED",
  "BUDGET_EXCEEDED",
  "CANCELLED",
]);

/** True when a node's status denotes terminal success (case-insensitive). */
function isCompletedStatus(status: TaskStatus | undefined): boolean {
  return status === "COMPLETED" || status === "completed";
}

/**
 * Dependency gate (Phase 2): a dependency is successful ONLY when its node is
 * COMPLETED and its structured outputResult.success === true.
 */
export function isDependencySuccessful(node: TaskNode | undefined): boolean {
  if (!node) return false;
  if (!isCompletedStatus(node.status)) return false;
  const out = node.outputResult as NodeOutputResult | undefined;
  return out?.success === true;
}

/** True when any of the given dependency nodes has terminally failed/skipped. */
export function hasFailedDependency(depNodes: (TaskNode | undefined)[]): boolean {
  return depNodes.some(dep => {
    if (!dep) return true; // missing dependency node = failed graph edge
    if (isCompletedStatus(dep.status)) return false;
    // Any non-completed terminal state counts as failed dependency.
    const terminalFailure = dep.status === "FAILED" || dep.status === "failed" ||
      dep.status === "SKIPPED" || dep.status === "skipped" ||
      dep.status === "BUDGET_EXCEEDED" ||
      (dep.status as string) === "CANCELLED";
    return terminalFailure;
  });
}

export class DynamicScheduler {
  private graph: TaskGraph;
  private options: SchedulerOptions;
  private state: SchedulerState;
  private eventListeners: Set<EventCallback> = new Set();
  private nodeStatusListeners: Set<NodeStatusCallback> = new Set();
  private isProcessingQueue = false;
  private nodesList: TaskNode[];
  private budget: BudgetManager;
  private budgetExhaustedEmitted = false;

  constructor(graph: TaskGraph, options: SchedulerOptions = {}) {
    this.graph = graph;
    this.options = options;
    this.nodesList = getGraphNodeArray(graph);

    // Initialize all node statuses to PENDING if not set
    for (const node of this.nodesList) {
      if (!node.status) {
        node.status = "PENDING";
      }
      if (!node.dependencies) {
        node.dependencies = node.dependsOn || [];
      }
      if (!node.dependsOn) {
        node.dependsOn = node.dependencies || [];
      }
    }

    activeSchedulers.add(this);

    this.budget = new BudgetManager({
      maxTokens: graph.metadata?.estimatedTotalTokens
        ? Math.floor(graph.metadata.estimatedTotalTokens as number)
        : undefined,
      maxDurationMs: undefined,
      maxTasks: undefined,
      maxWorkers: undefined,
      qualityLevel: graph.qualityLevel || "BALANCED",
    });

    this.state = {
      sessionId: graph.sessionId,
      status: "INITIALIZING",
      mode: graph.mode || "STANDARD",
      graph: this.graph,
      activeWorkers: 0,
      maxWorkers: this.calculateMaxWorkers(),
      readyTaskIds: [],
      runningTaskIds: [],
      completedTaskIds: [],
      failedTaskIds: [],
      skippedTaskIds: [],
      totalTokensUsed: 0,
      startTime: 0,
    };
  }

  public onEvent(callback: EventCallback): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  public onNodeStatusChange(callback: NodeStatusCallback): () => void {
    this.nodeStatusListeners.add(callback);
    return () => this.nodeStatusListeners.delete(callback);
  }

  public getState(): Readonly<SchedulerState> {
    return { ...this.state };
  }

  public getBudgetManager(): BudgetManager {
    return this.budget;
  }

  private emitEvent(type: SchedulerEventType, taskId?: string, payload?: Record<string, any>): void {
    const node = taskId ? this.nodesList.find(n => n.id === taskId) : undefined;
    const event: SchedulerEvent = {
      type,
      sessionId: this.state.sessionId,
      timestamp: Date.now(),
      taskId,
      node,
      activeWorkers: this.state.activeWorkers,
      maxWorkers: this.state.maxWorkers,
      payload,
    };

    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("Scheduler event listener error:", err);
      }
    }
  }

  private updateNodeStatus(node: TaskNode, status: TaskStatus): void {
    node.status = status;
    for (const listener of this.nodeStatusListeners) {
      try {
        listener(node.id, status, node);
      } catch (err) {
        console.error("Node status listener error:", err);
      }
    }
  }

  public calculateMaxWorkers(): number {
    const readyCount = this.getReadyNodes().length;
    const cScore = this.nodesList[0]?.complexityScore ?? (this.graph.metadata?.intentScore ?? 50);

    let complexityLimit = 2; // Default to Small
    // Simulate mapping cScore to complexity scale
    if (cScore < 20) complexityLimit = 1; // Tiny
    else if (cScore <= 40) complexityLimit = 2; // Small
    else if (cScore <= 70) complexityLimit = 4; // Medium (3-4)
    else complexityLimit = 8; // Large (5-8) or Enterprise (Dynamic)

    const sysCpus = Math.max(1, os.cpus().length);
    const maxConcurrency = this.options.maxConcurrencyOverride ?? this.graph.maxConcurrency ?? 3;

    const calculated = Math.max(1, Math.min(maxConcurrency, complexityLimit, sysCpus, Math.max(1, readyCount)));
    return calculated;
  }

  public getReadyNodes(): TaskNode[] {
    return this.nodesList.filter(node => {
      const isPendingOrReady =
        node.status === "PENDING" ||
        node.status === "pending" ||
        node.status === "READY" ||
        node.status === "ready";
      if (!isPendingOrReady) return false;

      const deps = node.dependsOn || node.dependencies || [];
      const depNodes = deps.map(depId => this.nodesList.find(n => n.id === depId));
      // Phase 2 dependency gate: every dependency must be COMPLETED with
      // structured success. Failed/skipped/budget-exhausted dependency blocks.
      return depNodes.every(dep => isDependencySuccessful(dep));
    });
  }

  public async start(): Promise<SchedulerState> {
    this.state.status = "RUNNING";
    this.state.startTime = Date.now();
    this.emitEvent("scheduler:start");

    return new Promise((resolve) => {
      const checkCompletion = () => {
        // Guard: terminal states are final — never re-resolve or resurrect.
        if (TERMINAL_SCHEDULER_STATES.has(this.state.status)) {
          return;
        }

        const totalProcessed =
          this.state.completedTaskIds.length +
          this.state.failedTaskIds.length +
          (this.state.skippedTaskIds?.length || 0);

        if (totalProcessed === this.nodesList.length || this.state.status === "FAILED") {
          this.state.endTime = Date.now();
          if (this.state.failedTaskIds.length > 0) {
            this.state.status = "FAILED";
          } else if (this.budget.getExhaustionReason()) {
            // Budget exhaustion is never reported as success.
            this.state.status = "BUDGET_EXCEEDED";
            // Emit the exhaustion event (idempotent) so observers always see
            // scheduler:budget_exhausted whenever the final state is not success.
            this.checkBudgetExhaustion();
          } else {
            this.state.status = "COMPLETED";
          }
          this.emitEvent(this.state.status === "COMPLETED" ? "scheduler:complete" : "scheduler:failed");
          activeSchedulers.delete(this);
          unsubscribeEvent();
          resolve(this.getState());
        }
      };

      const unsubscribeEvent = this.onEvent((event) => {
        if (event.type === "task:complete" || event.type === "task:failed" || event.type === "task:skipped") {
          checkCompletion();
        }
      });

      // Check first in case all tasks already completed synchronously
      checkCompletion();

      // Then start processing - tasks complete async and emit events
      this.processQueue().catch(() => { /* scheduler errors handled via task status */ });
    });
  }

  /** Pause dispatching (running workers finish; no new workers start). */
  public pause(): void {
    if (this.state.status === "RUNNING") {
      this.state.status = "PAUSED";
      this.emitEvent("scheduler:pause");
    }
  }

  /** Resume dispatching from PAUSED. */
  public resume(): void {
    if (this.state.status === "PAUSED") {
      this.state.status = "RUNNING";
      this.emitEvent("scheduler:resume");
      this.processQueue().catch(() => { /* scheduler errors handled via task status */ });
    }
  }

  /** Cancel: terminal. Late worker completions cannot resurrect the scheduler. */
  public cancel(): void {
    if (TERMINAL_SCHEDULER_STATES.has(this.state.status)) return;
    this.state.status = "CANCELLED" as TaskStatus as SchedulerStatus;
    this.emitEvent("scheduler:failed", undefined, { reason: "CANCELLED" });
    activeSchedulers.delete(this);
    // Wake the start() promise so callers awaiting start() observe CANCELLED
    // instead of hanging forever on running workers.
    const stillRunning = [...(this.state.runningTaskIds || [])];
    for (const id of stillRunning) {
      const node = this.nodesList.find(n => n.id === id);
      if (node) {
        node.skipReason = "CANCELLED";
        this.updateNodeStatus(node, "SKIPPED");
        this.emitEvent("task:skipped", node.id, { reason: "CANCELLED" });
      }
    }
  }

  private isSchedulerTerminal(): boolean {
    return TERMINAL_SCHEDULER_STATES.has(this.state.status);
  }

  private isSchedulerPaused(): boolean {
    return this.state.status === "PAUSED";
  }

  /**
   * Budget gate: emits `scheduler:budget_exhausted` once and marks all
   * still-pending/ready nodes SKIPPED(BUDGET_EXCEEDED) deterministically.
   * Returns true when the budget is exhausted.
   */
  private checkBudgetExhaustion(): boolean {
    if (!this.budget.isExhausted()) return false;

    if (!this.budgetExhaustedEmitted) {
      this.budgetExhaustedEmitted = true;
      this.emitEvent("scheduler:budget_exhausted", undefined, {
        reason: this.budget.getExhaustionReason(),
        tokensUsed: this.state.totalTokensUsed,
      });
      // Mark remaining pending/ready nodes as budget-exceeded skips.
      for (const node of this.nodesList) {
        const pendingLike = node.status === "PENDING" || node.status === "pending" ||
          node.status === "READY" || node.status === "ready";
        if (pendingLike) {
          node.skipReason = "BUDGET_EXCEEDED";
          node.outputResult = {
            success: false,
            error: `Budget exhausted (${this.budget.getExhaustionReason()}) before task could run.`,
            errorCode: "BUDGET_EXCEEDED",
          };
          this.updateNodeStatus(node, "SKIPPED");
          this.state.skippedTaskIds = this.addUnique(this.state.skippedTaskIds || [], node.id);
          this.emitEvent("task:skipped", node.id, { reason: "BUDGET_EXCEEDED" });
        }
      }
    }
    return true;
  }

  private async processQueue(): Promise<void> {
    // Guard clauses: never dispatch from a terminal or paused scheduler.
    if (this.isProcessingQueue) return;
    if (this.isSchedulerTerminal()) return;
    if (this.isSchedulerPaused()) return;
    this.isProcessingQueue = true;

    try {
      // 1. Recalculate dynamic max workers
      const newMax = this.calculateMaxWorkers();
      if (newMax !== this.state.maxWorkers) {
        this.state.maxWorkers = newMax;
        this.emitEvent("worker:scale");
      }

      // 2. Cascade failure to dependent orphan tasks
      this.checkAndSkipOrphanedTasks();

      // 3. Budget gate A: stop everything when exhausted
      if (this.checkBudgetExhaustion()) return;

      // 4. Mark ready tasks (dependency-gated)
      const readyNodes = this.getReadyNodes();
      for (const node of readyNodes) {
        if (node.status === "PENDING" || node.status === "pending") {
          this.updateNodeStatus(node, "READY");
          this.emitEvent("task:ready", node.id);
        }
      }
      this.state.readyTaskIds = readyNodes.map(n => n.id);

      // 5. Dispatch tasks to available worker slots
      while ((this.state.activeWorkers || 0) < (this.state.maxWorkers || 1) && readyNodes.length > 0) {
        // Budget gates B + A-repeat: re-check before every worker start.
        if (this.checkBudgetExhaustion()) break;
        if (this.isSchedulerTerminal() || this.isSchedulerPaused()) break;

        const nextNode = readyNodes.shift();
        if (!nextNode) break;

        // Atomic claim: only dispatch if the node is still READY (or PENDING
        // promoted here). Prevents double-dispatch under concurrent
        // processQueue invocations.
        if (!this.claimReadyNode(nextNode)) continue;

        // Guard: budget gate B (per-dispatch) — reclaim the task slot if the
        // budget ran out between the loop check and this claim.
        if (this.checkBudgetExhaustion()) {
          // Un-claim: put the node back to READY so it lands in the skip set.
          this.updateNodeStatus(nextNode, "READY");
          this.state.runningTaskIds = (this.state.runningTaskIds || []).filter(id => id !== nextNode.id);
          this.checkBudgetExhaustion();
          break;
        }

        this.state.activeWorkers = (this.state.activeWorkers || 0) + 1;
        this.budget.addTask();
        this.emitEvent("task:start", nextNode.id);

        this.executeWorkerTask(nextNode).finally(() => {
          this.state.activeWorkers = Math.max(0, (this.state.activeWorkers || 1) - 1);
          this.state.runningTaskIds = (this.state.runningTaskIds || []).filter(id => id !== nextNode.id);
          // Late completion: if scheduler went terminal while this worker ran,
          // do NOT re-enter the queue.
          if (!this.isSchedulerTerminal()) {
            this.processQueue().catch(() => { /* scheduler errors handled via task status */ });
          }
        });
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Atomically transitions a READY node to RUNNING and registers it as
   * dispatched exactly once. Returns false when the node was already claimed
   * (wrong status) or its id is already tracked in runningTaskIds.
   */
  private claimReadyNode(node: TaskNode): boolean {
    const claimable = node.status === "READY" || node.status === "ready";
    if (!claimable) return false;
    if ((this.state.runningTaskIds || []).includes(node.id)) return false;

    // Unique-registered running id (addUnique semantics).
    if (!this.state.runningTaskIds) this.state.runningTaskIds = [];
    if (!this.state.runningTaskIds.includes(node.id)) {
      this.state.runningTaskIds.push(node.id);
    }

    this.updateNodeStatus(node, "RUNNING");
    return true;
  }

  /** Adds an id to a terminal array only when absent (no duplicates). */
  private addUnique(list: string[] | undefined, id: string): string[] {
    const target = list || [];
    if (!target.includes(id)) target.push(id);
    return target;
  }

  private checkAndSkipOrphanedTasks(): void {
    for (const node of this.nodesList) {
      if (node.status === "PENDING" || node.status === "pending" || node.status === "READY" || node.status === "ready") {
        const deps = node.dependsOn || node.dependencies || [];
        const depNodes = deps.map(depId => this.nodesList.find(n => n.id === depId));
        if (hasFailedDependency(depNodes)) {
          node.skipReason = "BLOCKED_DEPENDENCY";
          this.updateNodeStatus(node, "SKIPPED");
          this.state.skippedTaskIds = this.addUnique(this.state.skippedTaskIds, node.id);
          this.emitEvent("task:skipped", node.id, { reason: "BLOCKED_DEPENDENCY" });
        }
      }
    }
  }

  private async executeWorkerTask(node: TaskNode): Promise<void> {
    const startTime = Date.now();
    node.startedAt = startTime;
    // attempts increments exactly once per worker attempt (dispatch = attempt).
    node.attempts = (node.attempts || 0) + 1;

    try {
      const deps = node.dependsOn || node.dependencies || [];
      // Dependency context is built ONLY from successful parents.
      const depContext = deps
        .map(depId => this.nodesList.find(n => n.id === depId))
        .filter(parent => parent && isDependencySuccessful(parent))
        .map(parent => {
          const out = parent!.outputResult as NodeOutputResult;
          const summary = out.output || (out as any).summary || parent!.result || "(no output)";
          return `[Dependency Output '${parent!.id}' (${parent!.role})]:\n${summary}`;
        })
        .join("\n\n");

      const fullPrompt = depContext
        ? `${depContext}\n\n[Task Prompt]: ${node.prompt || node.title}`
        : node.prompt || node.title;

      let workerResult: WorkerExecutionResult;
      if (this.options.executorFn) {
        // Structured contract (Phase 2): string → normalized structured result;
        // WorkerExecutionResult passes through. Empty string is never success.
        const raw = await this.options.executorFn(node, fullPrompt);
        workerResult = normalizeWorkerResult(raw);
      } else {
        workerResult = await this.runDefaultWorker(node, fullPrompt);
      }      node.durationMs = Date.now() - startTime;
      node.tokensUsed = workerResult.tokensUsed ?? node.tokensUsed;

      // Budget gate C: account actual tokens used by this worker — BEFORE the
      // success/failure branch, so failed attempts still burn budget (retry
      // gate D sees them; no infinite retry-on-free loop).
      const usedTokens = tokensOf(workerResult);
      if (usedTokens > 0) {
        this.budget.addTokens(usedTokens);
        this.state.totalTokensUsed = (this.state.totalTokensUsed || 0) + usedTokens;
      }

      if (workerResult.success) {
        node.result = workerResult.output || "";
        node.outputResult = {
          success: true,
          output: workerResult.output || "",
          tokensUsed: usedTokens,
          durationMs: node.durationMs,
          attempts: node.attempts || 1,
        };
        node.completedAt = Date.now();

        this.updateNodeStatus(node, "COMPLETED");
        this.state.completedTaskIds = this.addUnique(this.state.completedTaskIds, node.id);
        this.emitEvent("task:complete", node.id);
        return;
      }

      // Structured failure path (no exceptions lost, no stringly success).
      this.handleWorkerFailure(node, workerResult, startTime);
    } catch (err: unknown) {
      // Thrown errors still consume budget when carrying typed token counts.
      const failureResult = workerResultFromError(err);
      const thrownTokens = tokensOf(failureResult);
      if (thrownTokens > 0) {
        this.budget.addTokens(thrownTokens);
        this.state.totalTokensUsed = (this.state.totalTokensUsed || 0) + thrownTokens;
      }
      this.handleWorkerFailure(node, failureResult, startTime);
    }
  }

  /**
   * Deterministic failure handling with retry policy:
   *  - retryable error + attempts remaining + budget available → task:retry
   *  - otherwise → FAILED (terminal for the node)
   */
  private handleWorkerFailure(node: TaskNode, result: WorkerExecutionResult, startTime: number): void {
    node.error = result.error;
    node.errorCode = (result as any).errorCode;
    const maxAttempts = node.maxAttempts || node.maxRetries || this.options.defaultMaxAttempts || 2;
    const attempts = node.attempts || 1;
    const canRetry = result.retryable === true && attempts < maxAttempts;

    // Budget gate D: no retry when budget is exhausted.
    if (canRetry && this.budget.isExhausted()) {
      this.updateNodeStatus(node, "FAILED");
      this.state.failedTaskIds = this.addUnique(this.state.failedTaskIds, node.id);
      this.emitEvent("task:failed", node.id, { error: result.error, errorCode: result.errorCode });
      this.checkBudgetExhaustion();
      return;
    }

    if (canRetry) {
      // attempts increments exactly once per attempt (set in runWorkerAttempt).
      this.updateNodeStatus(node, "PENDING");
      this.emitEvent("task:retry", node.id, { attempts, maxAttempts, error: result.error, errorCode: result.errorCode });
      return;
    }

    node.completedAt = Date.now();
    node.durationMs = Date.now() - startTime;
    node.outputResult = {
      success: false,
      output: result.output,
      error: result.error,
      errorCode: result.errorCode,
      retryable: result.retryable,
      tokensUsed: tokensOf(result),
      durationMs: node.durationMs,
      attempts,
    };

    this.updateNodeStatus(node, "FAILED");
    this.state.failedTaskIds = this.addUnique(this.state.failedTaskIds, node.id);
    this.emitEvent("task:failed", node.id, { error: result.error, errorCode: result.errorCode });
  }

  /**
   * Default worker: real sub-agent execution via executeSubagentTask.
   * Returns a STRUCTURED result — provider/network/auth failures are typed
   * failures (PROVIDER_NETWORK / AUTH_REQUIRED / MODEL_NOT_FOUND), never
   * stringly-typed fake success.
   */
  private async runDefaultWorker(node: TaskNode, prompt: string): Promise<WorkerExecutionResult> {
    try {
      const res = await executeSubagentTask(
        {
          ...node,
          prompt: prompt || node.prompt || node.title,
        },
        {
          gatewayUrl: this.options.gatewayUrl,
          model: this.options.model || "default",
          sessionId: this.options.sessionId || this.state.sessionId,
          sandboxMode: this.options.sandboxMode,
          workspaceRoot: this.options.workspaceRoot,
          cwd: this.options.cwd,
          agentDepth: this.options.agentDepth,
          source: "teamwork", // typed into SubagentOptions below
          onEvent: (event, data) => {
            if (event === "subagent:tool") {
              this.emitEvent("task:progress", node.id, {
                toolName: data.toolName,
                toolArgs: data.toolArgs,
              });
            }
          },
        }
      );

      const result: WorkerExecutionResult = {
        success: res.success,
        output: res.output,
        tokensUsed: res.tokensUsed || 0,
      };

      if (res.success) return result;

      // Typed failure: classify once, keep the machine-readable code.
      const classified = classifyWorkerError(new Error(res.error || `Sub-Agent execution failed for task '${node.id}'`));
      return {
        success: false,
        output: res.output,
        error: classified.message,
        errorCode: classified.code,
        retryable: classified.retryable,
        tokensUsed: result.tokensUsed,
      };
    } catch (err: unknown) {
      return workerResultFromError(err);
    }
  }
}
