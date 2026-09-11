/**
 * Phase 75.4 — Subagent Permission Derivation
 *
 * The security invariant of the whole subagent feature:
 *
 *     child permission ⊆ parent permission
 *
 * A subagent is spawned by a model, and models can be talked into requesting
 * broader access. The runtime therefore never trusts the requested scope: it
 * intersects it with both the agent definition and — decisively — the parent
 * scope. Parent `deny` always wins, so a read-only parent (e.g. plan mode)
 * cannot launder a write through a `coder` child.
 *
 * Reference behaviour: OpenCode's `agent/subagent-permissions.ts`.
 */

import type { SandboxMode } from "../../../lib/security/types";
import {
  decideTool,
  intersectDecision,
  type AgentDefinition,
  type ToolDecision,
  type ToolPermissionScope,
} from "./types";

/** Tools that mutate the filesystem. Used for the sandbox-mode bridge. */
const MUTATION_TOOLS = new Set([
  "write_file",
  "edit_file",
  "replace_all",
  "apply_patch",
  "create_artifact",
  "update_artifact",
]);

/** Tools that execute arbitrary processes. */
const EXECUTION_TOOLS = new Set(["shell", "bash", "run_command", "spawn_subagent", "task"]);

/** Tools that reach the network. */
const NETWORK_TOOLS = new Set(["web_fetch", "audit_url", "browser", "mcp"]);

/**
 * Build the permission scope implied by a runtime sandbox mode. This is the
 * parent-side baseline: the SecurityEngine still performs the authoritative
 * per-call evaluation, but subagent derivation needs a declarative view of the
 * same policy in order to intersect it.
 *
 * `workspace`  → read/create/modify/execute inside the workspace, network asks
 * `ask`        → same, but everything path-sensitive requires approval
 * `full-access`→ unrestricted
 */
export function permissionScopeFromSandbox(mode: SandboxMode): ToolPermissionScope {
  if (mode === "full-access") {
    return { defaultDecision: "allow", tools: {} };
  }

  const tools: Record<string, ToolDecision> = {};
  for (const name of NETWORK_TOOLS) tools[name] = "ask";

  if (mode === "ask") {
    // In ask mode every side-effecting tool surfaces an approval prompt.
    for (const name of MUTATION_TOOLS) tools[name] = "ask";
    for (const name of EXECUTION_TOOLS) tools[name] = "ask";
  }

  return { defaultDecision: "allow", tools };
}

/**
 * Convert an agent definition's declared scope into a permission scope.
 * The definition expresses scope two ways — a coarse allowlist plus explicit
 * verdicts — and both must apply.
 */
export function permissionScopeFromAgent(agent: AgentDefinition): ToolPermissionScope {
  const tools: Record<string, ToolDecision> = {};

  for (const name of agent.deniedTools || []) {
    tools[String(name).toLowerCase()] = "deny";
  }
  for (const rule of agent.permissions || []) {
    const existing = tools[String(rule.tool).toLowerCase()];
    tools[String(rule.tool).toLowerCase()] = existing === "deny" ? "deny" : rule.decision;
  }

  return {
    defaultDecision: "allow",
    tools,
    ...(agent.allowedTools ? { allowedTools: agent.allowedTools.map((t) => t.toLowerCase()) } : {}),
  };
}

export interface DeriveSubagentPermissionInput {
  /** Effective permission of the spawning turn. */
  parentPermission: ToolPermissionScope;
  /** The agent being spawned. */
  agentDefinition: AgentDefinition;
  /**
   * Tools the parent explicitly asked to grant, if any. Narrowing only — a
   * request here can never widen the result beyond parent ∩ agent.
   */
  requestedTools?: string[] | null;
}

/**
 * Derive the child scope as the intersection of parent constraints, agent
 * constraints and the requested scope.
 *
 * Intersection is expressed per tool: the least privileged verdict among the
 * three participants wins. Requested tools that are not on the agent allowlist
 * are dropped by the agent scope itself, and anything the parent denies stays
 * denied no matter what the agent or the request says.
 */
export function deriveSubagentPermission(
  input: DeriveSubagentPermissionInput
): ToolPermissionScope {
  const { parentPermission, agentDefinition } = input;

  const agentScope = permissionScopeFromAgent(agentDefinition);
  const requested = normalizeRequestedTools(input.requestedTools);

  // Universe of tools that carry an explicit verdict in any participant. Tools
  // absent from all three keep the parent's default (they were never scoped).
  const tools: Record<string, ToolDecision> = {};
  const names = new Set<string>([
    ...Object.keys(parentPermission.tools || {}),
    ...Object.keys(agentScope.tools || {}),
    ...(requested || []),
  ]);

  for (const name of names) {
    const parentVerdict = decideTool(parentPermission, name);
    const agentVerdict = decideTool(agentScope, name);
    tools[name] = intersectDecision(parentVerdict, agentVerdict);
  }

  // Allowlists must survive the intersection. Without this, a tool that is in
  // NEITHER scope's explicit rules would silently fall back to the parent's
  // default and escape the agent's allowlist (e.g. a read-only `explore` child
  // reaching `create_artifact`). Intersecting the lists keeps the narrowest.
  const listed = intersectAllowlists(
    intersectAllowlists(agentScope.allowedTools, parentPermission.allowedTools),
    requested ?? undefined
  );

  // A listed tool still must not be one the parent denies — an allowlist can
  // narrow a default, never override an explicit parent "deny".
  const allowedTools = listed?.filter((name) => decideTool(parentPermission, name) !== "deny");

  return {
    defaultDecision: parentPermission.defaultDecision,
    tools,
    ...(allowedTools ? { allowedTools } : {}),
  };
}

/**
 * Intersect two optional allowlists. `undefined` means "no allowlist".
 * The result is the narrowest list; an empty intersection means no tool is
 * permitted through the allowlist at all (a caller would then see only tools
 * granted by explicit rules).
 */
function intersectAllowlists(
  a: string[] | undefined,
  b: string[] | undefined
): string[] | undefined {
  if (!a) return b ? [...b] : undefined;
  if (!b) return [...a];
  return a.filter((name) => b.includes(name));
}

/** Lowercase + de-duplicate a requested tool list; `null`/`undefined` = no request. */
function normalizeRequestedTools(requested: string[] | null | undefined): string[] | null {
  if (!requested) return null;
  const unique = new Set(requested.map((t) => String(t).toLowerCase()).filter(Boolean));
  return unique.size > 0 ? [...unique] : null;
}

/**
 * Verify the invariant directly. Tests and the manager both use this so a
 * regression fails loudly instead of silently granting a child more access.
 */
export function assertNoEscalation(
  parent: ToolPermissionScope,
  child: ToolPermissionScope,
  toolNames: string[]
): { ok: true } | { ok: false; tool: string; parent: ToolDecision; child: ToolDecision } {
  for (const name of toolNames) {
    const parentVerdict = decideTool(parent, name);
    const childVerdict = decideTool(child, name);
    if (intersectDecision(parentVerdict, childVerdict) !== childVerdict) {
      return { ok: false, tool: name, parent: parentVerdict, child: childVerdict };
    }
  }
  return { ok: true };
}
