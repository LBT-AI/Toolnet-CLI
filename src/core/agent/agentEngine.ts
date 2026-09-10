/**
 * Phase 73.5 — Shared Agent Engine
 *
 * THE single entry point every interface calls:
 *
 *   TUI         → agentEngine.run() → subscribe events → render
 *   Simple REPL  → agentEngine.run() → print events/result
 *   Headless     → agentEngine.run() → JSON output
 *   Subagent     → agentEngine.run({ agentRole, toolsOverride })
 *
 * This is deliberately a thin orchestration facade. It owns NOTHING about the
 * loop itself — AgentHarness.executeLoop is still the one execution path. The
 * engine's job is to (a) build the harness from run options, (b) translate
 * provider-agnostic harness events into the unified AgentEvent contract, and
 * (c) return a typed AgentResult carrying verified evidence.
 *
 * Keeping the loop in one place is what stops the "chatbot with tools" drift:
 * adding a new front-end means subscribing to events, never reimplementing
 * model streaming, tool routing, permission, or verification.
 */

import { AgentHarness } from "../../lib/harness";
import type { ExecutionMode, HarnessEvent, HarnessResult } from "../../lib/harness/types";
import type { SandboxMode } from "../../lib/security/types";
import type { AgentEvent, AgentResult, ToolResult } from "../contracts";

export type AgentEngineMode =
  | "interactive"
  | "headless"
  | "turbo"
  | "subagent"
  | "teamwork";

export interface AgentEngineRunOptions {
  prompt: string;

  sessionId?: string;
  model?: string;
  /** Working directory the agent operates in (and resolves relative paths against). */
  cwd?: string;
  /** Workspace root — mutations must not escape it unless policy allows. */
  workspaceRoot?: string;
  sandboxMode?: SandboxMode;

  mode?: AgentEngineMode;
  maxTurns?: number;
  timeoutMs?: number;
  systemPrompt?: string;
  signal?: AbortSignal;

  /** Subagent role, used when mode === "subagent". */
  agentRole?: string;
  /** Restrict the tool set (subagents, scoped tasks). */
  toolsOverride?: unknown[];

  /** Streaming assistant text deltas, for terminal renderers. */
  onTextDelta?: (text: string) => void;
  /** Normalized event stream — the contract every UI consumes. */
  onEvent?: (event: AgentEvent) => void;
}

const MODE_MAP: Record<AgentEngineMode, ExecutionMode> = {
  interactive: "INTERACTIVE",
  headless: "HEADLESS",
  turbo: "TURBO",
  subagent: "SUBAGENT",
  teamwork: "TEAMWORK",
};

/**
 * Translate one provider-agnostic harness event into zero or more contract
 * events. Guard clauses keep unknown/partial payloads inert instead of throwing
 * mid-stream.
 */
export function toAgentEvents(ev: HarnessEvent): AgentEvent[] {
  const payload = ev.payload ?? {};

  switch (ev.type) {
    case "agent:start":
      return [{ type: "agent-start", sessionId: ev.sessionId }];

    case "agent:thinking":
      return [{ type: "thinking-start" }];

    case "agent:stream_chunk": {
      const text = typeof payload.text === "string" ? payload.text : "";
      if (!text) return [];
      return [{ type: "text-delta", text }];
    }

    case "tool:queued": {
      const callId = String(payload.id ?? payload.toolName ?? "unknown");
      return [{ type: "tool-call", callId, name: String(payload.toolName ?? "unknown"), input: payload.toolArgs ?? {} }];
    }

    case "tool:start":
      return [{ type: "tool-running", callId: String(payload.id ?? payload.toolName ?? "unknown") }];

    case "tool:complete":
      return [{
        type: "tool-result",
        callId: String(payload.id ?? payload.toolName ?? "unknown"),
        result: toToolResult(payload.result),
      }];

    case "tool:error":
      return [{
        type: "tool-error",
        callId: String(payload.id ?? payload.toolName ?? "unknown"),
        error: payload.reason || payload.error || "Tool execution failed",
      }];

    case "agent:complete":
      return [{ type: "agent-complete" }];

    case "agent:error":
      return [{ type: "error", error: String(payload.error ?? "Unknown agent error") }];

    default:
      return [];
  }
}

/**
 * Normalize the many shapes a tool result can take (JSON string from the
 * executor, an object, or plain text) into the canonical ToolResult.
 */
export function toToolResult(raw: unknown): ToolResult {
  if (raw === null || raw === undefined) return { ok: true };

  if (typeof raw === "string") {
    try {
      return toToolResult(JSON.parse(raw));
    } catch {
      return { ok: true, stdout: raw };
    }
  }

  if (typeof raw !== "object") return { ok: true, stdout: String(raw) };

  const r = raw as Record<string, unknown>;
  const exitCode = typeof r.exitCode === "number" ? r.exitCode : undefined;
  return {
    ok: typeof r.ok === "boolean" ? r.ok : r.success !== false && (exitCode === undefined || exitCode === 0),
    stdout: typeof r.stdout === "string" ? r.stdout : undefined,
    stderr: typeof r.stderr === "string" ? r.stderr : undefined,
    exitCode,
    data: r.data,
    truncated: typeof r.truncated === "boolean" ? r.truncated : undefined,
    outputPath: typeof r.outputPath === "string" ? r.outputPath : undefined,
    metadata: (r.metadata as Record<string, unknown> | undefined) ?? undefined,
  };
}

export class AgentEngine {
  /**
   * Run one agent turn to completion. Every front-end uses this.
   */
  async run(options: AgentEngineRunOptions): Promise<AgentResult> {
    const mode = MODE_MAP[options.mode ?? "headless"];

    const harness = new AgentHarness({
      workspaceRoot: options.workspaceRoot,
      currentCwd: options.cwd,
      sessionId: options.sessionId,
      model: options.model,
      sandboxMode: options.sandboxMode,
      maxTurns: options.maxTurns,
      timeoutMs: options.timeoutMs,
    });

    const emit = (event: AgentEvent) => options.onEvent?.(event);

    if (options.onTextDelta) {
      harness.on((ev) => {
        if (ev.type !== "agent:stream_chunk") return;
        const text = typeof ev.payload?.text === "string" ? ev.payload.text : "";
        if (text) options.onTextDelta!(text);
      });
    }

    if (options.onEvent) {
      harness.on((ev) => {
        for (const event of toAgentEvents(ev)) emit(event);
      });
    }

    if (options.signal?.aborted) {
      emit({ type: "cancelled" });
      return { success: false, output: "", evidence: harness.getCompletionEvidence(), error: "Execution cancelled by user" };
    }

    const result = await this.invoke(harness, options, mode);

    if (options.signal?.aborted) {
      emit({ type: "cancelled" });
    }

    return {
      success: result.success,
      output: result.output,
      evidence: result.evidence ?? harness.getCompletionEvidence(),
      sessionId: result.sessionId,
      turnsUsed: result.turnsUsed,
      tokensUsed: result.tokensUsed,
      durationMs: result.durationMs,
      error: result.error,
    };
  }

  /**
   * Dispatch to the harness entry that matches the requested mode. Guard
   * clauses keep each branch small and explicit.
   */
  private async invoke(
    harness: AgentHarness,
    options: AgentEngineRunOptions,
    mode: ExecutionMode
  ): Promise<HarnessResult> {
    const base = {
      model: options.model,
      maxTurns: options.maxTurns,
      timeoutMs: options.timeoutMs,
      systemPrompt: options.systemPrompt,
      signal: options.signal,
      mode,
      agentRole: options.agentRole,
    };

    if (mode === "SUBAGENT" && options.agentRole) {
      return harness.runSubagent(
        options.agentRole as Parameters<AgentHarness["runSubagent"]>[0],
        options.prompt,
        { ...base, toolsOverride: options.toolsOverride }
      );
    }

    return harness.execute({ ...base, prompt: options.prompt, toolsOverride: options.toolsOverride });
  }
}

/** Shared engine instance — import this, do not construct your own. */
export const agentEngine = new AgentEngine();
