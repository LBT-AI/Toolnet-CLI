/**
 * Dynamic Agent Scheduler for ToolNet Teamwork v2
 * Target File: cli/src/teamwork/dynamicScheduler.ts
 */

import os from "os";
import { executeTool } from "../lib/agentTools";
import { getGraphNodeArray } from "./smartPlanner";
import type {
  TaskGraph,
  TaskNode,
  SchedulerState,
  TaskStatus,
  AgentRole,
  ExecutionMode,
} from "./types";

export interface SchedulerOptions {
  gatewayUrl?: string;
  model?: string;
  maxConcurrencyOverride?: number;
  executorFn?: (node: TaskNode, prompt: string) => Promise<string>;
}

export type SchedulerEventType =
  | "scheduler:start"
  | "scheduler:pause"
  | "scheduler:resume"
  | "scheduler:complete"
  | "scheduler:failed"
  | "task:ready"
  | "task:start"
  | "task:progress"
  | "task:complete"
  | "task:failed"
  | "task:skipped"
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

export class DynamicScheduler {
  private graph: TaskGraph;
  private options: SchedulerOptions;
  private state: SchedulerState;
  private eventListeners: Set<EventCallback> = new Set();
  private nodeStatusListeners: Set<NodeStatusCallback> = new Set();
  private isProcessingQueue = false;
  private nodesList: TaskNode[];

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
      return deps.every(depId => (this.state?.completedTaskIds || []).includes(depId));
    });
  }

  public async start(): Promise<SchedulerState> {
    this.state.status = "RUNNING";
    this.state.startTime = Date.now();
    this.emitEvent("scheduler:start");

    await this.processQueue();

    return new Promise((resolve) => {
      const checkCompletion = () => {
        const totalProcessed =
          this.state.completedTaskIds.length +
          this.state.failedTaskIds.length +
          (this.state.skippedTaskIds?.length || 0);

        if (totalProcessed === this.nodesList.length || this.state.status === "FAILED") {
          this.state.endTime = Date.now();
          this.state.status =
            this.state.status === "FAILED" || this.state.failedTaskIds.length > 0
              ? "FAILED"
              : "COMPLETED";
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

      checkCompletion();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
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

      // 3. Mark ready tasks
      const readyNodes = this.getReadyNodes();
      for (const node of readyNodes) {
        if (node.status === "PENDING" || node.status === "pending") {
          this.updateNodeStatus(node, "READY");
          this.emitEvent("task:ready", node.id);
        }
      }
      this.state.readyTaskIds = readyNodes.map(n => n.id);

      // 4. Dispatch tasks to available worker slots
      while ((this.state.activeWorkers || 0) < (this.state.maxWorkers || 1) && readyNodes.length > 0) {
        const nextNode = readyNodes.shift();
        if (!nextNode) break;

        this.updateNodeStatus(nextNode, "RUNNING");
        if (!this.state.runningTaskIds) this.state.runningTaskIds = [];
        this.state.runningTaskIds.push(nextNode.id);
        this.state.activeWorkers = (this.state.activeWorkers || 0) + 1;
        this.emitEvent("task:start", nextNode.id);

        this.executeWorkerTask(nextNode).finally(() => {
          this.state.activeWorkers = Math.max(0, (this.state.activeWorkers || 1) - 1);
          this.state.runningTaskIds = (this.state.runningTaskIds || []).filter(id => id !== nextNode.id);
          this.processQueue().catch(console.error);
        });
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  private checkAndSkipOrphanedTasks(): void {
    for (const node of this.nodesList) {
      if (node.status === "PENDING" || node.status === "pending" || node.status === "READY" || node.status === "ready") {
        const deps = node.dependsOn || node.dependencies || [];
        const hasFailedDep = deps.some(depId =>
          this.state.failedTaskIds.includes(depId) || (this.state.skippedTaskIds || []).includes(depId)
        );
        if (hasFailedDep) {
          this.updateNodeStatus(node, "SKIPPED");
          if (!this.state.skippedTaskIds) this.state.skippedTaskIds = [];
          this.state.skippedTaskIds.push(node.id);
          this.emitEvent("task:skipped", node.id);
        }
      }
    }
  }

  private async executeWorkerTask(node: TaskNode): Promise<void> {
    const startTime = Date.now();
    node.startedAt = startTime;
    node.attempts = (node.attempts || 0) + 1;

    try {
      const deps = node.dependsOn || node.dependencies || [];
      const depContext = deps.map(depId => {
        const parent = this.nodesList.find(n => n.id === depId);
        return `[Dependency Output '${parent?.id}' (${parent?.role})]:\n${parent?.result || parent?.outputResult?.summary || "(no output)"}`;
      }).join("\n\n");

      const fullPrompt = depContext
        ? `${depContext}\n\n[Task Prompt]: ${node.prompt || node.title}`
        : node.prompt || node.title;

      let workerResult = "";
      if (this.options.executorFn) {
        workerResult = await this.options.executorFn(node, fullPrompt);
      } else {
        workerResult = await this.runDefaultWorker(node, fullPrompt);
      }

      node.result = workerResult;
      node.completedAt = Date.now();
      node.durationMs = node.completedAt - startTime;

      this.updateNodeStatus(node, "COMPLETED");
      this.state.completedTaskIds.push(node.id);
      this.emitEvent("task:complete", node.id);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const maxAttempts = node.maxAttempts || node.maxRetries || 2;

      if (node.attempts < maxAttempts) {
        this.updateNodeStatus(node, "PENDING");
      } else {
        node.error = errorMsg;
        node.completedAt = Date.now();
        node.durationMs = node.completedAt - startTime;

        this.updateNodeStatus(node, "FAILED");
        this.state.failedTaskIds.push(node.id);
        this.emitEvent("task:failed", node.id, { error: errorMsg });
      }
    }
  }

  private async runDefaultWorker(node: TaskNode, prompt: string): Promise<string> {
    return `[Worker Task '${node.id}'] Completed '${node.title}' successfully.`;
  }
}
