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
import { requestApprovalModal, requestConfirmation } from "../permissions/permissionModal";
import { dispatchCommand } from "../../commands";
import { loadSession, formatExitMessage } from "../../lib/sessionPersistence";
import { A } from "../../term";
import { updateCrashToolResult, markCleanExit } from "../../lib/crashRecovery";
import { restoreTerminal } from "../../lib/terminalLifecycle";
import { pinToTail } from "../viewport";
import { getActiveProvider, getActiveDefaultModel } from "../../providers";
import { statusManager } from "../statusService";
import { messageQueue } from "../../lib/messageQueue";
import { providerPicker } from "../providerPicker";
import { assertPrimarySystemMessageInvariant } from "../../lib/context";
import { getToolById } from "../../lib/toolsCatalog";
import { normalizeSectionId } from "../../lib/harnessCatalog";
import { matchGreetingFastPath } from "../../lib/greeting";

const PLANNER_SYSTEM_PROMPT = `You are ToolNet Planner. Your goal is to analyze the user request, explore the codebase using read-only tools, and create a step-by-step plan. Do not execute the plan yourself. Use the save_plan tool to save the plan.`;

async function handleSavePlan(parsedArgs: any): Promise<string> {
  const cwd = getCwdInfo().currentCwd;
  const toolnetDir = path.join(cwd, ".toolnet");
  if (!fs.existsSync(toolnetDir)) fs.mkdirSync(toolnetDir);
  const planPath = path.join(toolnetDir, "plan.md");

 // Layer 4 : save_plan is a model-callable MUTATING tool — its file
  // write goes through the security-evaluated toolWrite (workspace invariant,
  // history snapshot) instead of a raw fs.writeFileSync bypass.
  const { toolWrite } = await import("../../lib/codingAgent");
  const writeRes = toolWrite(planPath, parsedArgs?.content || "");
  if (!writeRes.success) {
    return JSON.stringify({ stdout: "", stderr: writeRes.error || "Failed to save plan", exitCode: 1 });
  }

  const confirmed = await requestConfirmation("Plan generated. Approve and switch to Build mode?");
  if (confirmed) {
    tuiState.agentMode = "Build";
    return JSON.stringify({ stdout: "Plan saved to .toolnet/plan.md. Switched to Build mode.", exitCode: 0 });
  }
  return JSON.stringify({ error: "User denied the plan." });
}

/**
 * Build the tool schema list for the current agent mode from the ONE canonical
 * registry. Plan mode is restricted to read-only tools plus save_plan; Build
 * mode exposes the full registry plus any plugin-registered tools.
 *
 * The engine passes this straight to the harness — the TUI never assembles a
 * second, divergent schema set.
 */
function buildToolsForMode(mode: "Build" | "Plan"): any[] | undefined {
 // : plugin and MCP tools are registered INTO the canonical registry,
  // so `schemas()` already contains them. The TUI must not concatenate a second
  // tool source — doing so previously exposed plugin tools that no dispatcher
  // could execute.
  const base = toolRegistry.schemas();

  if (mode !== "Plan") return base;

  const readOnly = new Set([
    "read_file",
    "grep",
    "grep_search",
    "glob",
    "glob_search",
    "find_path",
    "list_dir",
    "tree",
    "file_exists",
    "get_cwd",
    "web_fetch",
  ]);

  const planTools = base.filter((t: any) => readOnly.has(t?.function?.name));
  planTools.push({
    type: "function",
    function: {
      name: "save_plan",
      description: "Save the generated plan and request user approval to switch to Build mode.",
      parameters: {
        type: "object",
        properties: { content: { type: "string", description: "The plan content" } },
        required: ["content"],
      },
    },
  });
  return planTools;
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

export async function sendMessage(text: string): Promise<void> {
  if (!text.trim()) return;

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

  tuiState.appendMessage({ role: "user", content: text });

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

    // The engine resumes this transcript as-is, so the system prompt must be
    // first — assertPrimarySystemMessageInvariant enforces that invariant.
    apiMessages.unshift({ role: "system", content: tuiState.agentMode === "Plan" ? PLANNER_SYSTEM_PROMPT : getAgentSystemPrompt(tuiState.currentSessionId) });
    assertPrimarySystemMessageInvariant(apiMessages as any);

    const toolsOverride = buildToolsForMode(tuiState.agentMode);

    tuiState.setStatus("Streaming response…");

    const toolNames = new Map<string, string>();

    const result = await agentEngine.run({
      prompt: text,
      messages: apiMessages,
      model: tuiState.currentModel || getActiveDefaultModel() || "default",
      sessionId: tuiState.currentSessionId,
      stream: true,
      signal: tuiState.abortController.signal,
      toolsOverride,
      reasoningSettings: tuiState.reasoningSettings,
      onTextDelta: (delta) => {
        // Content arrived -> finalize any active reasoning block for this turn
        tuiState.finalizeActiveReasoning("text-delta");
        if (tuiState.agentPhase === "thinking") tuiState.agentPhase = "streaming";
        tuiState.appendAssistantDelta(delta, tuiState.currentTurnId);
      },
      onReasoningDelta: (delta) => {
        tuiState.appendReasoningDelta(delta, {
          sessionId: tuiState.currentSessionId,
          runId,
          turnId: tuiState.currentTurnId,
        });
        statusManager.update("Thinking");
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
          case "tool-progress":
            tuiState.updateActiveToolProgress(event.callId, {
              elapsedMs: event.elapsedMs,
              tail: event.tail,
            });
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
            const durationMs = tuiState.activeToolActivity?.callId === event.callId
              ? Date.now() - tuiState.activeToolActivity.startedAt
              : undefined;
            tuiState.closeActiveToolActivity(event.callId);
            tuiState.appendMessage({
              role: "tool",
              tool_call_id: event.callId,
              name: toolNames.get(event.callId) || "tool",
              content: JSON.stringify(event.result),
              durationMs,
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
            const durationMs = tuiState.activeToolActivity?.callId === event.callId
              ? Date.now() - tuiState.activeToolActivity.startedAt
              : undefined;
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
          case "cancelled":
            if (tuiState.activeToolActivity) {
              const cancelled = tuiState.cancelActiveToolActivity();
              if (cancelled) {
                tuiState.appendMessage({
                  role: "tool",
                  tool_call_id: cancelled.callId,
                  name: cancelled.name,
                  content: JSON.stringify({ error: "Cancelled", exitCode: 130 }),
                  durationMs: cancelled.elapsedMs,
                  cancelled: true,
                } as any);
                tuiState.activeToolActivity = null;
              }
            }
            tuiState.finalizeActiveReasoning("cancelled");
            tuiState.finalizeAssistantDraft("cancelled");
            tuiState.agentPhase = "cancelled";
            break;
          case "agent-complete":
            tuiState.finalizeActiveReasoning("agent-complete");
            tuiState.finalizeAssistantDraft("agent-complete");
            tuiState.agentPhase = "done";
            break;
          default:
            break;
        }
      },
      requestApproval: async ({ name, args, reason }) => {
        const decision = await requestApprovalModal({
          toolName: name,
          args,
          targetKey: securityEngine.getSessionTrustTargetKey(name, args),
          reason: reason || `Tool ${name} requires permission`,
        });
        return decision;
      },
      onCustomTool: async (name, args) => {
        // TUI-only tool: save_plan is handled here, not in the core registry.
        if (name !== "save_plan") return null;
        const toolResult = await handleSavePlan(args);
        return { result: toolResult, allowed: true };
      },
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
    }
    tuiState.saveCurrentSession();
    tuiState.requestRender();

    pinToTail(tuiState.chatViewport);
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
        await dispatchCommand("/help", ctx);
        tuiState.showHelp = !tuiState.showHelp;
        break;

      case "/clear":
        tuiState.clearMessages();
        tuiState.saveCurrentSession();
        tuiState.showToast("Chat history cleared");
        tuiState.setStatus("Chat cleared");
        break;

      case "/agent": {
        tuiState.agentMode = tuiState.agentMode === "Build" ? "Plan" : "Build";
        const modeName = tuiState.agentMode === "Plan" ? "Planner" : "Builder";
        tuiState.showToast("Switched to " + modeName + " Mode");
        tuiState.setStatus("Mode: " + modeName);
        break;
      }

      case "/plan": {
        tuiState.agentMode = "Plan";
        tuiState.showToast("Switched to Planner Mode");
        tuiState.setStatus("Mode: Planner");
        tuiState.appendMessage({ role: "system", content: "→ Switched to Plan Mode. Generating plan..." });
        tuiState.requestRender();
        setTimeout(() => sendMessage("Please create a detailed checklist for the task in .toolnet/plan.md and wait for my /approve command before executing anything."), 50);
        return;
      }

      case "/approve": {
        tuiState.agentMode = "Build";
        tuiState.showToast("Plan Approved - Switched to Builder Mode");
        tuiState.setStatus("Mode: Builder");
        tuiState.appendMessage({ role: "system", content: "→ Plan approved. Switched to execution mode." });
        tuiState.requestRender();
        setTimeout(() => sendMessage("I approve the plan. You may now shift into execution mode and execute the checklist."), 50);
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
          tuiState.appendMessage({ role: "system", content: "Unknown command: " + name + "  (type /help)" });
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
