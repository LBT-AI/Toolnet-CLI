/**
 * Smart Planner (JSON Task Graph DAG Generator & Validator) for ToolNet Teamwork v2
 * Target File: cli/src/teamwork/smartPlanner.ts
 */

import { detectGatewayUrl } from "../lib/gateway";
import type { TaskGraph, TaskNode, IntentAnalysisResult, SmartPlannerOptions, AgentRole } from "./types";

const SMART_PLANNER_SYSTEM_PROMPT = `You are ToolNet Smart Planner, a principal multi-agent software architect.
Your task is to decompose a software request into a structured Directed Acyclic Graph (DAG) of task nodes.

JSON Output Schema:
{
  "nodes": [
    {
      "id": "task-1",
      "title": "Short title describing task node",
      "role": "EXPLORER" | "IMPLEMENTER" | "REVIEWER" | "QA_ENGINEER",
      "prompt": "Detailed instructions for worker agent",
      "dependsOn": [],
      "targetFiles": ["cli/src/example.ts"],
      "reviewRequired": boolean,
      "estimatedTokens": 2000
    }
  ],
  "maxConcurrency": 2,
  "totalEstimatedTokens": 6000,
  "rationale": "Decomposed task into exploration, implementation, and review steps."
}

Rules:
1. Every node MUST have a unique ID (e.g. task-1, task-2).
2. \`dependsOn\` must contain ONLY node IDs that appear in the graph. NO circular dependencies!
3. \`role\` MUST be one of: "EXPLORER", "IMPLEMENTER", "REVIEWER", "QA_ENGINEER".
4. Max 1 QA/Review node across the entire task graph (Intelligent Review Policy). If code changes are made, ALWAYS include a "QA_ENGINEER" node to run tests/build/verification commands and fix errors.
5. Output ONLY raw JSON matching the schema.`;

/**
 * Normalizes nodes from array or record format to TaskNode array.
 */
export function getGraphNodeArray(graph: TaskGraph): TaskNode[] {
  if (Array.isArray(graph.nodes)) {
    return graph.nodes;
  }
  if (graph.nodes && typeof graph.nodes === 'object') {
    return Object.values(graph.nodes);
  }
  return [];
}

/**
 * Validates a TaskGraph for node ID uniqueness, dependency existence, and cycle freedom (Kahn's Algorithm).
 * Returns true if valid DAG, false otherwise.
 */
export function validateTaskGraph(graph: TaskGraph): boolean {
  try {
    const nodes = getGraphNodeArray(graph);
    if (!nodes || nodes.length === 0) return false;

    const nodeMap = new Map<string, TaskNode>();
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();

    for (const node of nodes) {
      if (!node.id || nodeMap.has(node.id)) {
        return false; // Duplicate or invalid ID
      }
      nodeMap.set(node.id, node);
      inDegree.set(node.id, 0);
      adjList.set(node.id, []);
    }

    // Build graph adjacency list and calculate in-degrees
    for (const node of nodes) {
      const deps = node.dependsOn || node.dependencies || [];
      for (const depId of deps) {
        if (!nodeMap.has(depId)) {
          return false; // Non-existent dependency
        }
        adjList.get(depId)!.push(node.id);
        inDegree.set(node.id, (inDegree.get(node.id) || 0) + 1);
      }
    }

    // Kahn's Algorithm for cycle detection
    const queue: string[] = [];
    for (const [id, count] of inDegree.entries()) {
      if (count === 0) queue.push(id);
    }

    let visitedCount = 0;
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      visitedCount++;

      const children = adjList.get(currentId) || [];
      for (const childId of children) {
        const newDegree = (inDegree.get(childId) || 0) - 1;
        inDegree.set(childId, newDegree);
        if (newDegree === 0) {
          queue.push(childId);
        }
      }
    }

    return visitedCount === nodes.length;
  } catch {
    return false;
  }
}

/**
 * Enforces maximum 1 review round across all nodes in a TaskGraph.
 */
export function enforceSingleReviewRound(nodes: TaskNode[]): TaskNode[] {
  let reviewerCount = 0;
  return nodes.map((node) => {
    const roleUpper = String(node.role).toUpperCase();
    let updatedRole = node.role;
    let reviewRequired = Boolean(node.reviewRequired ?? node.requiresReview);

    if (roleUpper === 'REVIEWER' || roleUpper === 'REVIEW' || roleUpper === 'QA_ENGINEER') {
      reviewerCount++;
      if (reviewerCount > 1) {
        updatedRole = 'IMPLEMENTER';
        reviewRequired = false;
      } else {
        // Normalize role name for validation/display
        updatedRole = roleUpper === 'QA_ENGINEER' ? 'QA_ENGINEER' : 'REVIEWER';
      }
    }
    return {
      ...node,
      role: updatedRole as AgentRole,
      dependsOn: node.dependsOn || node.dependencies || [],
      dependencies: node.dependencies || node.dependsOn || [],
      reviewRequired,
      requiresReview: reviewRequired,
    };
  });
}

/**
 * Constructs a fallback TaskGraph if LLM JSON parsing or validation fails.
 */
export function createFallbackTaskGraph(
  sessionId: string,
  userPrompt: string,
  analysisResult?: IntentAnalysisResult
): TaskGraph {
  const mode = analysisResult?.mode || "STANDARD";
  const isComplex = mode === "COMPLEX" || (analysisResult?.score ?? 50) >= 60;
  // QA is enabled for any task that isn't explicitly TURBO (score < 20)
  const needsQA = isComplex || (analysisResult?.requiresQA ?? true);

  const nodes: TaskNode[] = [
    {
      id: "task-1",
      title: "Context & Codebase Exploration",
      prompt: `Analyze project structure and target files for request: "${userPrompt}"`,
      role: "EXPLORER" as AgentRole,
      dependencies: [],
      dependsOn: [],
      targetFiles: analysisResult?.extractedFileTargets || [],
      reviewRequired: false,
      requiresReview: false,
      status: "PENDING",
      estimatedTokens: 2000,
      attempts: 0,
      maxAttempts: 2,
    },
    {
      id: "task-2",
      title: "Core Implementation",
      prompt: `Implement changes required for request: "${userPrompt}" based on exploration results.`,
      role: "IMPLEMENTER" as AgentRole,
      dependencies: ["task-1"],
      dependsOn: ["task-1"],
      targetFiles: analysisResult?.extractedFileTargets || [],
      reviewRequired: needsQA,
      requiresReview: needsQA,
      status: "PENDING",
      estimatedTokens: 4000,
      attempts: 0,
      maxAttempts: 2,
    },
  ];

  if (needsQA) {
    nodes.push({
      id: "task-3",
      title: "QA Verification & Code Review",
      prompt: `Verify implementation of task-2 against prompt: "${userPrompt}". 1. Detect project framework. 2. Run typecheck, lint, build, or tests using run_command. 3. If tests fail, read stderr, identify root cause, fix, and rerun. Loop until passed or max retries reached.`,
      role: "QA_ENGINEER" as AgentRole,
      dependencies: ["task-2"],
      dependsOn: ["task-2"],
      targetFiles: analysisResult?.extractedFileTargets || [],
      reviewRequired: false,
      requiresReview: false,
      status: "PENDING",
      estimatedTokens: 1500,
      attempts: 0,
      maxAttempts: 1,
    });
  }

  const sanitizedNodes = enforceSingleReviewRound(nodes);

  return {
    id: `graph-${sessionId}`,
    sessionId,
    userPrompt,
    goal: userPrompt,
    mode,
    nodes: sanitizedNodes,
    maxConcurrency: 2,
    totalEstimatedTokens: needsQA ? 7500 : 6000,
    createdAt: Date.now(),
    rationale: "Deterministic fallback TaskGraph generated for reliable task execution.",
  };
}

/**
 * Generates a structured TaskGraph JSON object using Gateway LLM chat completion.
 */
export async function generateTaskGraph(
  userPrompt: string,
  analysisResult?: IntentAnalysisResult,
  options: SmartPlannerOptions = {}
): Promise<TaskGraph> {
  const sessionId = options.sessionId || `plan-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const gatewayUrl = options.gatewayUrl || detectGatewayUrl();
  const eventBus = options.eventBus;

  if (eventBus) {
    try {
      await eventBus.emit("PLANNER_STARTED", { sessionId, userPrompt });
    } catch {}
  }

  try {
    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model || "default",
        messages: [
          { role: "system", content: SMART_PLANNER_SYSTEM_PROMPT },
          {
            role: "user",
            content: `User Prompt: "${userPrompt}"\nComplexity Score: ${analysisResult?.score ?? 50}\nMode: ${analysisResult?.mode ?? "STANDARD"}`,
          },
        ],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Gateway returned HTTP ${response.status}`);
    }

    const data = await response.json();
    const rawContent = data.choices?.[0]?.message?.content || "";

    const cleanedJson = rawContent
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/, "")
      .replace(/\s*```$/, "")
      .trim();

    const parsed = JSON.parse(cleanedJson);

    if (!parsed.nodes || !Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
      throw new Error("Planner JSON output contains no valid task nodes array");
    }

    let nodes: TaskNode[] = parsed.nodes.map((node: any, index: number) => {
      const deps = Array.isArray(node.dependsOn)
        ? node.dependsOn
        : Array.isArray(node.dependencies)
        ? node.dependencies
        : [];

      return {
        id: node.id || `task-${index + 1}`,
        title: node.title || `Subtask ${index + 1}`,
        prompt: node.prompt || node.description || userPrompt,
        role: node.role || "IMPLEMENTER",
        dependencies: deps,
        dependsOn: deps,
        targetFiles: Array.isArray(node.targetFiles) ? node.targetFiles : [],
        reviewRequired: Boolean(node.reviewRequired || node.requiresReview),
        requiresReview: Boolean(node.reviewRequired || node.requiresReview),
        status: "PENDING",
        estimatedTokens: Number(node.estimatedTokens) || 2000,
        attempts: 0,
        maxAttempts: 2,
      };
    });

    // Enforce max 1 review round
    nodes = enforceSingleReviewRound(nodes);

    // Auto-inject QA_ENGINEER node if missing and requiresQA is not explicitly false
    const hasQAOrReviewer = nodes.some(
      (n) => String(n.role).toUpperCase() === "QA_ENGINEER" || String(n.role).toUpperCase() === "REVIEWER"
    );
    if (!hasQAOrReviewer && analysisResult?.requiresQA !== false) {
      // Find the last IMPLEMENTER node to depend on
      const lastImplementer = [...nodes].reverse().find((n) => String(n.role).toUpperCase() === "IMPLEMENTER");
      const qaNodeId = `task-${nodes.length + 1}`;
      nodes.push({
        id: qaNodeId,
        title: "QA Verification",
        prompt:
          "Run project verification: detect framework (check package.json/Cargo.toml/pyproject.toml/Makefile/go.mod), run appropriate typecheck/lint/test commands, read errors, fix failing code, re-run until clean.",
        role: "QA_ENGINEER" as AgentRole,
        dependencies: lastImplementer ? [lastImplementer.id] : [],
        dependsOn: lastImplementer ? [lastImplementer.id] : [],
        targetFiles: [],
        reviewRequired: false,
        requiresReview: false,
        status: "PENDING",
        estimatedTokens: 1500,
        attempts: 0,
        maxAttempts: 1,
      });
    }

    const taskGraph: TaskGraph = {
      id: `graph-${sessionId}`,
      sessionId,
      userPrompt,
      goal: userPrompt,
      mode: analysisResult?.mode || "STANDARD",
      nodes,
      maxConcurrency: options.maxConcurrency ?? parsed.maxConcurrency ?? 2,
      totalEstimatedTokens: parsed.totalEstimatedTokens || nodes.reduce((sum, n) => sum + (n.estimatedTokens || 2000), 0),
      createdAt: Date.now(),
      rationale: parsed.rationale || "Successfully generated DAG task graph.",
    };

    if (!validateTaskGraph(taskGraph)) {
      throw new Error("Generated TaskGraph failed DAG topological validation");
    }

    if (eventBus) {
      try {
        await eventBus.emit("PLANNER_COMPLETED", { sessionId, nodeCount: nodes.length, taskGraph });
      } catch {}
    }

    return taskGraph;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (eventBus) {
      try {
        await eventBus.emit("PLANNER_FALLBACK_TRIGGERED", { sessionId, error: errorMsg });
      } catch {}
    }

    const fallbackGraph = createFallbackTaskGraph(sessionId, userPrompt, analysisResult);

    if (eventBus) {
      try {
        await eventBus.emit("PLANNER_COMPLETED", {
          sessionId,
          nodeCount: getGraphNodeArray(fallbackGraph).length,
          taskGraph: fallbackGraph,
        });
      } catch {}
    }

    return fallbackGraph;
  }
}
