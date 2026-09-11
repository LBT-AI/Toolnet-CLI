/**
 * Phase 75 — Scoped Subagent Contracts
 *
 * A subagent is NOT a second runtime. It is the same Agent Engine running with
 * (a) its own child session, (b) a role system prompt, (c) a scoped tool set and
 * (d) a derived permission scope that can only ever be equal to or narrower
 * than its parent's.
 *
 * Everything in this module is provider-agnostic and dependency-free so the
 * registry, the permission deriver and the UI can all import it without
 * pulling in the harness.
 */

// ── Agent definitions ────────────────────────────────────────────────────────

/**
 * Where an agent may be used:
 *  - primary:  a top-level agent the user talks to directly
 *  - subagent: only invocable via the `task` tool
 *  - all:      both
 */
export type AgentMode = "primary" | "subagent" | "all";

/**
 * Permission verdict for one tool. Ordering is significant: `allow` is the
 * broadest privilege, `deny` the narrowest. Every derivation takes the
 * minimum so a child can never widen access.
 */
export type ToolDecision = "allow" | "ask" | "deny";

/** Privilege rank — higher means more permission. Used by every intersection. */
const DECISION_RANK: Record<ToolDecision, number> = { deny: 0, ask: 1, allow: 2 };

/** Intersection primitive: the *least* privileged of two verdicts wins. */
export function intersectDecision(a: ToolDecision, b: ToolDecision): ToolDecision {
  return DECISION_RANK[a] <= DECISION_RANK[b] ? a : b;
}

export interface ModelRef {
  providerId: string;
  modelId: string;
}

/** Explicit per-tool override declared by an agent definition. */
export interface PermissionRule {
  tool: string;
  decision: ToolDecision;
}

/**
 * The effective permission of one execution scope (a parent turn or one child
 * subagent). Deliberately a plain data shape so it can be persisted, asserted
 * in tests and combined without side effects.
 */
export interface ToolPermissionScope {
  /** Verdict for tools with no explicit rule and no allowlist. */
  defaultDecision: ToolDecision;
  /** Explicit per-tool verdicts. A `deny` here always wins. */
  tools: Record<string, ToolDecision>;
  /**
   * When present, only these tools may be allowed. This is the "scoped tool
   * set" of a role (e.g. explore may not write). Absence means "no allowlist
   * restriction — fall back to defaultDecision".
   */
  allowedTools?: string[];
}

/**
 * Resolve the verdict for one tool from a scope. Fail-closed: deny always wins,
 * and an explicit allowlist excludes anything not on it.
 */
export function decideTool(scope: ToolPermissionScope, toolName: string): ToolDecision {
  const name = String(toolName || "").toLowerCase();

  const explicit = scope.tools?.[name];
  if (explicit === "deny") return "deny";
  if (scope.allowedTools && !scope.allowedTools.includes(name)) return "deny";
  if (explicit === "ask") return "ask";
  if (explicit === "allow") return "allow";
  if (scope.allowedTools) return "allow";
  return scope.defaultDecision;
}

export interface AgentDefinition {
  /** Stable identifier used by `task.subagent_type` and the registry. */
  id: string;
  name: string;
  description: string;

  mode: AgentMode;

  /** Optional model override. Absent means "inherit the parent's model". */
  model?: ModelRef;

  /** Role system prompt. Composed with runtime permission context by the harness. */
  systemPrompt?: string;

  /**
   * Scope allowlist of canonical tool names. When set, the agent may use ONLY
   * these tools. Absent means "derive from the parent scope".
   */
  allowedTools?: string[];

  /** Canonical tool names this agent may never use, regardless of the parent. */
  deniedTools?: string[];

  /** Explicit per-tool verdicts. Intersected with (never above) the parent. */
  permissions?: PermissionRule[];

  /** Maximum agent loop steps for one run of this agent. */
  maxSteps?: number;

  /** True for agents shipped with ToolNet (cannot be replaced by user config). */
  builtIn?: boolean;
}

// ── Child sessions ───────────────────────────────────────────────────────────

export type SubagentStatus = "running" | "completed" | "error" | "cancelled";

/**
 * One subagent run. The transcript is the child's own — it never mutates the
 * parent transcript, and the parent only ever observes the final
 * {@link SubagentResult}. Keeping the child transcript here is what makes
 * `task_id` resume and audit tracing possible.
 */
export interface SubagentSession {
  id: string;
  parentSessionId: string;
  agentId: string;
  status: SubagentStatus;

  createdAt: number;
  completedAt?: number;

  /** Latest prompt handed to this child (first call + every resume). */
  prompt: string;

  /** Child-owned transcript, in the shared AgentMessage shape. */
  messages: ChildMessage[];

  toolCalls: number;
  /** Nesting depth: a direct child of a primary agent is 1. */
  depth: number;
  /** Provider/model actually used — for audit, not for routing. */
  model?: string;
}

/**
 * Transcript shape persisted on a child session. Structurally identical to the
 * harness `ContextMessage` so a resumed child can be handed straight back to
 * the engine — including assistant `tool_calls` and the matching tool replies.
 */
export interface ChildMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
}

// ── Result contract ──────────────────────────────────────────────────────────

/**
 * What the *parent* model receives. Deliberately small: a child's intermediate
 * tokens never leak upward, only this envelope.
 */
export interface SubagentResult {
  taskId: string;
  agent: string;
  status: "completed" | "error" | "cancelled";

  /** One-line outcome for the parent model. */
  summary: string;
  /** Full final child answer, when the child produced one. */
  output?: string;

  toolCalls: number;
  durationMs: number;

  /** Present when status !== "completed". */
  error?: string;
}

// ── Task tool input ──────────────────────────────────────────────────────────

export interface TaskToolInput {
  /** Short label for UI + audit. */
  description?: string;
  /** The instruction for the subagent. */
  prompt: string;
  /** Agent id from the registry, e.g. "explore" | "coder". */
  subagent_type?: string;
  /** Resume an existing child session instead of creating a new one. */
  task_id?: string;
}

// ── Configuration ────────────────────────────────────────────────────────────

/** Default maximum nesting depth for subagents (direct child = 1). */
export const DEFAULT_SUBAGENT_MAX_DEPTH = 1;

/** Default agent used when `task.subagent_type` is omitted. */
export const DEFAULT_SUBAGENT_TYPE = "general";
