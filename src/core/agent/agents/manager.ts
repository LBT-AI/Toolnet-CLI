/**
 * Phase 75.1 / 75.6 / 75.10 / 75.11 — Subagent Manager
 *
 * The ONLY way a subagent is created. It owns the lifecycle around a child run
 * — depth guard, child session, scoped tool set, derived permission, result
 * normalisation — and delegates the actual work to the shared Agent Engine.
 *
 * What it deliberately does NOT do:
 *   - call a provider                (the engine + model adapter own that)
 *   - hold a tool executor           (the canonical ToolRegistry owns that)
 *   - invent a second agent loop     (AgentHarness.executeLoop is the loop)
 *   - widen permission               (derivation can only narrow)
 */

import type { ContextMessage } from "../../../lib/context/types";
import type { SandboxMode } from "../../../lib/security/types";
import type { ExecutionOptions } from "../../../lib/harness/types";
import { toolRegistry } from "../../../lib/harness/toolRegistry";
import type { AgentEngineRunOptions } from "../agentEngine";
import type { AgentResult } from "../../contracts";
import { agentRegistry, type AgentRegistry } from "./registry";
import { composeAgentPrompt } from "./prompt";
import { assertNoEscalation, deriveSubagentPermission } from "./permissions";
import { subagentSessions, type SubagentSessionStore } from "./sessions";
import {
  DEFAULT_SUBAGENT_MAX_DEPTH,
  decideTool,
  type AgentDefinition,
  type SubagentResult,
  type SubagentSession,
  type ToolPermissionScope,
} from "./types";

/** Minimal engine surface the manager depends on — injectable for tests. */
export interface EngineLike {
  run(options: AgentEngineRunOptions): Promise<AgentResult>;
}

export interface SubagentRunRequest {
  /** Registry id of the agent to run. Unknown ids fall back to `general`. */
  agentId?: string;
  /** Short label for UI / audit (optional). */
  description?: string;
  /** The instruction for the child. */
  prompt: string;

  parentSessionId: string;
  /** Effective permission of the SPAWNING turn. */
  parentPermission: ToolPermissionScope;
  /** Depth of the sponsoring turn: a primary agent is 0. */
  parentDepth: number;
  /** Maximum child depth. Defaults to 1 (no grandchildren). */
  maxDepth?: number;

  cwd?: string;
  workspaceRoot?: string;
  sandboxMode?: SandboxMode;
  model?: string;
  signal?: AbortSignal;

  /** Resume an existing child session instead of creating a new one. */
  taskId?: string;
  /**
   * Explicit id for a NEW child session. Used by background jobs, which must
   * know the child session id before the run starts so job and session can be
   * correlated from the first event.
   */
  sessionId?: string;

  requestApproval?: ExecutionOptions["requestApproval"];
  /** Progress callback (audit/UI). Never used for control flow. */
  onEvent?: (event: string, data: Record<string, unknown>) => void;
}

export interface SubagentManagerDeps {
  registry?: AgentRegistry;
  sessions?: SubagentSessionStore;
  engine?: EngineLike;
}

export class SubagentManager {
  private readonly registry: AgentRegistry;
  private readonly sessions: SubagentSessionStore;
  private readonly injectedEngine?: EngineLike;

  constructor(deps: SubagentManagerDeps = {}) {
    this.registry = deps.registry ?? agentRegistry;
    this.sessions = deps.sessions ?? subagentSessions;
    this.injectedEngine = deps.engine;
  }

  /** Resolve the engine lazily so importing the manager stays cheap. */
  private async engine(): Promise<EngineLike> {
    if (this.injectedEngine) return this.injectedEngine;
    const mod = await import("../agentEngine");
    return mod.agentEngine;
  }

  /**
   * Run one subagent to completion and return its result envelope.
   * Never throws for expected failures — permission and depth problems are
   * returned as typed, non-successful results the parent model must respect.
   */
  async run(request: SubagentRunRequest): Promise<SubagentResult> {
    const startedAt = Date.now();
    const agent = this.registry.resolve(request.agentId);
    const maxDepth = request.maxDepth ?? DEFAULT_SUBAGENT_MAX_DEPTH;
    const childDepth = request.parentDepth + 1;

    // ── Depth guard (§75.11): no unbounded recursion. ──────────────────────
    if (childDepth > maxDepth) {
      return this.errorResult(
        request.taskId || "(not-created)",
        agent.id,
        `Subagent recursion limit reached: depth ${childDepth} exceeds max depth ${maxDepth}. Complete this task with your own tools.`,
        startedAt
      );
    }

    const { session, agent: effectiveAgent } = this.openSession(request, agent, childDepth);
    const childScope = deriveSubagentPermission({
      parentPermission: request.parentPermission,
      agentDefinition: effectiveAgent,
    });

    // Defence in depth: derivation promises no escalation, so verify it here.
    const escalation = assertNoEscalation(
      request.parentPermission,
      childScope,
      toolRegistry.canonicalNames()
    );
    if (!escalation.ok) {
      this.sessions.finish(session.id, "error");
      return this.errorResult(
        session.id,
        agent.id,
        `Refused to spawn subagent: derived permission for "${escalation.tool}" would escalate (parent=${escalation.parent}, child=${escalation.child}).`,
        startedAt
      );
    }

    const canSpawnSubagents = childDepth < maxDepth && decideTool(childScope, "task") !== "deny";
    const grantedTools = toolRegistry
      .canonicalNames()
      .filter((name) => decideTool(childScope, name) !== "deny")
      .filter((name) => (name === "task" ? canSpawnSubagents : true));

    const scopedSchemas = toolRegistry.schemasFiltered((t) => grantedTools.includes(t.name));
    const systemPrompt = composeAgentPrompt({
      agent: effectiveAgent,
      grantedTools,
      workspaceRoot: request.workspaceRoot,
      canSpawnSubagents,
    });

    request.onEvent?.("subagent:start", {
      taskId: session.id,
      agent: effectiveAgent.id,
      depth: childDepth,
      tools: grantedTools,
    });

    const result = await this.invokeEngine({
      request,
      agent: effectiveAgent,
      session,
      childDepth,
      childScope,
      scopedSchemas,
      systemPrompt,
    });

    return this.finalize({
      request,
      agent: effectiveAgent,
      session,
      result,
      childDepth,
      startedAt,
    });
  }

  /**
   * Create a fresh child session, or resume the one named by `task_id`.
   *
   * A resumed session keeps BOTH its transcript and its original agent: the
   * agent id is pinned to the definition the session was created with, so a
   * later call cannot re-point an existing child at a broader role.
   */
  private openSession(
    request: SubagentRunRequest,
    agent: AgentDefinition,
    childDepth: number
  ): { session: SubagentSession; agent: AgentDefinition } {
    const existing = request.taskId ? this.sessions.get(request.taskId) : undefined;

    if (existing) {
      const pinned = this.registry.get(existing.agentId) ?? agent;
      const resumed = this.sessions.resume(existing.id, request.prompt);
      if (resumed) return { session: resumed, agent: pinned };
    }

    // An unknown `task_id` is not an error — it starts a new child, so a stale
    // id degrades into a fresh attempt instead of failing the parent turn.
    const createInput = {
      parentSessionId: request.parentSessionId,
      agentId: agent.id,
      prompt: request.prompt,
      depth: childDepth,
      ...(request.model ? { model: request.model } : {}),
    };

    const session = request.sessionId
      ? this.sessions.createWithId(request.sessionId, createInput)
      : this.sessions.create(createInput);
    return { session, agent };
  }

  /**
   * Reserve a child session id for a run that has not started yet.
   * Kept on the manager so id allocation stays in one place.
   */
  allocateSessionId(parentSessionId: string, agentId?: string): string {
    const agent = this.registry.resolve(agentId);
    return this.sessions.allocateId(parentSessionId, agent.id);
  }

  /**
   * Canonical id for a requested agent. Unknown ids fall back to `general`, so
   * callers (and jobs) always record the agent that will actually run.
   */
  resolveAgentId(agentId?: string): string {
    return this.registry.resolve(agentId).id;
  }

  /**
   * The child session id a request WILL use: the resumed session when
   * `taskId` names a live session, otherwise a freshly reserved id.
   *
   * Background jobs need this before the run starts so the job can be linked to
   * the right session from its first event.
   */
  resolveSessionId(request: {
    parentSessionId: string;
    agentId?: string;
    taskId?: string;
  }): string {
    const existing = request.taskId ? this.sessions.get(request.taskId) : undefined;
    if (existing) return existing.id;
    return this.allocateSessionId(request.parentSessionId, request.agentId);
  }

  /** Run the child on the shared engine, with its transcript when resuming. */
  private async invokeEngine(input: {
    request: SubagentRunRequest;
    agent: AgentDefinition;
    session: SubagentSession;
    childDepth: number;
    childScope: ToolPermissionScope;
    scopedSchemas: ReturnType<typeof toolRegistry.schemasFiltered>;
    systemPrompt: string;
  }): Promise<AgentResult> {
    const { request, agent, session, childDepth, childScope, scopedSchemas } = input;
    const engine = await this.engine();

    const base: AgentEngineRunOptions = {
      prompt: request.prompt,
      mode: "subagent",
      sessionId: session.id,
      model: request.model ?? (agent.model ? `${agent.model.providerId}/${agent.model.modelId}` : undefined),
      cwd: request.cwd,
      workspaceRoot: request.workspaceRoot,
      sandboxMode: request.sandboxMode,
      maxTurns: agent.maxSteps,
      systemPrompt: input.systemPrompt,
      toolsOverride: scopedSchemas,
      toolPermissionSet: childScope,
      agentRole: agent.id,
      agentDepth: childDepth,
      signal: request.signal,
      requestApproval: request.requestApproval,
    };

    try {
      // A session with prior turns resumes from its stored transcript; the
      // engine rebuilds the system prompt so the child keeps its current role
      // contract and live permission context.
      return await engine.run(
        session.messages.length > 1
          ? { ...base, messages: session.messages as ContextMessage[], prependSystemPrompt: true }
          : base
      );
    } catch (err: any) {
      return {
        success: false,
        output: "",
        evidence: {
          successfulMutations: 0,
          successfulExecutions: 0,
          verificationsPassed: 0,
          testsPassed: 0,
        },
        error: err?.message || String(err),
      };
    }
  }

  /** Persist the child transcript, then project the result for the parent. */
  private finalize(input: {
    request: SubagentRunRequest;
    agent: AgentDefinition;
    session: SubagentSession;
    result: AgentResult;
    childDepth: number;
    startedAt: number;
  }): SubagentResult {
    const { request, agent, session, result, startedAt } = input;

    const transcript = (result.messages ?? []) as ContextMessage[];
    this.sessions.replaceMessages(session.id, transcript);

    const cancelled = Boolean(request.signal?.aborted);
    const status: SubagentResult["status"] = cancelled
      ? "cancelled"
      : result.success
        ? "completed"
        : "error";

    const toolCalls = result.toolCalls ?? countToolCalls(transcript);
    this.sessions.recordToolCall(session.id, toolCalls);
    this.sessions.finish(session.id, status);

    const output = (result.output || "").trim();
    const error = result.error || (status === "completed" ? undefined : "Subagent did not complete the task.");

    const envelope: SubagentResult = {
      taskId: session.id,
      agent: agent.id,
      status,
      summary: summarize(status, output, error, agent.id),
      ...(output ? { output } : {}),
      toolCalls,
      durationMs: Date.now() - startedAt,
      ...(error ? { error } : {}),
    };

    request.onEvent?.("subagent:complete", {
      taskId: session.id,
      agent: agent.id,
      depth: input.childDepth,
      status,
      toolCalls,
    });

    return envelope;
  }

  private errorResult(
    taskId: string,
    agentId: string,
    message: string,
    startedAt: number
  ): SubagentResult {
    return {
      taskId,
      agent: agentId,
      status: "error",
      summary: message,
      toolCalls: 0,
      durationMs: Date.now() - startedAt,
      error: message,
    };
  }
}

/** Count tool results in a transcript — the honest measure of child activity. */
function countToolCalls(messages: ContextMessage[]): number {
  return messages.filter((m) => m.role === "tool").length;
}

/** One-line parent-facing outcome. */
function summarize(
  status: SubagentResult["status"],
  output: string,
  error: string | undefined,
  agentId: string
): string {
  if (status === "cancelled") return `Subagent "${agentId}" was cancelled.`;
  if (status === "error") return error || `Subagent "${agentId}" failed.`;

  const firstLine = output.split("\n").find((line) => line.trim())?.trim() ?? "";
  if (!firstLine) return `Subagent "${agentId}" completed without a written summary.`;
  return firstLine.length > 240 ? `${firstLine.slice(0, 237)}...` : firstLine;
}

/** Process-wide manager. Tests construct isolated instances instead. */
export const subagentManager = new SubagentManager();
