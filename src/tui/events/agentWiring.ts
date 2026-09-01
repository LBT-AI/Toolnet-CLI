import * as fs from "node:fs";
import * as path from "node:path";
import { tuiState } from "../state";
import { getCwdInfo } from "../../lib/codingAgent";
import { getCliKey, loadCliKeys } from "../../lib/keys";
import { contextEngine } from "../../lib/context";
import { parseAndProcessInput } from "../../lib/attachments";
import { getMergedAgentTools, executeTool } from "../../lib/agentTools";
import { getAgentSystemPrompt } from "../../lib/agentRuntime";
import { evaluatePermission, getSandboxMode } from "../../lib/permissions";
import { executeToolBatch, type ToolCall, type BatchRunResult } from "../../lib/harness/toolExecutor";
import { requestApprovalModal } from "../permissions/permissionModal";
import { dispatchCommand } from "../../commands";
import { loadSession, formatExitMessage } from "../../lib/sessionPersistence";
import { A } from "../../term";
import { updateCrashToolResult, markCleanExit } from "../../lib/crashRecovery";
import { restoreTerminal } from "../../lib/terminalLifecycle";
import { getGlobalTracker } from "../../lib/usage";
import { pluginManager } from "../../lib/plugins/pluginManager";
import { getActiveProvider, getActiveApiKey, getActiveDefaultModel } from "../../providers";
import { statusManager } from "../statusService";
import { messageQueue } from "../../lib/messageQueue";
import { providerPicker } from "../../components/ProviderPicker";

const PLANNER_SYSTEM_PROMPT = `You are ToolNet Planner. Your goal is to analyze the user request, explore the codebase using read-only tools, and create a step-by-step plan. Do not execute the plan yourself. Use the save_plan tool to save the plan.`;

async function handleSavePlan(parsedArgs: any): Promise<string> {
  const cwd = getCwdInfo().currentCwd;
  const toolnetDir = path.join(cwd, ".toolnet");
  if (!fs.existsSync(toolnetDir)) fs.mkdirSync(toolnetDir);
  fs.writeFileSync(path.join(toolnetDir, "plan.md"), parsedArgs?.content || "");

  const confirmed = await new Promise<boolean>((resolve) => {
    tuiState.pendingConfirmation = { prompt: "Plan generated. Approve and switch to Build mode?", resolve };
    tuiState.requestRender();
  });
  if (confirmed) {
    tuiState.agentMode = "Build";
    return JSON.stringify({ stdout: "Plan saved to .toolnet/plan.md. Switched to Build mode.", exitCode: 0 });
  }
  return JSON.stringify({ error: "User denied the plan." });
}

export async function sendMessage(text: string): Promise<void> {
  if (!text.trim()) return;

  if (text.startsWith("/")) {
    await handleSlashCommand(text.trim());
    return;
  }

  messageQueue.setIsProcessing(true);

  tuiState.messages.push({ role: "user", content: text });
  tuiState.messages.push({ role: "assistant", content: "" });
  tuiState.saveCurrentSession();
  let assistantIdx = tuiState.messages.length - 1;

  tuiState.scrollOffset = 0;
  statusManager.start("Thinking…");
  let isReceivingStream = false;

  tuiState.abortController = new AbortController();

  pluginManager.triggerAgentStart({ sessionId: tuiState.currentSessionId, prompt: text });

  try {
    let continueAgentLoop = true;
    while (continueAgentLoop) {
      continueAgentLoop = false;
      tuiState.setStatus("Calling API…");

      // Resolve provider for this request
      const provider = getActiveProvider();
      if (!provider) {
        stopSpinner();
        tuiState.messages.push({ role: "assistant", content: "✖ Error: No provider configured. Use /provider add to set one up." });
        tuiState.setStatus("✖ No provider configured");
        tuiState.requestRender();
        return;
      }

      const extraHeaders: Record<string, string> = {};
      if (tuiState.bypassMode) {
        extraHeaders["x-bypass-toolnet"] = "true";
        extraHeaders["x-bypass-level"] = tuiState.bypassLevel;
      }

      const autoPrep = contextEngine.prepareMessagesForApi(tuiState.messages as any, { model: tuiState.currentModel });
      if (autoPrep.compacted) {
        tuiState.messages = autoPrep.messages;
        tuiState.saveCurrentSession();
      }

      const apiMessages = tuiState.messages.filter((m, i) => i !== assistantIdx).map((m) => {
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

      if (!apiMessages.some((m) => m.role === "system" && !m.content.startsWith("→") && !m.content.startsWith("Unknown"))) {
        apiMessages.unshift({ role: "system", content: tuiState.agentMode === "Plan" ? PLANNER_SYSTEM_PROMPT : getAgentSystemPrompt() });
      }

      // Merge plugin tools
      const pluginTools = pluginManager.getRegisteredTools();
      const allTools = [...getMergedAgentTools(), ...pluginTools];

      let toolsForRequest: any[] | undefined = undefined;
      let toolChoiceForRequest: any = undefined;

      if (tuiState.agentMode === "Build") {
        toolsForRequest = allTools;
        toolChoiceForRequest = "auto";
      } else if (tuiState.agentMode === "Plan") {
        const planTools = allTools.filter((t: any) =>
          ["read_file", "grep", "grep_search", "glob", "glob_search", "find_path", "list_dir", "tree", "file_exists", "get_cwd", "web_fetch"].includes(t.function.name)
        );
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
        toolsForRequest = planTools;
        toolChoiceForRequest = "auto";
      }

      tuiState.setStatus("Streaming response…");
      isReceivingStream = true;

      let fullText = "";
      const toolCallsMap: Record<number, any> = {};

      if (typeof provider.stream === "function") {
        const streamIter = provider.stream({
          model: tuiState.currentModel || getActiveDefaultModel() || "default",
          messages: apiMessages,
          tools: toolsForRequest,
          tool_choice: toolChoiceForRequest,
          headers: extraHeaders,
          signal: tuiState.abortController?.signal,
        });

        for await (const chunk of streamIter) {
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            fullText += delta.content;
            tuiState.messages[assistantIdx] = { role: "assistant", content: fullText + "▊" };
            tuiState.scrollOffset = 0;
          }
          if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
            for (const _tc of delta.tool_calls) {
              const tc = _tc as unknown as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
              const idx = (tc.index ?? 0) as number;
              if (!toolCallsMap[idx]) {
                toolCallsMap[idx] = { id: tc.id || `call_${idx}`, type: "function", function: { name: tc.function?.name || "", arguments: "" } };
              }
              if (tc.function?.arguments) {
                toolCallsMap[idx].function.arguments += tc.function.arguments;
              }
            }
          }
          if (chunk.usage) {
            const u = chunk.usage;
            tuiState.lastTokens = `${u.prompt_tokens || 0} \u2192 ${u.completion_tokens || 0} (${u.total_tokens || 0})`;
            const tracker = getGlobalTracker();
            tracker.recordUsage({
              inputTokens: u.prompt_tokens || 0,
              outputTokens: u.completion_tokens || 0,
              model: tuiState.currentModel,
            });
          }
        }
      } else {
        const chatRes = await provider.chat({
          model: tuiState.currentModel || getActiveDefaultModel() || "default",
          messages: apiMessages,
          tools: toolsForRequest,
          tool_choice: toolChoiceForRequest,
          headers: extraHeaders,
          signal: tuiState.abortController?.signal,
        });
        const msg = chatRes.choices?.[0]?.message;
        if (msg?.content) fullText = msg.content;
        if (msg?.tool_calls) {
          msg.tool_calls.forEach((tc, idx) => {
            toolCallsMap[idx] = tc;
          });
        }
        if (chatRes.usage) {
          const u = chatRes.usage;
          tuiState.lastTokens = `${u.prompt_tokens || 0} \u2192 ${u.completion_tokens || 0} (${u.total_tokens || 0})`;
        }
      }

      const toolCallsArr = Object.values(toolCallsMap);

      if (toolCallsArr.length > 0) {
        tuiState.messages[assistantIdx] = {
          role: "assistant",
          content: "",
          tool_calls: toolCallsArr,
        };
        tuiState.requestRender();

        const cwd = getCwdInfo().currentCwd;
        const parsedCalls: ToolCall[] = toolCallsArr.map((tc: any) => {
          let a: any = {};
          try { a = JSON.parse(tc.function.arguments || "{}"); } catch {}
          return { id: tc.id, name: tc.function.name, args: a };
        });

        const runTool = async (name: string, args: any, id: string): Promise<BatchRunResult> => {
          statusManager.updateTool(name, args);
          if (name === "save_plan") {
            const r = await handleSavePlan(args);
            return { result: r, allowed: true };
          }

          const perm = evaluatePermission(name, args, getSandboxMode(), cwd);
          if (!perm.allowed) {
            return {
              result: JSON.stringify({ error: `Permission Denied: ${perm.reason || "Blocked by sandbox policy."}` }),
              allowed: false,
            };
          }
          if (perm.needsApproval) {
            const ok = await requestApprovalModal(
              perm.reason ? `${perm.reason}` : `Tool ${name} requires permission`,
              args
            );
            if (!ok) {
              return { result: JSON.stringify({ error: "User denied permission." }), allowed: false };
            }
          }

          // Check if it's a plugin tool
          if (pluginTools.some((pt) => pt.function.name === name)) {
            const pluginRes = await pluginManager.executePluginTool(name, args, cwd);
            if (pluginRes.error) {
              return { result: JSON.stringify({ error: pluginRes.error }), allowed: false };
            }
            return { result: typeof pluginRes.result === "string" ? pluginRes.result : JSON.stringify(pluginRes.result), allowed: true };
          }

          const result = await executeTool(name, args, { cwd });
          updateCrashToolResult(name, 0, `Executed ${name}`);

          if (args?.path) {
            contextEngine.recordFileAccess(
              args.path,
              name.includes("write") || name.includes("edit") || name.includes("patch") ? "write" : "read"
            );
          }
          return { result, allowed: true };
        };

        const outcome = await executeToolBatch(parsedCalls, {
          cwd,
          needsApproval: (name, args) => {
            const p = evaluatePermission(name, args, getSandboxMode(), cwd);
            return p.needsApproval || !p.allowed;
          },
          runTool,
          onMessage: (m) => {
            tuiState.messages.push({ role: "tool", tool_call_id: m.id, name: m.name, content: m.content });
            tuiState.saveCurrentSession();
          },
        });

        if (outcome.executedCount > 0) {
          tuiState.setStatus(
            `Executed ${toolCallsArr.length} tool call(s) — ${outcome.deduplicatedCount} deduplicated, ${outcome.parallelBatches} parallel batch(es)`
          );
        }

        tuiState.messages.push({ role: "assistant", content: "" });
        assistantIdx = tuiState.messages.length - 1;
        tuiState.saveCurrentSession();
        continueAgentLoop = true;
      } else {
        const finalContent = fullText || "(empty response)";
        tuiState.messages[assistantIdx] = { role: "assistant", content: finalContent };
        tuiState.saveCurrentSession();
        tuiState.requestRender();
      }
    }

    tuiState.scrollOffset = 0;
    statusManager.done();
  } catch (err: any) {
    if (err?.name === "AbortError") {
      statusManager.cancel();
      tuiState.messages.push({ role: "assistant", content: "(cancelled)" });
    } else {
      statusManager.failed(err?.message || String(err));
      tuiState.messages.push({ role: "assistant", content: "✖ Error: " + (err?.message || String(err)) });
      tuiState.showToast("⚠️ " + (err?.message || String(err)), 3500);
    }
    tuiState.saveCurrentSession();
  } finally {
    tuiState.abortController = null;
    pluginManager.triggerAgentEnd({ sessionId: tuiState.currentSessionId });

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

export function buildTuiCommandContext(): any {
  return {
    addMessage: (role: "user" | "assistant" | "system", content: string) => {
      tuiState.messages.push({ role, content });
    },
    setModel: (m: string) => {
      tuiState.currentModel = m;
      tuiState.setStatus("Model: " + m);
    },
    setStatusMsg: (s: string) => tuiState.setStatus(s),
    exit: () => {
      process.stdout.write("Goodbye!\r\n");
      process.exit(0);
    },
    currentModel: () => tuiState.currentModel,
    openModelPicker: () => tuiState.openModelPicker(),
    openKeyManager: () => tuiState.openKeyManager(),
    openProviderPicker: () => providerPicker.open((s) => tuiState.setStatus(s), () => tuiState.requestRender()),
    openSkillsPicker: (initialSkillName?: string) => tuiState.openSkillsPicker(initialSkillName),
    openQueueManager: () => tuiState.openQueueManager(),
    openSessionPicker: () => tuiState.openSessionPicker(),
    setBypassMode: (enabled: boolean, level?: string) => {
      tuiState.bypassMode = enabled;
      if (level) tuiState.bypassLevel = level as any;
      tuiState.showToast(enabled ? `Bypass Mode ENABLED (${tuiState.bypassLevel.toUpperCase()})` : "Bypass Mode DISABLED");
      tuiState.setStatus(`Bypass Mode: ${enabled ? "ON" : "OFF"}${level ? ` (${level})` : ""}`);
      tuiState.requestRender();
    },
    getCurrentSessionId: () => tuiState.currentSessionId,
    setCurrentSessionId: (id: string) => { tuiState.currentSessionId = id; },
    getMessages: () => tuiState.messages,
    setMessages: (msgs: any[]) => { tuiState.messages = msgs; tuiState.saveCurrentSession(); },
    clearMessages: () => { tuiState.messages = []; tuiState.saveCurrentSession(); },
    switchSession: (sessionId: string) => {
      const loaded = loadSession(sessionId);
      if (!loaded) return false;
      tuiState.currentSessionId = loaded.sessionId;
      tuiState.messages = loaded.messages as any;
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
          tuiState.messages.push({ role: "assistant", content: `Model set to: ${modelArg}` });
        } else if (modelArg === "--help") {
          tuiState.messages.push({
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
        tuiState.messages = [];
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
        tuiState.messages.push({ role: "system", content: "→ Switched to Plan Mode. Generating plan..." });
        tuiState.requestRender();
        setTimeout(() => sendMessage("Please create a detailed checklist for the task in .toolnet/plan.md and wait for my /approve command before executing anything."), 50);
        return;
      }

      case "/approve": {
        tuiState.agentMode = "Build";
        tuiState.showToast("Plan Approved - Switched to Builder Mode");
        tuiState.setStatus("Mode: Builder");
        tuiState.messages.push({ role: "system", content: "→ Plan approved. Switched to execution mode." });
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

      default: {
        const handled = await dispatchCommand(cmd, ctx);
        if (!handled) {
          tuiState.messages.push({ role: "system", content: "Unknown command: " + name + "  (type /help)" });
        }
        break;
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    tuiState.setStatus(`⚠️ Command failed: ${errMsg}`);
    tuiState.showToast(`⚠️ Command error: ${errMsg}`, 3000);
    tuiState.messages.push({ role: "system", content: `✖ Command error: ${errMsg}` });
  }

  tuiState.requestRender();
}
