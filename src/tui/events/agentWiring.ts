import * as fs from "node:fs";
import * as path from "node:path";
import { tuiState } from "../state";
import { getCwdInfo } from "../../lib/codingAgent";
import { getVersion } from "../../lib/version";
import { contextEngine, type ContextMessage } from "../../lib/context";
import { makeCheckpointSummarizer } from "../../lib/harness/checkpointSummarizer";
import { parseAndProcessInput } from "../../lib/attachments";
import { getAgentSystemPrompt } from "../../lib/agentRuntime";
import { extractLanguageRequest, setResponseLanguage } from "../../lib/language";
import { supportsReasoning } from "../../lib/reasoning";
import { securityEngine } from "../../lib/security/securityEngine";
import { toolRegistry } from "../../lib/harness/toolRegistry";
import { agentEngine } from "../../core/agent/agentEngine";
import type { AgentEvent } from "../../core/contracts";
import { requestApprovalModal, requestConfirmation } from "../permissions/permissionModal";
import { dispatchCommand } from "../../commands";
import { loadSession, formatExitMessage, sessionDisplayTitle } from "../../lib/sessionPersistence";
import { A } from "../../term";
import { updateCrashToolResult, markCleanExit } from "../../lib/crashRecovery";
import { restoreTerminal } from "../../lib/terminalLifecycle";
import { pinToTail } from "../viewport";
import { pendingInputs } from "../../core/agent/pendingInput";
import { readPendingInputs } from "../../core/session/pendingInputJournal";
import { getActiveProvider, getActiveDefaultModel } from "../../providers";
import { statusManager } from "../statusService";
import { messageQueue } from "../../lib/messageQueue";
import { providerPicker } from "../providerPicker";
import { assertPrimarySystemMessageInvariant } from "../../lib/context";
import { getToolById } from "../../lib/toolsCatalog";
import { normalizeSectionId } from "../../lib/harnessCatalog";
import { matchGreetingFastPath } from "../../lib/greeting";
import { suggestClosestCommand } from "../../commands/commandMeta";
import { requestAutoTitle } from "../../lib/autoTitle";
import { makeTitleGenerator } from "../../lib/harness/titleGenerator";
import { agentRegistry } from "../../core/agent/agents/registry";
import { permissionScopeFromAgent } from "../../core/agent/agents/permissions";
import { planPathForSession } from "../../core/agent/agents/planWriteTool";

/**
 * Plan turn configuration — derived, never re-declared.
 *
 * The canonical `plan` agent in AgentRegistry is the SINGLE source of Plan
 * capabilities. The TUI contributes nothing security-relevant: it resolves the
 * agent, converts its declared scope to a runtime permission scope, and
 * filters the canonical tool schemas to exactly what that scope admits.
 *
 * Two layers protect the turn (both required):
 *   - `toolSchemas`  — the model never SEES a denied tool (schema layer);
 *   - `permissionSet` — even a hallucinated/injected call for a hidden tool
 *     is refused by the harness gate BEFORE any executor (runtime layer).
 */
function planTurnConfig(): { toolSchemas: any[]; permissionSet: ReturnType<typeof permissionScopeFromAgent>; systemPromptAddendum: string } {
  const planAgent = agentRegistry.resolve("plan");
  const permissionSet = permissionScopeFromAgent(planAgent);
  const toolSchemas = toolRegistry.schemasFiltered((t) =>
    t.name === "plan_write" || permissionSet.tools?.[t.name] !== "deny"
  );
  return {
    toolSchemas,
    permissionSet,
    systemPromptAddendum: planAgent.systemPrompt || "",
  };
}

function toolCallIds(message: any): string[] {
  return Array.isArray(message?.tool_calls)
    ? message.tool_calls
      .map((call: any) => call?.id)
      .filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
    : [];
}

function transcriptMessagesCompatible(currentMsg: any, engineMsg: any): boolean {
  if (!currentMsg || !engineMsg || currentMsg.role !== engineMsg.role) return false;
  if (currentMsg.role === "tool" && currentMsg.tool_call_id && engineMsg.tool_call_id && currentMsg.tool_call_id !== engineMsg.tool_call_id) {
    return false;
  }
  if (currentMsg.role === "assistant") {
    const currentIds = toolCallIds(currentMsg);
    const engineIds = toolCallIds(engineMsg);
    if (currentIds.length > 0 && engineIds.length > 0) {
      return currentIds.some((id) => engineIds.includes(id));
    }
  }
  return true;
}

function mergeToolCalls(currentMsg: any, engineMsg: any): any[] | undefined {
  const currentCalls = Array.isArray(currentMsg?.tool_calls) ? currentMsg.tool_calls : [];
  const engineCalls = Array.isArray(engineMsg?.tool_calls) ? engineMsg.tool_calls : [];
  if (currentCalls.length === 0 && engineCalls.length === 0) return undefined;

  const callsByKey = new Map<string, any>();
  const keyFor = (call: any): string => {
    if (typeof call?.id === "string" && call.id) return `id:${call.id}`;
    return `call:${JSON.stringify(call?.function ?? call)}`;
  };

  for (const call of currentCalls) {
    const key = keyFor(call);
    if (!callsByKey.has(key)) callsByKey.set(key, call);
  }
  for (const call of engineCalls) {
    const key = keyFor(call);
    const existing = callsByKey.get(key);
    const argumentsValue = call?.function?.arguments;
    if (!existing || (typeof argumentsValue === "string" && argumentsValue.trim() && (!existing.function?.arguments || !String(existing.function.arguments).trim()))) {
      callsByKey.set(key, call);
    }
  }
  return [...callsByKey.values()];
}

function cleanAssistantContent(value: unknown): string {
  return typeof value === "string" ? value.replace(/▊/g, "") : "";
}

function mergeAssistantContent(currentMsg: any, engineMsg: any): string {
  const current = cleanAssistantContent(currentMsg?.content);
  const engine = cleanAssistantContent(engineMsg?.content);
  if (!current) return engine;
  if (!engine) return current;
  if (current === engine) return current;
  if (engine.endsWith(current)) return engine;
  if (current.endsWith(engine)) return current;
  return current;
}

function mergeTranscriptMessage(currentMsg: any, engineMsg: any): any {
  const merged = { ...engineMsg };
  if (typeof currentMsg?.id === "string" && currentMsg.id) merged.id = currentMsg.id;
  if (currentMsg?.role === "assistant") {
    merged.content = mergeAssistantContent(currentMsg, engineMsg);
  } else if (typeof currentMsg?.content === "string" && (!merged.content || !String(merged.content).trim())) {
    merged.content = currentMsg.content;
  }
  const toolCalls = mergeToolCalls(currentMsg, engineMsg);
  if (toolCalls !== undefined) merged.tool_calls = toolCalls;
  if (typeof currentMsg?.tool_call_id === "string") merged.tool_call_id = currentMsg.tool_call_id;
  if (typeof currentMsg?.name === "string") merged.name = currentMsg.name;
  return merged;
}

function mergeTranscriptMessages(currentMsgs: any[], engineMsgs: any[]): any[] {
  const merged: any[] = [];
  let eIdx = 0;

  for (const currentMsg of currentMsgs ?? []) {
    if (currentMsg.role === "reasoning") {
      merged.push(currentMsg);
      continue;
    }

    let matchIdx = -1;
    for (let idx = eIdx; idx < engineMsgs.length; idx++) {
      if (transcriptMessagesCompatible(currentMsg, engineMsgs[idx])) {
        matchIdx = idx;
        break;
      }
    }

    if (matchIdx >= eIdx) {
      for (; eIdx < matchIdx; eIdx++) merged.push(engineMsgs[eIdx]);
      merged.push(mergeTranscriptMessage(currentMsg, engineMsgs[matchIdx]));
      eIdx = matchIdx + 1;
    } else if (eIdx < engineMsgs.length && engineMsgs[eIdx].role === currentMsg.role) {
      merged.push(mergeTranscriptMessage(currentMsg, engineMsgs[eIdx++]));
    } else {
      merged.push(currentMsg);
    }
  }

  while (eIdx < engineMsgs.length) merged.push(engineMsgs[eIdx++]);
  return merged;
}

export function syncTranscriptPreservingReasoning(currentMsgs: any[], engineMsgs: any[]): any[] {
  const nonReasoningEngine = (engineMsgs ?? []).filter((m) => m.role !== "system");
  if (nonReasoningEngine.length === 0) return currentMsgs ?? [];
  return mergeTranscriptMessages(currentMsgs ?? [], nonReasoningEngine);
}

/**
 * Build the TUI's agent-event callbacks for one run.
 *
 * Reasoning has exactly ONE live path: `onEvent` → reasoning-start / delta /
 * end. The engine's legacy `onReasoningDelta` callback is deliberately NOT
 * wired here: passing both fed every reasoning chunk into appendReasoningDelta
 * twice, duplicating the visible thought stream ("AABBCC"). Text still uses
 * `onTextDelta` — the normalized event stream has no text-delta consumer here.
 *
 * Exported so the single-append contract is covered by a regression test that
 * drives the SAME handler the TUI uses.
 */
export function buildTuiAgentCallbacks(runId: string): {
  onTextDelta: (delta: string) => void;
  onEvent: (event: AgentEvent) => void;
} {
  // Maps a tool callId to its name, shared by the tool-call/result/error cases.
  const toolNames = new Map<string, string>();

  return {
    onTextDelta: (delta) => {
      // Content arrived -> finalize any active reasoning block for this turn
      tuiState.finalizeActiveReasoning("text-delta");
      // First visible token after thinking (or straight from idle on a
      // non-reasoning model) enters the canonical "responding" phase, so the
      // status line renders from state for every model, not only reasoners.
      if (tuiState.agentPhase === "thinking" || tuiState.agentPhase === "idle") {
        tuiState.agentPhase = "streaming";
      }
      tuiState.appendAssistantDelta(delta, tuiState.currentTurnId);
    },
    onEvent: (event) => {
      switch (event.type) {
        case "reasoning-start":
          tuiState.appendReasoningDelta("", {
            sessionId: tuiState.currentSessionId,
            runId,
            turnId: event.turn ?? tuiState.currentTurnId,
          });
          if (tuiState.agentPhase !== "thinking") tuiState.agentPhase = "thinking";
          statusManager.update("Thinking");
          break;
        case "reasoning-delta":
          tuiState.appendReasoningDelta(event.text, {
            sessionId: tuiState.currentSessionId,
            runId,
            turnId: event.turn ?? tuiState.currentTurnId,
          });
          if (tuiState.agentPhase !== "thinking") tuiState.agentPhase = "thinking";
          statusManager.update("Thinking");
          break;
        case "reasoning-end":
          if (tuiState.activeReasoningDraft) {
            tuiState.activeReasoningDraft.endedAt = event.timestamp ?? Date.now();
          }
          break;
        case "tool-call":
          // Tool call begins -> finalize current reasoning block immediately!
          tuiState.finalizeActiveReasoning("tool-call");
          tuiState.agentPhase = "working";
          toolNames.set(event.callId, event.name);
          statusManager.updateTool(event.name, event.input as any);
          tuiState.openActiveToolActivity(event.callId, event.name, event.input);
          tuiState.attachToolCall(
            {
              id: event.callId,
              type: "function",
              function: {
                name: event.name,
                arguments: typeof event.input === "string" ? event.input : JSON.stringify(event.input ?? {}),
              },
            },
            tuiState.currentTurnId
          );
          tuiState.requestChromeRender();
          break;
        case "tool-running":
          // Approval was granted (or no approval was needed): the tool is
          // actually executing, so drop the blocked state.
          if (tuiState.agentPhase === "waiting_approval") tuiState.agentPhase = "working";
          break;
        case "tool-progress":
          tuiState.updateActiveToolProgress(event.callId, {
            elapsedMs: event.elapsedMs,
            tail: event.tail,
          });
          break;
        case "permission-required":
          // Canonical "blocked on the user" state: the tool is NOT running, so
          // the status must not imply progress. requestApprovalModal owns the
          // decision; this only reflects it in the single status line.
          if (tuiState.agentPhase !== "thinking") tuiState.agentPhase = "waiting_approval";
          statusManager.update("Waiting for approval…");
          break;
        case "compaction":
          // History pruning is real work, not a hang: name it explicitly.
          tuiState.agentPhase = "compacting";
          statusManager.update("Compacting context…");
          break;
        case "steer_promoted":
          tuiState.appendMessage({ role: "user", content: event.content });
          tuiState.saveCurrentSession();
          tuiState.requestRender();
          break;
        case "tool-result": {
          const wasCancelled = tuiState.messages.some(
            (m) => m.role === "tool" && m.tool_call_id === event.callId && (m as any).cancelled
          );
          tuiState.markToolResult(event.callId);
          if (wasCancelled) {
            tuiState.closeActiveToolActivity(event.callId);
            break;
          }
          updateCrashToolResult(event.callId, event.result.exitCode ?? (event.result.ok ? 0 : 1), "Executed tool");
          // Duration comes from THIS call's activity — with parallel tools the
          // primary accessor may point at a different callId.
          const activity = tuiState.findToolActivity(event.callId);
          const durationMs = activity ? Date.now() - activity.startedAt : undefined;
          tuiState.closeActiveToolActivity(event.callId);
          tuiState.appendMessage({
            role: "tool",
            tool_call_id: event.callId,
            name: toolNames.get(event.callId) || "tool",
            content: JSON.stringify(event.result),
            durationMs,
            // Structured mutation payload persists with the transcript item, so
            // the diff is re-rendered from state (never from ANSI text).
            ...(event.result.fileMutations?.length ? { fileMutations: event.result.fileMutations } : {}),
          } as any);
          tuiState.requestRender();
          break;
        }
        case "tool-error": {
          const wasCancelled = tuiState.messages.some(
            (m) => m.role === "tool" && m.tool_call_id === event.callId && (m as any).cancelled
          );
          tuiState.markToolResult(event.callId);
          if (wasCancelled) {
            tuiState.closeActiveToolActivity(event.callId);
            break;
          }
          const activity = tuiState.findToolActivity(event.callId);
          const durationMs = activity ? Date.now() - activity.startedAt : undefined;
          tuiState.closeActiveToolActivity(event.callId);
          tuiState.appendMessage({
            role: "tool",
            tool_call_id: event.callId,
            name: toolNames.get(event.callId) || "tool",
            content: JSON.stringify({ error: event.error, exitCode: 1 }),
            durationMs,
          } as any);
          tuiState.requestRender();
          break;
        }
        case "cancelled": {
          // Cancel EVERY running tool, not just the last-started one, and leave
          // one cancelled transcript row per tool so call/result pairs survive.
          const cancelledActivities = tuiState.cancelAllToolActivities();
          for (const cancelled of cancelledActivities) {
            tuiState.appendMessage({
              role: "tool",
              tool_call_id: cancelled.callId,
              name: cancelled.name,
              content: JSON.stringify({ error: "Cancelled", exitCode: 130 }),
              durationMs: cancelled.elapsedMs,
              cancelled: true,
            } as any);
          }
          tuiState.clearToolActivities();
          tuiState.finalizeActiveReasoning("cancelled");
          tuiState.finalizeAssistantDraft("cancelled");
          tuiState.agentPhase = "cancelled";
          break;
        }
        case "agent-complete":
          tuiState.finalizeActiveReasoning("agent-complete");
          tuiState.finalizeAssistantDraft("agent-complete");
          tuiState.agentPhase = "done";
          break;
        case "error":
          tuiState.finalizeActiveReasoning("error");
          tuiState.finalizeAssistantDraft("error");
          tuiState.agentPhase = "error";
          statusManager.failed(event.error);
          break;
        default:
          break;
      }
    },
  };
}

export async function sendMessage(text: string, isContinuation = false): Promise<void> {
  if (!text.trim() && !isContinuation) return;

  if (text.startsWith("/")) {
    await handleSlashCommand(text.trim());
    return;
  }

  // Greeting-only input gets a fixed local reply — no model call.
  const greeting = matchGreetingFastPath(text, getCwdInfo().currentCwd);
  if (greeting) {
    tuiState.appendMessage({ role: "user", content: text });
    tuiState.appendMessage({ role: "assistant", content: greeting });
    tuiState.saveCurrentSession();
    pinToTail(tuiState.chatViewport);
    tuiState.requestRender();
    return;
  }

  messageQueue.setIsProcessing(true);

  // Initialize fresh run with isolated runId and reset reasoning draft
  const runId = tuiState.startNewRun(tuiState.currentSessionId);

  if (text.trim()) {
    tuiState.appendMessage({ role: "user", content: text });
  }

  // Explicit language request ("trả lời bằng tiếng Việt", "用中文", ...)
  // locks the response language for the session; otherwise it stays "auto"
  // and the system prompt tells the model to mirror the latest user message.
  const langRequest = extractLanguageRequest(text);
  if (langRequest) {
    tuiState.responseLanguage = langRequest;
    setResponseLanguage(langRequest);
  }
  tuiState.saveCurrentSession();

  pinToTail(tuiState.chatViewport);
  statusManager.start("Thinking…");

  tuiState.abortController = new AbortController();

  // Reset reasoning state for the new turn (capability-aware: phase only
  // becomes "thinking" when the model actually reasons or streams reasoning).
  tuiState.agentPhase = supportsReasoning(tuiState.currentModel) ? "thinking" : "idle";
  tuiState.saveCurrentSession();

  try {
    // ── Shared Agent Engine ──────────────────────────────────
    // The TUI no longer holds an agent loop. It builds the transcript, calls
    // the ONE engine, and renders the normalized AgentEvent stream: no
    // tool_calls parsing, no direct tool execution, no provider-specific code.
    const provider = getActiveProvider();
    if (!provider) {
      stopSpinner();
      tuiState.appendMessage({ role: "assistant", content: "✖ Error: No provider configured. Use /provider add to set one up." });
      tuiState.setStatus("✖ No provider configured");
      tuiState.requestRender();
      return;
    }

    tuiState.setStatus("Calling API…");

    const autoPrep = await contextEngine.prepareMessagesForApi(tuiState.messages as any, {
      model: tuiState.currentModel,
      sessionId: tuiState.currentSessionId,
      summarizeWithModel: makeCheckpointSummarizer({ provider, model: tuiState.currentModel }),
    });
    if (autoPrep.compacted) {
      tuiState.replaceMessages(autoPrep.messages);
      tuiState.saveCurrentSession();
    }

    const apiMessages: ContextMessage[] = tuiState.messages
      .filter((m) => m.role !== "system" && m.role !== "reasoning")
      .map((m) => {
        let contentPayload: any = m.content;
        if (m.role === "user" && typeof m.content === "string" && (m.content.includes("@") || m.content.includes("/attach"))) {
          const processed = parseAndProcessInput(m.content, getCwdInfo().currentCwd);
          if (processed.attachments.length > 0) {
            contentPayload = processed.formattedContent;
          }
        }
        const out: any = { role: m.role, content: contentPayload };
        if (m.tool_calls) out.tool_calls = m.tool_calls;
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        if (m.name) out.name = m.name;
        return out;
      });

    // System prompt COMPOSITION: the full base prompt (workspace context,
    // memory, language, security, skills/MCP) is always present. Plan only
    // ADDS its canonical role instructions — it never replaces the base.
    const isPlanTurn = tuiState.agentMode === "Plan";
    const plan = isPlanTurn ? planTurnConfig() : null;
    const basePrompt = getAgentSystemPrompt(tuiState.currentSessionId);
    apiMessages.unshift({
      role: "system",
      content: plan ? `${basePrompt}\n\n${plan.systemPromptAddendum}` : basePrompt,
    });
    assertPrimarySystemMessageInvariant(apiMessages as any);

    const toolsOverride = plan ? plan.toolSchemas : undefined;
    const toolPermissionSet = plan ? plan.permissionSet : undefined;

    // ── Session title (background, never awaited) ────────────────
    // The turn below starts immediately; the title is only a label. A session
    // is titled once, from its first substantive task — greetings and nudges
    // fall through `isSubstantiveTask`, resumed/renamed sessions are skipped by
    // the service, and `SessionStore.setAutoTitle` refuses to overwrite a
    // manual rename that races with us.
    void requestAutoTitle({
      sessionId: tuiState.currentSessionId,
      prompt: text,
      generate: makeTitleGenerator({
        provider,
        model: tuiState.currentModel || getActiveDefaultModel() || "default",
      }),
      onTitle: (title) => {
        tuiState.sessionTitle = title;
        tuiState.requestRender();
      },
    });

    tuiState.setStatus("Streaming response…");

    const result = await agentEngine.run({
      prompt: text,
      messages: apiMessages,
      model: tuiState.currentModel || getActiveDefaultModel() || "default",
      sessionId: tuiState.currentSessionId,
      stream: true,
      signal: tuiState.abortController.signal,
      toolsOverride,
      // HARD runtime scope: even a hidden/injected tool call for a schema-
      // invisible tool is refused by the harness gate before any executor.
      toolPermissionSet,
      reasoningSettings: tuiState.reasoningSettings,
      // ONE canonical reasoning path: onEvent → reasoning-start/delta/end.
      // (No onReasoningDelta — wiring both duplicated every chunk.)
      ...buildTuiAgentCallbacks(runId),
      requestApproval: async ({ name, args, reason }) => {
        const decision = await requestApprovalModal({
          toolName: name,
          args,
          targetKey: securityEngine.getSessionTrustTargetKey(name, args),
          reason: reason || `Tool ${name} requires permission`,
        });
        return decision;
      },
      // Legacy TUI-only save_plan hook removed: plan_write is a canonical
      // registry tool now (dispatch → permission → security → executor), so
      // Plan mutations no longer bypass the core tool infrastructure.
    });

    tuiState.finalizeActiveReasoning("run-settled");

    // Adopt the engine-owned transcript (minus the system prompt, which the
    // TUI rebuilds per turn) so tool results persist across turns, while
    // preserving any reasoning blocks already in the transcript.
    const transcript = (result.messages ?? []).filter((m) => m.role !== "system");
    if (transcript.length > 0) {
      tuiState.replaceMessages(syncTranscriptPreservingReasoning(tuiState.messages, transcript));
    } else if (!result.success) {
      tuiState.appendMessage({ role: "assistant", content: result.error ? `✖ Error: ${result.error}` : "(no response)" });
    } else {
      const outputText = result.output || "(empty response)";
      const lastMsg = tuiState.messages[tuiState.messages.length - 1];
      if (lastMsg && lastMsg.role === "assistant" && !lastMsg.tool_calls) {
        lastMsg.content = outputText;
      } else {
        tuiState.appendMessage({ role: "assistant", content: outputText });
      }
    }

    if (!result.success) {
      statusManager.failed(result.error || "Execution failed");
      tuiState.agentPhase = "error";
    } else {
      tuiState.agentPhase = "done";
      const reasoningDoneMsg =
        tuiState.reasoningTokens > 0
          ? `Done · ${tuiState.reasoningTokens.toLocaleString()} reasoning tokens`
          : undefined;
      if (reasoningDoneMsg && (tuiState.reasoningText || tuiState.messages.some((m) => m.role === "reasoning"))) {
        statusManager.done(`✔ ${reasoningDoneMsg}`);
      } else {
        statusManager.done();
      }
    }
    
    tuiState.saveCurrentSession();
    tuiState.requestRender();
  } catch (err: any) {
    tuiState.finalizeActiveReasoning("error");
    if (err?.name === "AbortError") {
      tuiState.agentPhase = "cancelled";
      statusManager.cancel();
      tuiState.appendMessage({ role: "assistant", content: "(cancelled)" });
    } else if (err?.message?.includes("401") || err?.status === 401) {
      statusManager.failed("Authentication failed (401).");
      tuiState.appendMessage({ role: "system", content: "⚠️ API Key expired or invalid (401)." });
      tuiState.saveCurrentSession();
      tuiState.requestRender();
      
      const { credentialsStore } = await import("../../lib/keys");
      const { getActiveProvider } = await import("../../providers");
      const provider = getActiveProvider();
      
      while (true) {
        const key = await tuiState.openSecretInput({ title: "API Key", placeholder: "Enter new API key" });
        if (!key) break;
        tuiState.setStatus("Validating API Key...");
        tuiState.requestRender();
        const valid = provider && provider.validateCredentials ? await provider.validateCredentials(key) : true;
        if (valid) {
          await credentialsStore.saveApiKey(key);
          tuiState.showToast("API Key saved.", 2000);
          tuiState.appendMessage({ role: "system", content: "✅ API Key updated. You can resubmit your prompt." });
          break;
        } else {
          tuiState.showToast("API Key không hợp lệ", 3000);
          tuiState.requestRender();
        }
      }
    } else {
      tuiState.agentPhase = "error";
      statusManager.failed(err?.message || String(err));
      tuiState.appendMessage({ role: "assistant", content: "✖ Error: " + (err?.message || String(err)) });
      tuiState.showToast("⚠️ " + (err?.message || String(err)), 3500);
    }
    tuiState.saveCurrentSession();
  } finally {
    tuiState.abortController = null;
    // NOTE: `agent.start` / `agent.end` are fired by AgentHarness.executeLoop,
    // the single loop entry every front-end uses — not here. Firing them in the
    // TUI would double-report the lifecycle.

    // ── Completion Boundary: Re-check pending steers ──
    // A steer might have arrived exactly while we were returning from the harness
    // but before we reached this block. We must not drop into idle if work remains.
    if (pendingInputs.count(tuiState.currentSessionId) > 0) {
      tuiState.setStatus("Processing queued follow-up…");
      tuiState.saveCurrentSession();
      tuiState.requestRender();
      setTimeout(() => {
        sendMessage("", true).catch(() => {});
      }, 0);
      return;
    }

    if (messageQueue.size() > 0) {
      const nextTask = messageQueue.dequeue();
      if (nextTask) {
        tuiState.setStatus(`Processing next queued message (${messageQueue.size()} remaining)…`);
        tuiState.saveCurrentSession();
        tuiState.requestRender();
        setTimeout(() => {
          sendMessage(nextTask.text).catch(() => {});
        }, 50);
        return;
      }
    }
    messageQueue.setIsProcessing(false);
  }

  tuiState.requestRender();
}

function stopSpinner(): void {
  statusManager.stop();
}

/**
 * OAuth 2.0 Device Authorization Grant — end-to-end TUI wiring.
 *
 * Flow: request device code → show modal (user code + URL) → poll with the
 * SAME device code → pending/slow_down handled per RFC 8628 → save the
 * credential on success → refresh provider state. Esc/Ctrl+C aborts polling.
 * All failures are recoverable (status + toast), never process.exit.
 */
export async function startOAuthDeviceFlow(provider: string): Promise<void> {
  // Guard: one flow at a time.
  if (tuiState.deviceCodeModal) return;

  const { detectGatewayUrl, createGateway } = await import("../../lib/gateway");
  const { runDeviceFlow, OAuthFlowError } = await import("../../lib/oauthDeviceFlow");
  const baseUrl = detectGatewayUrl();
  if (!baseUrl) {
    tuiState.showToast("OAuth requires a ToolNet gateway URL (TOOLNET_API_URL)", 3500);
    tuiState.setStatus("✖ No gateway configured for OAuth");
    tuiState.requestRender();
    return;
  }
  const gateway = createGateway(baseUrl);

  tuiState.oauthAbort = new AbortController();
  const signal = tuiState.oauthAbort.signal;

  try {
    const result = await runDeviceFlow(
      gateway,
      provider,
      {
        onDeviceCode: ({ userCode, verificationUri, verificationUriComplete }) => {
          tuiState.deviceCodeModal = {
            provider,
            userCode,
            verificationUri,
            verificationUriComplete,
            statusText: "Waiting for authorization…",
          };
          tuiState.requestRender();
        },
        onPolling: ({ attempt }) => {
          if (tuiState.deviceCodeModal) {
            tuiState.deviceCodeModal.statusText = `Waiting for authorization… (poll ${attempt})`;
            tuiState.requestRender();
          }
        },
      },
      signal
    );

    tuiState.deviceCodeModal = null;
    tuiState.oauthAbort = null;

    if (result.connection || result.successWithoutConnection) {
      // Save the credential under the provider id so resolveApiKey() finds it.
      const { saveCliKey } = await import("../../lib/keys");
      saveCliKey(provider, "oauth:" + provider);
      const { setActiveProvider } = await import("../../providers");
      setActiveProvider(provider);
      tuiState.showToast("✅ " + provider + " authorized", 3000);
      tuiState.setStatus("Provider authorized: " + provider);
      await tuiState.refreshActiveModels();
    } else {
      tuiState.showToast("⚠️ Authorization completed but no connection returned", 3500);
    }
  } catch (err: any) {
    tuiState.deviceCodeModal = null;
    tuiState.oauthAbort = null;
    const msg = err instanceof OAuthFlowError ? err.message : String(err?.message || err);
    // Recoverable: show error in TUI, session stays alive.
    tuiState.showToast("⚠️ OAuth: " + msg, 3500);
    tuiState.setStatus("✖ OAuth failed: " + msg);
  }
  tuiState.requestRender();
}

export function buildTuiCommandContext(): any {
  return {
    addMessage: (role: "user" | "assistant" | "system", content: string) => {
      tuiState.appendMessage({ role, content });
    },
    setModel: (m: string) => {
      tuiState.currentModel = m;
      tuiState.setStatus("Model: " + m);
    },
    setStatusMsg: (s: string) => tuiState.setStatus(s),
    exit: () => {
      process.stdout.write(`ToolNet CLI v${getVersion()} · /help for commands\r\n`);
      process.stdout.write("Goodbye!\r\n");
      process.exit(0);
    },
    currentModel: () => tuiState.currentModel,
    openModelPicker: () => tuiState.openModelPicker(),
    openKeyManager: () => tuiState.openKeyManager(),
    openProviderPicker: () => providerPicker.open((s) => tuiState.setStatus(s), () => tuiState.requestRender()),
    startOAuthDeviceFlow: (provider: string) => startOAuthDeviceFlow(provider),
    openSkillsPicker: (initialSkillName?: string) => tuiState.openSkillsPicker(initialSkillName),
    openQueueManager: () => tuiState.openQueueManager(),
    openSessionPicker: () => tuiState.openSessionPicker(),
    setSessionTitle: (title?: string) => {
      tuiState.sessionTitle = title;
      tuiState.requestRender();
    },
    openToolsPanel: (initialToolName?: string) => {
      if (initialToolName && getToolById(initialToolName)) {
        tuiState.openToolDetail(initialToolName);
      } else if (initialToolName) {
        tuiState.showToast("Tool not found: " + initialToolName);
        tuiState.openToolsOverlay();
      } else {
        tuiState.openToolsOverlay();
      }
    },
    openHarnessPanel: (initialSection?: string) => {
      const sectionId = initialSection ? normalizeSectionId(initialSection) : null;
      if (initialSection && !sectionId) {
        tuiState.showToast("Section not found: " + initialSection);
        tuiState.openHarnessOverlay();
      } else if (sectionId) {
        tuiState.openHarnessSection(sectionId);
      } else {
        tuiState.openHarnessOverlay();
      }
    },
    setBypassMode: (enabled: boolean, level?: string) => {
      tuiState.bypassMode = enabled;
      if (level) tuiState.bypassLevel = level as any;
      tuiState.showToast(enabled ? `Bypass Mode ENABLED (${tuiState.bypassLevel.toUpperCase()})` : "Bypass Mode DISABLED");
      tuiState.setStatus(`Bypass Mode: ${enabled ? "ON" : "OFF"}${level ? ` (${level})` : ""}`);
      tuiState.requestRender();
    },
    // Teamwork abort hook: Ctrl+C while a DAG runs cancels the scheduler
    // (and its subagents) instead of exiting the CLI.
    registerTeamworkAbort: (ctrl: AbortController) => {
      tuiState.teamworkAbort = ctrl;
    },
    getCurrentSessionId: () => tuiState.currentSessionId,
    setCurrentSessionId: (id: string) => { tuiState.currentSessionId = id; },
    getMessages: () => tuiState.messages,
    setMessages: (msgs: any[]) => { tuiState.replaceMessages(msgs); tuiState.saveCurrentSession(); },
    clearMessages: () => { tuiState.clearMessages(); tuiState.saveCurrentSession(); },
    switchSession: (sessionId: string) => {
      const loaded = loadSession(sessionId);
      if (!loaded) return false;
      tuiState.currentSessionId = loaded.sessionId;
      tuiState.replaceMessages(loaded.messages as any);
      // Switching sessions must swap the footer label too, and clear it when the
      // target is untitled (never leak the previous session's title).
      tuiState.sessionTitle = sessionDisplayTitle(loaded);
      // Pending steers are session-scoped: restore the TARGET's, never the
      // source's (a different session must not see this session's follow-ups).
      pendingInputs.restore(loaded.sessionId, readPendingInputs(loaded.sessionId));
      if (loaded.metadata?.model) tuiState.currentModel = loaded.metadata.model;
      if (loaded.metadata?.agentMode) tuiState.agentMode = loaded.metadata.agentMode;
      if (loaded.metadata?.queuedMessages && Array.isArray(loaded.metadata.queuedMessages)) {
        messageQueue.restore(loaded.metadata.queuedMessages);
      }
      tuiState.saveCurrentSession();
      tuiState.setStatus(`Session: ${tuiState.currentSessionId}`);
      return true;
    },
    setAgentMode: (mode: "Build" | "Plan") => {
      tuiState.agentMode = mode;
      tuiState.setStatus("Mode: " + mode);
    },
    setReasoningEffort: (effort: "auto" | "low" | "medium" | "high" | "off") => {
      const { supportsReasoningEffort } = require("../../lib/reasoning");
      // Guard: models without configurable reasoning keep settings untouched.
      if (!supportsReasoningEffort(tuiState.currentModel) && effort !== "off") {
        tuiState.setStatus("Reasoning not configurable for this model");
        return false;
      }
      if (effort === "off") {
        tuiState.reasoningSettings = { enabled: false, effort: "auto" };
      } else if (effort === "auto") {
        tuiState.reasoningSettings = { enabled: true, effort: "auto" };
      } else {
        tuiState.reasoningSettings = { enabled: true, effort };
      }
      tuiState.saveCurrentSession();
      tuiState.setStatus(`Reasoning: ${effort}`);
      return true;
    },
    getReasoningStatus: () => {
      const s = tuiState.reasoningSettings;
      if (!s.enabled) return "off";
      return s.effort === "auto" ? "auto (model default)" : s.effort;
    },
  };
}

/**
 * The ONE canonical Plan → Build approval action.
 *
 * Both the plan-ready confirmation and `/approve` land here. Contract:
 *  - the ACTIVE Plan turn must already have ended (never mid-stream);
 *  - execution is a NEW Build provider turn — the Plan request is never
 *    mutated into Build mid-flight;
 *  - Build receives the plan path + approved state through a synthetic user
 *    turn at a safe boundary, so it can read the file from canonical context.
 */
export async function approvePlanAndBuild(): Promise<void> {
  const sessionId = tuiState.currentSessionId;
  const workspaceRoot = getCwdInfo().workspaceRoot || getCwdInfo().currentCwd;
  const planPath = planPathForSession(workspaceRoot, sessionId || "session");
  const fsmod = await import("node:fs");
  if (!fsmod.existsSync(planPath)) {
    tuiState.showToast("No plan file to approve — run a Plan turn first", 3000);
    return;
  }
  if (tuiState.isStreaming || tuiState.abortController) {
    tuiState.showToast("Plan turn still running — approve when it finishes", 3000);
    return;
  }
  tuiState.agentMode = "Build";
  tuiState.setStatus("Mode: Build · executing approved plan");
  tuiState.appendMessage({ role: "system", content: "→ Plan approved. Starting Build execution." });
  tuiState.requestRender();
  await sendMessage(
    `The plan at ${planPath} has been approved. Read it and execute the approved plan.`,
  );
}

export async function handleSlashCommand(cmd: string): Promise<void> {
  const parts = cmd.split(" ");
  const name = parts[0].toLowerCase();
  const ctx = buildTuiCommandContext();

  try {
    switch (name) {
      case "/exit":
      case "/quit": {
        const hasContent = (tuiState.messages && tuiState.messages.length > 0) || messageQueue.size() > 0;
        const sessionId = tuiState.currentSessionId;
        if (hasContent && sessionId) {
          tuiState.saveCurrentSession();
        }
        markCleanExit();
        restoreTerminal();
        const msg = formatExitMessage(sessionId, hasContent);
        process.stdout.write(msg.replace(/\n/g, "\r\n"));
        process.exit(0);
        break;
      }

      case "/model":
      case "/models":
      case "/m": {
        const modelArg = parts.slice(1).join(" ").trim();
        if (modelArg && modelArg !== "--help") {
          tuiState.currentModel = modelArg;
          tuiState.setStatus("Model: " + modelArg);
          tuiState.showToast("Model switched to " + modelArg);
          tuiState.appendMessage({ role: "assistant", content: `Model set to: ${modelArg}` });
        } else if (modelArg === "--help") {
          tuiState.appendMessage({
            role: "assistant",
            content: "/model — Model Selection\n\n  /model               Open model picker\n  /model <model-id>    Select model\n  /model --help        Show this help\n\nCurrent: " + (tuiState.currentModel || "none"),
          });
        } else {
          await tuiState.openModelPicker();
        }
        break;
      }

      case "/help":
      case "/?":
        // Pass the FULL input so `/help mcp` shows that command's details
        // (including its subcommands) instead of the generic list.
        await dispatchCommand(cmd, ctx);
        tuiState.showHelp = !tuiState.showHelp;
        break;

      case "/clear":
        tuiState.clearMessages();
        tuiState.saveCurrentSession();
        tuiState.showToast("Chat history cleared");
        tuiState.setStatus("Chat cleared");
        break;

      case "/agent": {
        // Same busy policy as Tab: switching is next-turn selection. While a
        // provider request is active the toggle only records the NEXT mode.
        if (tuiState.isStreaming || tuiState.abortController) {
          tuiState.agentMode = tuiState.agentMode === "Build" ? "Plan" : "Build";
          tuiState.showToast(`Next turn: ${tuiState.agentMode} (after current run)`);
          tuiState.setStatus("Next: " + tuiState.agentMode);
        } else {
          tuiState.agentMode = tuiState.agentMode === "Build" ? "Plan" : "Build";
          const modeName = tuiState.agentMode === "Plan" ? "Planner" : "Builder";
          tuiState.showToast("Switched to " + modeName + " Mode");
          tuiState.setStatus("Mode: " + modeName);
        }
        break;
      }

      case "/plan": {
        // ONE provider request per session: while busy, `/plan` never starts a
        // second run — the task text (if any) is queued and the Plan turn is
        // admitted at the next safe turn boundary.
        const taskText = parts.slice(1).join(" ").trim();
        if (tuiState.isStreaming || tuiState.abortController) {
          tuiState.agentMode = "Plan";
          tuiState.appendMessage({ role: "system", content: "→ Plan requested. It starts after the current run finishes." });
          if (taskText) messageQueue.enqueue(taskText);
          tuiState.requestRender();
          return;
        }
        tuiState.agentMode = "Plan";
        tuiState.setStatus("Mode: Plan");
        if (taskText) {
          await sendMessage(taskText);
        } else {
          tuiState.appendMessage({ role: "system", content: "→ Plan mode. Send a task to plan, e.g. `/plan audit the auth flow`." });
          tuiState.requestRender();
        }
        return;
      }

      case "/approve": {
        // Alias of the ONE canonical approval action (same state transition as
        // the plan-ready approval, no second protocol).
        await approvePlanAndBuild();
        return;
      }

      case "/build": {
        tuiState.agentMode = "Build";
        tuiState.showToast("Switched to Builder Mode");
        tuiState.setStatus("Mode: Builder");
        break;
      }

      case "/key":
      case "/keys":
      case "/apikey":
      case "/apikeys": {
        const rest = parts.slice(1).join(" ").trim();
        if (!rest) {
          tuiState.openKeyManager();
        } else {
          await dispatchCommand(cmd, ctx);
        }
        break;
      }

      case "/provider":
      case "/providers": {
        const rest = parts.slice(1).join(" ").trim();
        if (!rest) {
          providerPicker.open((s) => tuiState.setStatus(s), () => tuiState.requestRender());
        } else {
          await dispatchCommand(cmd, ctx);
        }
        break;
      }

      case "/setup": {
        // Exit the full-screen TUI, run the manual setup wizard in a fresh
        // process (inherits this TTY), then leave. `toolnet` relaunches
        // straight into the main TUI once the config is usable again.
        tuiState.saveCurrentSession();
        markCleanExit();
        restoreTerminal();
        const { spawn } = await import("node:child_process");
        const entry = process.argv[1];
        const child = spawn(process.execPath, [entry, "config", "init"], { stdio: "inherit" });
        child.on("error", () => process.exit(1));
        child.on("exit", (code) => process.exit(code ?? 0));
        return;
      }

      case "/skills":
      case "/skill": {
        const rest = parts.slice(1).join(" ").trim();
        if (rest === "--help" || rest === "help") {
          await dispatchCommand(cmd, ctx);
        } else {
          tuiState.openSkillsPicker(rest || undefined);
        }
        break;
      }

      case "/queue":
      case "/q":
      case "/tasks": {
        const rest = parts.slice(1).join(" ").trim();
        if (!rest) {
          tuiState.openQueueManager();
        } else {
          await dispatchCommand(cmd, ctx);
        }
        break;
      }

      case "/session":
      case "/sessions":
      case "/tab": {
        const rest = parts.slice(1).join(" ").trim();
        if (!rest) {
          tuiState.openSessionPicker();
        } else {
          await dispatchCommand(cmd, ctx);
        }
        break;
      }

      case "/tools":
      case "/cli-tools": {
        const rest = parts.slice(1).join(" ").trim();
        if (rest && getToolById(rest)) {
          tuiState.openToolDetail(rest);
        } else if (rest) {
          tuiState.showToast("Tool not found: " + rest);
          tuiState.openToolsOverlay();
        } else {
          tuiState.openToolsOverlay();
        }
        break;
      }

      case "/harness":
      case "/kernel":
      case "/sys": {
        const rest = parts.slice(1).join(" ").trim();
        const sectionId = rest ? normalizeSectionId(rest) : null;
        if (rest && !sectionId) {
          tuiState.showToast("Section not found: " + rest);
          tuiState.openHarnessOverlay();
        } else if (sectionId) {
          tuiState.openHarnessSection(sectionId);
        } else {
          tuiState.openHarnessOverlay();
        }
        break;
      }

      default: {
        const handled = await dispatchCommand(cmd, ctx);
        if (!handled) {
          // One append per submit — the closest command is offered as a hint on
          // the SAME row-group, never auto-executed.
          const suggestion = suggestClosestCommand(name);
          const hint = suggestion ? `\nDid you mean /${suggestion}?` : "";
          tuiState.appendMessage({ role: "system", content: "Unknown command: " + name + "  (type /help)" + hint });
        }
        break;
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    tuiState.setStatus(`⚠️ Command failed: ${errMsg}`);
    tuiState.showToast(`⚠️ Command error: ${errMsg}`, 3000);
    tuiState.appendMessage({ role: "system", content: `✖ Command error: ${errMsg}` });
  }

  tuiState.requestRender();
}
