/**
 * Agent Loop — §1  The single execution loop.
 *
 * Contract (§1 + §15):
 *   Model is the brain. The loop is the body.
 *   Model → Tool calls → Permission → Executor → Verifier → back to Model
 *   Only verified tool results count as truth.
 *
 * All surfaces — TUI (streaming), headless, turbo, subagent, teamwork —
 * ultimately call through this loop. The TUI wraps it with streaming UI;
 * headless calls it directly.
 */

import type { Provider } from "../../providers/types";
import type { ContextMessage } from "../context/types";
import type { ToolExecutionContext } from "../security/types";
import { ModelAdapter, type AgentToolCall } from "./modelAdapter";
import { toolRegistry } from "./toolRegistry";
import { ToolGateway } from "../security/toolGateway";
import { executeToolBatch, signatureForToolCall } from "./toolExecutor";
import { AgentStateMachine } from "./agentState";
import { ContextEngine } from "../context/contextEngine";
import { createWorkspaceContext, type WorkspaceContext } from "./workspace";
import { scanForUnbackedClaim, buildClaimGuardNudge } from "../claimGuard";
import { getSandboxMode } from "../permissions";
import { getLanguageDirective, getResponseLanguage } from "../language";
import { getPermissionContextPrompt } from "../security/permissionContext";
import { getAgentSystemPrompt } from "../agentRuntime";
import { bypassEngine } from "../bypass";

// ── Types ───────────────────────────────────────────────────────────────────

export interface AgentLoopOptions {
  provider: Provider;
  model: string;
  messages: ContextMessage[];
  workspace?: WorkspaceContext;
  sessionId?: string;
  maxTurns?: number;
  signal?: AbortSignal;
  agentRole?: string;
  agentDepth?: number;
  /** TUI streaming callbacks — when absent, non-streaming complete() is used. */
  onContentDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onToolStart?: (call: AgentToolCall) => void;
  onToolResult?: (call: AgentToolCall, result: string) => void;
  onStateChange?: (state: string, prev: string) => void;
}

export interface AgentLoopResult {
  messages: ContextMessage[];
  finalContent: string;
  toolCallsCount: number;
  turnsUsed: number;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("Cancelled");
    (err as Error & { name: string }).name = "AbortError";
    throw err;
  }
}

// ── Loop ────────────────────────────────────────────────────────────────────

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const ws = opts.workspace ?? createWorkspaceContext();
  const sessionId = opts.sessionId ?? `loop-${Date.now()}`;
  const maxTurns = opts.maxTurns ?? 30;
  const signal = opts.signal;
  const state = new AgentStateMachine();
  if (opts.onStateChange) state.onTransition((s, prev) => opts.onStateChange!(s, prev));

  const adapter = new ModelAdapter(opts.provider);
  const contextEngine = new ContextEngine({ sessionId });
  const messages: ContextMessage[] = [...opts.messages];

  assertNotAborted(signal);

  // Ensure a system prompt exists
  if (!messages.some((m) => m.role === "system")) {
    const permCtx = getPermissionContextPrompt(ws.sandboxMode);
    const sysPrompt = getAgentSystemPrompt(sessionId) || `You are ToolNet Agent.\n\n${permCtx}\n\n${getLanguageDirective(getResponseLanguage())}`;
    const full = bypassEngine.getBypassSystemPrompt(sysPrompt);
    messages.unshift({ role: "system", content: full });
  }

  let toolCallsCount = 0;
  let turnsUsed = 0;
  let claimGuardUsed = false;
  const toolCallHistory: string[] = [];

  state.transition("thinking", "loop start");

  while (turnsUsed < maxTurns) {
    assertNotAborted(signal);
    turnsUsed++;

    // Context preparation (compaction/pruning)
    const prep = contextEngine.prepareMessagesForApi(messages, {
      model: opts.model,
      sessionId,
    });
    // Use compacted messages as the provider input
    const apiMessages = prep.messages as ContextMessage[];

    // Provider schemas — single source via registry
    const toolsForRequest = toolRegistry.schemas();
    // Capability guard is inside ModelAdapter

    // ── Model call ────────────────────────────────────────────────────────
    let content = "";
    let toolCalls: AgentToolCall[] = [];
    let reasoningSummary: string | undefined;

    // Prefer streaming when the TUI asked for it; otherwise non-streaming
    const wantStream = Boolean(opts.onContentDelta || opts.onReasoningDelta);

    if (wantStream && typeof opts.provider.stream === "function") {
      let accumulatedReasoning = "";
      const toolDeltas = new Map<number, { id?: string; name?: string; args: string }>();

      for await (const evt of adapter.stream({
        model: opts.model,
        messages: apiMessages as never,
        tools: toolsForRequest as never,
        signal,
      })) {
        assertNotAborted(signal);
        if (evt.contentDelta) {
          content += evt.contentDelta;
          opts.onContentDelta?.(evt.contentDelta);
        }
        if (evt.reasoningDelta) {
          accumulatedReasoning += evt.reasoningDelta;
          opts.onReasoningDelta?.(evt.reasoningDelta);
        }
        if (evt.toolCallDelta) {
          const idx = evt.toolCallDelta.index;
          const cur = toolDeltas.get(idx) ?? { args: "" };
          if (evt.toolCallDelta.id) cur.id = evt.toolCallDelta.id;
          if (evt.toolCallDelta.name) cur.name = evt.toolCallDelta.name;
          if (evt.toolCallDelta.argumentsDelta) cur.args += evt.toolCallDelta.argumentsDelta;
          toolDeltas.set(idx, cur);
        }
      }
      if (accumulatedReasoning) reasoningSummary = accumulatedReasoning;

      // Materialize tool deltas
      for (const [, d] of [...toolDeltas.entries()].sort((a, b) => a[0] - b[0])) {
        if (!d.name) continue;
        let args: unknown = {};
        if (d.args) {
          try { args = JSON.parse(d.args); } catch { args = d.args; }
        }
        toolCalls.push({ id: d.id || `call_${toolCalls.length}`, name: d.name, arguments: args });
      }
    } else {
      const res = await adapter.complete({
        model: opts.model,
        messages: apiMessages as never,
        tools: toolsForRequest as never,
        signal,
      });
      content = res.content;
      toolCalls = res.toolCalls;
      reasoningSummary = res.reasoningSummary;
      // Stream emulation for non-streaming fallback
      if (content && opts.onContentDelta) opts.onContentDelta(content);
      if (reasoningSummary && opts.onReasoningDelta) opts.onReasoningDelta(reasoningSummary);
    }

    // ── No tool calls → final answer (with claim guard) ─────────────────
    if (toolCalls.length === 0) {
      const scan = scanForUnbackedClaim(content);
      if (scan.suspected && !claimGuardUsed) {
        claimGuardUsed = true;
        const nudge = buildClaimGuardNudge(scan.matchedPhrase || "file created", ws.root);
        messages.push({ role: "assistant", content });
        messages.push({ role: "user", content: nudge });
        // Stay in thinking — give the model one retry
        continue;
      }

      // Emit final assistant message
      messages.push({ role: "assistant", content });
      try { state.transition("responding", "final answer"); } catch {}
      try { state.transition("idle", "done"); } catch {}
      return { messages, finalContent: content, toolCallsCount, turnsUsed };
    }

    // ── Tool calls → Permission → Executor → Verifier ────────────────────
    try { state.transition("executing-tool", `${toolCalls.length} tool call(s)`); } catch {}

    // Record assistant tool_calls message
    messages.push({
      role: "assistant",
      content: content || "",
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    });

    // Infinite-loop guard (cross-turn)
    let loopAborted = false;

    const parsedCalls = toolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.arguments as Record<string, unknown> }));

    const outcome = await executeToolBatch(
      parsedCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      {
        cwd: ws.cwd,
        needsApproval: () => false, // Approval is handled inside runTool via ToolGateway
        maxRepeat: 0,
        signal,
        runTool: async (name, args, id) => {
          // Per-call loop detection
          const sig = signatureForToolCall(name, args);
          if (toolCallHistory.filter((s) => s === sig).length >= 2) {
            loopAborted = true;
            return {
              result: JSON.stringify({ stdout: "", stderr: `Infinite loop detected: tool '${name}' repeated 3 times with identical arguments.`, exitCode: 1 }),
              allowed: false,
              reason: "loop",
            };
          }
          toolCallHistory.push(sig);

          opts.onToolStart?.({ id, name, arguments: args });

          const ctx: ToolExecutionContext = {
            cwd: ws.cwd,
            workspaceRoot: ws.root,
            sandboxMode: ws.sandboxMode ?? getSandboxMode(),
            sessionId,
            agentRole: opts.agentRole,
            agentDepth: opts.agentDepth ?? 0,
            signal,
            source: opts.agentDepth !== undefined && opts.agentDepth > 0 ? "subagent" : "headless",
          };

          // Single gate: ToolGateway (Permission → Executor → Verifier internally)
          // ToolRegistry verify hooks are invoked inside ToolGateway's executor path
          // via the toolRegistry entry (see toolGateway wiring).
          const gw = await ToolGateway.execute({ name, args, id }, ctx);

          if (!gw.allowed) {
            const payload = JSON.stringify({
              stdout: "",
              stderr: gw.stderr || gw.reason || "Permission denied",
              exitCode: gw.exitCode ?? 1,
              ...(gw.needsApproval ? { needsApproval: true } : {}),
            });
            opts.onToolResult?.({ id, name, arguments: args }, payload);
            return { result: payload, allowed: false as const, reason: gw.reason };
          }

          // Verifier hook (registry-level) — ToolGateway already ran the codingAgent
          // postconditions; this is an additional registry verify if present.
          const regEntry = toolRegistry.get(name);
          if (regEntry?.verify) {
            try {
              const v = await regEntry.verify(args as never, gw.stdout, ctx);
              if (!v.ok) {
                const payload = JSON.stringify({ stdout: "", stderr: v.error || "Verification failed", exitCode: 1 });
                opts.onToolResult?.({ id, name, arguments: args }, payload);
                return { result: payload, allowed: false as const, reason: v.error };
              }
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              const payload = JSON.stringify({ stdout: "", stderr: `Verifier error: ${msg}`, exitCode: 1 });
              opts.onToolResult?.({ id, name, arguments: args }, payload);
              return { result: payload, allowed: false as const, reason: msg };
            }
          }

          // Context bookkeeping — track file access
          if ((args as Record<string, unknown>)?.path) {
            const p = String((args as Record<string, unknown>).path);
            const isWrite = name === "write_file" || name === "edit_file" || name === "replace_all" || name === "apply_patch" || name === "create_artifact" || name === "update_artifact";
            contextEngine.recordFileAccess(p, isWrite ? "write" : "read", sessionId);
          }

          opts.onToolResult?.({ id, name, arguments: args }, gw.stdout);
          return { result: gw.stdout, allowed: true as const };
        },
        onMessage: (m) => {
          messages.push({ role: "tool", tool_call_id: m.id, name: m.name, content: m.content });
          toolCallsCount++;
        },
      }
    );

    if (loopAborted) {
      messages.push({ role: "assistant", content: "Aborted: infinite tool-call loop detected." });
      try { state.transition("error", "loop detected"); } catch {}
      return { messages, finalContent: "Aborted: infinite tool-call loop detected.", toolCallsCount, turnsUsed };
    }

    void outcome;

    // Loop: back to model with tool results
    try { state.transition("thinking", "tool results appended"); } catch {}
  }

  // Max turns exceeded
  messages.push({ role: "assistant", content: `Exceeded maximum turn count (${maxTurns}).` });
  try { state.transition("error", "max turns"); } catch {}
  return { messages, finalContent: messages[messages.length - 1]?.content || "", toolCallsCount, turnsUsed: maxTurns };
}
