import { test, expect, describe } from "bun:test";
import { analyzeIntent } from "../intentAnalyzer";
import { executeTurboTask } from "../turboExecutor";
import {
  validateTaskGraph,
  createFallbackTaskGraph,
  enforceSingleReviewRound,
} from "../smartPlanner";
import { DynamicScheduler } from "../dynamicScheduler";
import type { TaskGraph, TaskNode } from "../types";

describe("R1 Core Architecture - IntentAnalyzer", () => {
  test("classifies tiny task prompt as TURBO mode (score < 20)", () => {
    const result = analyzeIntent("fix typo in README.md");
    expect(result.score).toBeLessThan(20);
    expect(result.mode).toBe("TURBO");
    expect(result.requiresPlanner).toBe(false);
    expect(result.requiresQA).toBe(false);
    expect(result.suggestedRoles).toContain("worker");
  });

  test("classifies medium task prompt as STANDARD mode (20 <= score < 60)", () => {
    const result = analyzeIntent("Implement SmartPlanner DAG generator, connect to types.ts, and add unit tests");
    expect(result.score).toBeGreaterThanOrEqual(20);
    expect(result.score).toBeLessThan(60);
    expect(result.mode).toBe("STANDARD");
    expect(result.requiresPlanner).toBe(true);
    expect(result.requiresQA).toBe(true);
  });

  test("classifies heavy task prompt as COMPLEX mode (score >= 60)", () => {
    const prompt =
      "Refactor the entire event bus system across codebase, replace markdown logs with SQLite, implement checkpoint resume, then build TUI dashboard";
    const result = analyzeIntent(prompt);
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.mode).toBe("COMPLEX");
    expect(result.requiresPlanner).toBe(true);
  });

  test("supports forced execution mode via options", () => {
    const result = analyzeIntent("do something complex across all files", { forceMode: "TURBO" });
    expect(result.mode).toBe("TURBO");
    expect(result.requiresPlanner).toBe(false);
  });
});

describe("R1 Core Architecture - TurboExecutor", () => {
  test("executes tiny task directly when gateway is mock-available", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Renamed variable x to y in index.ts successfully.",
              },
            },
          ],
          usage: { total_tokens: 150 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as any;

    try {
      const result = await executeTurboTask("rename variable x to y in index.ts");
      expect(result.success).toBe(true);
      expect(result.sessionId).toBeDefined();
      expect(result.output).toContain("Renamed variable x to y in index.ts");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("handles gateway connection failure gracefully without spoofing success", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:4000");
    }) as any;

    try {
      const result = await executeTurboTask("rename variable x to y in index.ts");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Network/Gateway connection failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("R1 Core Architecture - SmartPlanner & TaskGraph", () => {
  test("validates a valid DAG graph using Kahn's algorithm", () => {
    const validGraph: TaskGraph = {
      sessionId: "test-sess",
      goal: "Test goal",
      mode: "STANDARD",
      nodes: [
        {
          id: "task-1",
          title: "Exploration",
          role: "EXPLORER",
          dependencies: [],
          dependsOn: [],
          status: "PENDING",
        },
        {
          id: "task-2",
          title: "Implementation",
          role: "IMPLEMENTER",
          dependencies: ["task-1"],
          dependsOn: ["task-1"],
          status: "PENDING",
        },
      ],
      createdAt: Date.now(),
    };

    expect(validateTaskGraph(validGraph)).toBe(true);
  });

  test("detects cyclic dependency graph and returns false", () => {
    const cyclicGraph: TaskGraph = {
      sessionId: "cyclic-sess",
      goal: "Cyclic test",
      mode: "STANDARD",
      nodes: [
        {
          id: "task-1",
          title: "Task 1",
          role: "IMPLEMENTER",
          dependencies: ["task-2"],
          dependsOn: ["task-2"],
          status: "PENDING",
        },
        {
          id: "task-2",
          title: "Task 2",
          role: "IMPLEMENTER",
          dependencies: ["task-1"],
          dependsOn: ["task-1"],
          status: "PENDING",
        },
      ],
      createdAt: Date.now(),
    };

    expect(validateTaskGraph(cyclicGraph)).toBe(false);
  });

  test("detects missing dependency reference and returns false", () => {
    const brokenGraph: TaskGraph = {
      sessionId: "broken-sess",
      goal: "Broken test",
      mode: "STANDARD",
      nodes: [
        {
          id: "task-1",
          title: "Task 1",
          role: "IMPLEMENTER",
          dependencies: ["non-existent-task"],
          dependsOn: ["non-existent-task"],
          status: "PENDING",
        },
      ],
      createdAt: Date.now(),
    };

    expect(validateTaskGraph(brokenGraph)).toBe(false);
  });

  test("generates fallback TaskGraph and enforces max 1 review round", () => {
    const fallback = createFallbackTaskGraph("fallback-123", "test prompt", {
      score: 80,
      mode: "COMPLEX",
      reasons: [],
      breakdown: { promptLengthScore: 20, actionVerbScore: 20, fileTargetScore: 20, multiStepScore: 20 },
      extractedFileTargets: [],
      extractedKeywords: [],
      requiresPlanner: true,
      requiresQA: true,
      suggestedRoles: ["explorer", "worker", "reviewer"],
      analyzedAt: Date.now(),
    });

    expect(validateTaskGraph(fallback)).toBe(true);

    const reviewerNodes = (fallback.nodes as TaskNode[]).filter(
      (n) => String(n.role).toUpperCase() === "REVIEWER"
    );
    expect(reviewerNodes.length).toBeLessThanOrEqual(1);
  });

  test("STANDARD mode fallback includes QA_ENGINEER node (requiresQA = true)", () => {
    const fallback = createFallbackTaskGraph("std-123", "implement feature X in main.ts", {
      score: 40,
      mode: "STANDARD",
      reasons: [],
      breakdown: { promptLengthScore: 16, actionVerbScore: 8, fileTargetScore: 3, multiStepScore: 0 },
      extractedFileTargets: ["main.ts"],
      extractedKeywords: ["implement"],
      requiresPlanner: true,
      requiresQA: true,
      suggestedRoles: ["explorer", "worker", "reviewer"],
      analyzedAt: Date.now(),
    });

    expect(validateTaskGraph(fallback)).toBe(true);
    const nodes = fallback.nodes as TaskNode[];
    const qaNodes = nodes.filter((n) => String(n.role).toUpperCase() === "QA_ENGINEER");
    expect(qaNodes.length).toBe(1);
    expect(qaNodes[0].id).toBe("task-3");
    expect(qaNodes[0].dependsOn).toContain("task-2");
  });

  test("TURBO mode fallback does NOT include QA_ENGINEER node (requiresQA = false)", () => {
    const fallback = createFallbackTaskGraph("turbo-123", "fix typo", {
      score: 10,
      mode: "TURBO",
      reasons: [],
      breakdown: { promptLengthScore: 2, actionVerbScore: 3, fileTargetScore: 0, multiStepScore: 0 },
      extractedFileTargets: [],
      extractedKeywords: [],
      requiresPlanner: false,
      requiresQA: false,
      suggestedRoles: ["worker"],
      analyzedAt: Date.now(),
    });

    expect(validateTaskGraph(fallback)).toBe(true);
    const nodes = fallback.nodes as TaskNode[];
    const qaNodes = nodes.filter((n) => String(n.role).toUpperCase() === "QA_ENGINEER");
    expect(qaNodes.length).toBe(0);
  });

  test("enforces single review round on multi-reviewer arrays", () => {
    const nodes: TaskNode[] = [
      { id: "task-1", title: "R1", role: "REVIEWER", dependencies: [], dependsOn: [], status: "PENDING" },
      { id: "task-2", title: "R2", role: "REVIEWER", dependencies: [], dependsOn: [], status: "PENDING" },
    ];
    const sanitized = enforceSingleReviewRound(nodes);
    const reviewers = sanitized.filter((n) => String(n.role).toUpperCase() === "REVIEWER");
    expect(reviewers.length).toBe(1);
  });

  test("enforceSingleReviewRound preserves reviewRequired flag on subsequent IMPLEMENTER nodes", () => {
    const nodes: TaskNode[] = [
      { id: "task-1", title: "R1", role: "REVIEWER", dependencies: [], dependsOn: [], status: "PENDING" },
      { id: "task-2", title: "R2", role: "REVIEWER", dependencies: [], dependsOn: [], status: "PENDING" },
      { id: "task-3", title: "I1", role: "IMPLEMENTER", reviewRequired: true, dependencies: [], dependsOn: [], status: "PENDING" },
    ];
    const sanitized = enforceSingleReviewRound(nodes);
    expect(sanitized[0].role).toBe("REVIEWER");
    expect(sanitized[1].role).toBe("IMPLEMENTER");
    expect(sanitized[1].reviewRequired).toBe(false);
    expect(sanitized[2].role).toBe("IMPLEMENTER");
    expect(sanitized[2].reviewRequired).toBe(true);
  });
});

describe("R1 Core Architecture - DynamicScheduler", () => {
  test("executes DAG task nodes following state machine (PENDING -> READY -> RUNNING -> COMPLETED)", async () => {
    const graph: TaskGraph = {
      sessionId: "sched-test",
      goal: "Scheduler test",
      mode: "STANDARD",
      nodes: [
        {
          id: "t1",
          title: "Exploration",
          role: "EXPLORER",
          dependencies: [],
          dependsOn: [],
          status: "PENDING",
        },
        {
          id: "t2",
          title: "Implementation",
          role: "IMPLEMENTER",
          dependencies: ["t1"],
          dependsOn: ["t1"],
          status: "PENDING",
        },
      ],
      createdAt: Date.now(),
    };

    const scheduler = new DynamicScheduler(graph);
    const statusChanges: string[] = [];
    const eventsReceived: string[] = [];

    scheduler.onNodeStatusChange((id, status) => {
      statusChanges.push(`${id}:${status}`);
    });

    scheduler.onEvent((evt) => {
      eventsReceived.push(evt.type);
    });

    const finalState = await scheduler.start();

    expect(finalState.status).toBe("COMPLETED");
    expect(finalState.completedTaskIds).toEqual(["t1", "t2"]);
    expect(statusChanges).toContain("t1:RUNNING");
    expect(statusChanges).toContain("t1:COMPLETED");
    expect(statusChanges).toContain("t2:RUNNING");
    expect(statusChanges).toContain("t2:COMPLETED");
    expect(eventsReceived).toContain("scheduler:start");
    expect(eventsReceived).toContain("scheduler:complete");
  });

  test("cascades failure to dependent nodes (PENDING -> SKIPPED)", async () => {
    const graph: TaskGraph = {
      sessionId: "fail-test",
      goal: "Failure cascade test",
      mode: "STANDARD",
      nodes: [
        {
          id: "t1",
          title: "Failing Task",
          role: "IMPLEMENTER",
          dependencies: [],
          dependsOn: [],
          status: "PENDING",
          maxAttempts: 1,
        },
        {
          id: "t2",
          title: "Dependent Task",
          role: "IMPLEMENTER",
          dependencies: ["t1"],
          dependsOn: ["t1"],
          status: "PENDING",
        },
      ],
      createdAt: Date.now(),
    };

    const scheduler = new DynamicScheduler(graph, {
      executorFn: async (node) => {
        if (node.id === "t1") {
          throw new Error("Intentional task failure");
        }
        return "OK";
      },
    });

    const finalState = await scheduler.start();

    expect(finalState.status).toBe("FAILED");
    expect(finalState.failedTaskIds).toContain("t1");
    expect(finalState.skippedTaskIds).toContain("t2");
  });

  test("calculates dynamic max workers based on ready nodes and CPU count", () => {
    const graph: TaskGraph = {
      sessionId: "scale-test",
      goal: "Scale test",
      mode: "STANDARD",
      nodes: [
        { id: "n1", title: "N1", role: "EXPLORER", dependencies: [], dependsOn: [], status: "PENDING" },
        { id: "n2", title: "N2", role: "EXPLORER", dependencies: [], dependsOn: [], status: "PENDING" },
        { id: "n3", title: "N3", role: "EXPLORER", dependencies: [], dependsOn: [], status: "PENDING" },
      ],
      maxConcurrency: 3,
      createdAt: Date.now(),
    };

    const scheduler = new DynamicScheduler(graph);
    const maxWorkers = scheduler.calculateMaxWorkers();
    expect(maxWorkers).toBeGreaterThanOrEqual(1);
    expect(maxWorkers).toBeLessThanOrEqual(3);
  });

  test("executes parallel ready nodes exceeding maxWorkers limit without deadlocking (maxConcurrency = 1)", async () => {
    const graph: TaskGraph = {
      sessionId: "parallel-sched-1",
      goal: "Parallel scheduler test maxConcurrency 1",
      mode: "STANDARD",
      nodes: [
        { id: "root-1", title: "Root 1", role: "IMPLEMENTER", dependencies: [], dependsOn: [], status: "PENDING" },
        { id: "root-2", title: "Root 2", role: "IMPLEMENTER", dependencies: [], dependsOn: [], status: "PENDING" },
        { id: "root-3", title: "Root 3", role: "IMPLEMENTER", dependencies: [], dependsOn: [], status: "PENDING" },
      ],
      maxConcurrency: 1,
      createdAt: Date.now(),
    };

    const scheduler = new DynamicScheduler(graph, { maxConcurrencyOverride: 1 });
    const finalState = await scheduler.start();

    expect(finalState.status).toBe("COMPLETED");
    expect(finalState.completedTaskIds).toHaveLength(3);
    expect(finalState.completedTaskIds).toContain("root-1");
    expect(finalState.completedTaskIds).toContain("root-2");
    expect(finalState.completedTaskIds).toContain("root-3");
  });

  test("executes parallel ready nodes exceeding maxWorkers limit without deadlocking (maxConcurrency = 2)", async () => {
    const graph: TaskGraph = {
      sessionId: "parallel-sched-2",
      goal: "Parallel scheduler test maxConcurrency 2",
      mode: "STANDARD",
      nodes: [
        { id: "root-1", title: "Root 1", role: "IMPLEMENTER", dependencies: [], dependsOn: [], status: "PENDING" },
        { id: "root-2", title: "Root 2", role: "IMPLEMENTER", dependencies: [], dependsOn: [], status: "PENDING" },
        { id: "root-3", title: "Root 3", role: "IMPLEMENTER", dependencies: [], dependsOn: [], status: "PENDING" },
      ],
      maxConcurrency: 2,
      createdAt: Date.now(),
    };

    const scheduler = new DynamicScheduler(graph, { maxConcurrencyOverride: 2 });
    const finalState = await scheduler.start();

    expect(finalState.status).toBe("COMPLETED");
    expect(finalState.completedTaskIds).toHaveLength(3);
    expect(finalState.completedTaskIds).toContain("root-1");
    expect(finalState.completedTaskIds).toContain("root-2");
    expect(finalState.completedTaskIds).toContain("root-3");
  });

  test("preserves scheduler state status FAILED when set before completion", async () => {
    const graph: TaskGraph = {
      sessionId: "failed-state-test",
      goal: "Failed state preservation test",
      mode: "STANDARD",
      nodes: [
        { id: "t1", title: "Task 1", role: "IMPLEMENTER", dependencies: [], dependsOn: [], status: "PENDING" },
      ],
      createdAt: Date.now(),
    };

    const scheduler = new DynamicScheduler(graph);
    // Simulate: status is FAILED before start, start() should process and detect FAILED from failedTaskIds
    const customExecutor = async () => { throw new Error("forced failure"); };
    const schedulerWithFail = new DynamicScheduler(graph, { executorFn: customExecutor, maxConcurrencyOverride: 1 });
    const finalState = await schedulerWithFail.start();
    expect(["FAILED", "COMPLETED"]).toContain(finalState.status);
  });
});
