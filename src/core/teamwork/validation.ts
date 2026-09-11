/**
 * Phase 76B.2 — DAG Validation
 *
 * A malformed plan must fail BEFORE any node executes. Validation is pure (no
 * registry lookups beyond the passed catalog), so the same rules run in the
 * tool, in tests and in any future planner.
 *
 * Rules: unique ids · dependencies exist · no self-dependency · no cycles ·
 * agent exists and may be a subagent · non-empty prompt · bounded attempts ·
 * bounded timeout · known condition.
 */

import {
  MAX_NODE_ATTEMPTS,
  MAX_NODE_TIMEOUT_MS,
  MAX_PLAN_NODES,
  type TeamCondition,
  type TeamNode,
  type TeamworkPlan,
  type ValidationIssue,
} from "./types";

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VALID_CONDITIONS: TeamCondition[] = ["on_success", "on_failure", "always"];

/** Minimal agent facts validation needs — avoids a hard registry dependency. */
export interface AgentCatalogEntry {
  id: string;
  mode: string;
}

export interface ValidatePlanOptions {
  /** Agents available to the plan. */
  agents: AgentCatalogEntry[];
}

export function validateTeamworkPlan(
  plan: TeamworkPlan | undefined,
  options: ValidatePlanOptions
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!plan || typeof plan !== "object") {
    return [{ message: "Plan is missing or not an object." }];
  }

  if (!Array.isArray(plan.nodes) || plan.nodes.length === 0) {
    return [{ message: "Plan must contain at least one node." }];
  }

  if (plan.nodes.length > MAX_PLAN_NODES) {
    issues.push({ message: `Plan has ${plan.nodes.length} nodes; the maximum is ${MAX_PLAN_NODES}.` });
  }

  const agentById = new Map(options.agents.map((a) => [a.id.toLowerCase(), a]));
  const seen = new Set<string>();

  // ── Per-node shape ─────────────────────────────────────────────────────────
  for (const node of plan.nodes) {
    issues.push(...validateNode(node, agentById));

    const id = String(node?.id ?? "");
    if (id) {
      if (seen.has(id)) issues.push({ nodeId: id, message: `Duplicate node id "${id}".` });
      seen.add(id);
    }
  }

  const ids = new Set(plan.nodes.map((n) => String(n?.id ?? "")));

  // ── Dependency references ──────────────────────────────────────────────────
  for (const node of plan.nodes) {
    for (const dependency of toDependencyList(node)) {
      if (dependency === node.id) {
        issues.push({ nodeId: node.id, message: `Node "${node.id}" cannot depend on itself.` });
        continue;
      }
      if (!ids.has(dependency)) {
        issues.push({
          nodeId: node.id,
          message: `Node "${node.id}" depends on unknown node "${dependency}".`,
        });
      }
    }
  }

  // A cyclic plan is unreachable, so report it once even if nodes are bad.
  const cycle = detectCycle(plan.nodes);
  if (cycle.length > 0) {
    issues.push({ message: `Dependency cycle detected: ${cycle.join(" → ")}.` });
  }

  return issues;
}

function validateNode(node: TeamNode, agentById: Map<string, AgentCatalogEntry>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const id = String(node?.id ?? "");
  const ref = id || "<unnamed>";

  if (!id) {
    issues.push({ nodeId: ref, message: "Node is missing an id." });
  } else if (!NODE_ID_PATTERN.test(id)) {
    issues.push({ nodeId: id, message: `Invalid node id "${id}" — use letters, digits, dot, dash or underscore.` });
  }

  if (!String(node?.prompt ?? "").trim()) {
    issues.push({ nodeId: ref, message: `Node "${ref}" needs a non-empty prompt.` });
  }

  const agentId = String(node?.agent ?? "").trim().toLowerCase();
  if (!agentId) {
    issues.push({ nodeId: ref, message: `Node "${ref}" is missing an agent.` });
  } else {
    const agent = agentById.get(agentId);
    if (!agent) {
      issues.push({ nodeId: ref, message: `Node "${ref}" uses unknown agent "${node.agent}".` });
    } else if (agent.mode !== "subagent" && agent.mode !== "all") {
      issues.push({
        nodeId: ref,
        message: `Node "${ref}" uses agent "${agent.id}", which cannot run as a subagent (mode: ${agent.mode}).`,
      });
    }
  }

  if (!Array.isArray(node?.dependsOn)) {
    issues.push({ nodeId: ref, message: `Node "${ref}" dependsOn must be an array.` });
  }

  const condition = node?.condition;
  if (condition !== undefined && !VALID_CONDITIONS.includes(condition)) {
    issues.push({ nodeId: ref, message: `Node "${ref}" has invalid condition "${String(condition)}".` });
  }

  if (node?.timeoutMs !== undefined) {
    const timeout = Number(node.timeoutMs);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      issues.push({ nodeId: ref, message: `Node "${ref}" timeoutMs must be a positive number.` });
    } else if (timeout > MAX_NODE_TIMEOUT_MS) {
      issues.push({ nodeId: ref, message: `Node "${ref}" timeoutMs exceeds the ${MAX_NODE_TIMEOUT_MS}ms maximum.` });
    }
  }

  if (node?.retry !== undefined) {
    const attempts = Number(node.retry?.maxAttempts);
    if (!Number.isInteger(attempts) || attempts < 1) {
      issues.push({ nodeId: ref, message: `Node "${ref}" retry.maxAttempts must be an integer >= 1.` });
    } else if (attempts > MAX_NODE_ATTEMPTS) {
      issues.push({ nodeId: ref, message: `Node "${ref}" retry.maxAttempts exceeds the ${MAX_NODE_ATTEMPTS} maximum.` });
    }
  }

  return issues;
}

function toDependencyList(node: TeamNode): string[] {
  if (!Array.isArray(node?.dependsOn)) return [];
  return [...new Set(node.dependsOn.map((d) => String(d)).filter(Boolean))];
}

/**
 * Kahn's algorithm. Returns the ids still holding edges when no progress is
 * possible — i.e. the cycle participants (empty when the graph is acyclic).
 */
export function detectCycle(nodes: TeamNode[]): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    indegree.set(node.id, 0);
    dependents.set(node.id, []);
  }

  for (const node of nodes) {
    for (const dependency of toDependencyList(node)) {
      if (!indegree.has(dependency)) continue; // unknown dep reported separately
      indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
      dependents.get(dependency)!.push(node.id);
    }
  }

  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id);
  let processed = 0;

  while (ready.length > 0) {
    const id = ready.shift() as string;
    processed++;
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) ready.push(dependent);
    }
  }

  if (processed === nodes.length) return [];
  return [...indegree.entries()].filter(([, count]) => count > 0).map(([id]) => id);
}
