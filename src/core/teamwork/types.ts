/**
 * Phase 76B.1 — Teamwork DAG Contracts
 *
 * A plan is DATA, not a runtime. Every node is executed as a BackgroundJob
 * whose work is a normal scoped subagent run on the shared Agent Engine, so a
 * DAG cannot introduce a second execution path.
 */

export type TeamCondition = "on_success" | "on_failure" | "always";

export interface RetryPolicy {
  /** Total attempts, including the first. Bounded by MAX_NODE_ATTEMPTS. */
  maxAttempts: number;
}

export interface TeamNode {
  id: string;
  title: string;

  /** AgentRegistry id — must be a subagent-capable agent. */
  agent: string;
  prompt: string;

  dependsOn: string[];

  /** When this node runs relative to its dependencies. Default `on_success`. */
  condition?: TeamCondition;

  timeoutMs?: number;

  retry?: RetryPolicy;
}

export interface TeamworkPlan {
  id: string;
  nodes: TeamNode[];
}

export type TeamNodeStatus = "completed" | "error" | "cancelled" | "skipped";

/**
 * What a dependent node receives. Deliberately compact: a node never inherits
 * another node's transcript, only its declared result.
 */
export interface TeamNodeResult {
  nodeId: string;
  agent: string;
  status: TeamNodeStatus;

  summary: string;
  output?: string;

  childSessionId?: string;
  jobId?: string;
  durationMs: number;
  attempts: number;

  error?: string;
  errorKind?: string;
}

export type TeamworkStatus = "completed" | "error" | "cancelled";

export interface TeamworkResult {
  id: string;
  status: TeamworkStatus;
  nodes: Record<string, TeamNodeResult>;
  durationMs: number;
  /** Set when the plan never executed (validation failure). */
  error?: string;
  issues?: ValidationIssue[];
}

export interface ValidationIssue {
  nodeId?: string;
  message: string;
}

// ── Bounds ───────────────────────────────────────────────────────────────────

/** Maximum attempts for one node, including the first. */
export const MAX_NODE_ATTEMPTS = 5;

/** Maximum per-node timeout (30 minutes). */
export const MAX_NODE_TIMEOUT_MS = 30 * 60 * 1000;

/** Maximum nodes in one plan — keeps a runaway planner bounded. */
export const MAX_PLAN_NODES = 32;

/** How much of a dependency's output is forwarded downstream. */
export const MAX_DEPENDENCY_OUTPUT_CHARS = 4_000;
