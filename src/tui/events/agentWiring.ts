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
import { GatewayClient } from "../../lib/gateway";
import { loadSession } from "../../lib/sessionPersistence";
import { A } from "../../term";
import { updateCrashToolResult } from "../../lib/crashRecovery";
import { getGlobalTracker } from "../../lib/usage";
import { pluginManager } from "../../lib/plugins/pluginManager";

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

  tuiState.messages.push({ role: "user", content: text });
  tuiState.messages.push({ role: "assistant", content: "" });
  tuiState.saveCurrentSession();
  let assistantIdx = tuiState.messages.length - 1;

  tuiState.scrollOffset = 0;
  tuiState.startTime = Date.now();
  tuiState.elapsedDisplay = "";
  tuiState.setStatus("Thinking…");
  tuiState.isStreaming = true;
  let isReceivingStream = false;

  tuiState.abortController = new AbortController();

  tuiState.spinnerTimer = setInterval(() => {
    tuiState.spinnerIdx = (tuiState.spinnerIdx + 1) % 10;
    const elapsed = ((Date.now() - tuiState.startTime) / 1000).toFixed(1);
    tuiState.elapsedDisplay = "  " + elapsed + "s";
    if (!isReceivingStream) {
      tuiState.messages[assistantIdx].content =
        A.fgYellow + ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"][tuiState.spinnerIdx] + " " + A.fgSubtext + tuiState.statusText + A.reset;
    }
    tuiState.requestRender();
  }, 100);

  pluginManager.triggerAgentStart({ sessionId: tuiState.currentSessionId, prompt: text });

  try {
    let continueAgentLoop = true;
    while (continueAgentLoop) {
      continueAgentLoop = false;
      tuiState.setStatus("Calling API…");

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (tuiState.bypassMode) {
        headers["x-bypass-toolnet"] = "true";
        headers["x-bypass-level"] = tuiState.bypassLevel;
      }

      const providerStr = tuiState.currentModel.includes("/") ? tuiState.currentModel.split("/")[0] : tuiState.currentModel;
      let localKey = getCliKey(providerStr);
      if (!localKey) {
        localKey = getCliKey("toolnet") || getCliKey("gateway") || getCliKey("default");
      }
      if (localKey) {
        headers["Authorization"] = `Bearer ${localKey}`;
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

      const bodyPayload: any = {
        model: tuiState.currentModel,
        messages: apiMessages,
        stream: true,
      };

      if (tuiState.agentMode === "Build") {
        bodyPayload.tools = allTools;
        bodyPayload.tool_choice = "auto";
      } else if (tuiState.agentMode === "Plan") {
        bodyPayload.tools = allTools.filter((t: any) =>
          ["read_file", "grep", "grep_search", "glob", "glob_search", "find_path", "list_dir", "tree", "file_exists", "get_cwd", "web_fetch"].includes(t.function.name)
        );
        bodyPayload.tools.push({
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
      }

      const res = await fetch(tuiState.gatewayUrl + "/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify(bodyPayload),
        signal: tuiState.abortController?.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        let errMsg = `HTTP ${res.status}`;
        try {
          const j = JSON.parse(errText);
          errMsg = j.error?.message || errMsg;
        } catch {}
        stopSpinner();
        tuiState.messages.push({ role: "assistant", content: "✖ Error: " + errMsg });
        tuiState.setStatus("✖ " + errMsg);
        tuiState.requestRender();
        return;
      }

      if (!res.body) {
        stopSpinner();
        tuiState.messages.push({ role: "assistant", content: "✖ Error: No response body" });
        tuiState.setStatus("✖ No response body");
        tuiState.requestRender();
        return;
      }

      tuiState.setStatus("Streaming response…");
      isReceivingStream = true;

      let fullText = "";
      const toolCallsMap: Record<number, any> = {};
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";

        for (const line of parts) {
          const t = line.trim();
          if (!t || t === "data: [DONE]") continue;
          if (t.startsWith("data: ")) {
            try {
              const json = JSON.parse(t.slice(6));
              const delta = json.choices?.[0]?.delta;
              if (delta?.content) {
                fullText += delta.content;
                tuiState.messages[assistantIdx] = { role: "assistant", content: fullText + "▊" };
                tuiState.scrollOffset = 0;
              }
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index;
                  if (!toolCallsMap[idx]) {
                    toolCallsMap[idx] = { id: tc.id, type: "function", function: { name: tc.function?.name || "", arguments: "" } };
                  }
                  if (tc.function?.arguments) {
                    toolCallsMap[idx].function.arguments += tc.function.arguments;
                  }
                }
              }
              if (json.usage) {
                const u = json.usage;
                tuiState.lastTokens = `${u.prompt_tokens || 0} \u2192 ${u.completion_tokens || 0} (${u.total_tokens || 0})`;
                const tracker = getGlobalTracker();
                tracker.recordUsage({
                  inputTokens: u.prompt_tokens || 0,
                  outputTokens: u.completion_tokens || 0,
                  model: tuiState.currentModel,
                });
              }
            } catch {}
          }
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
          if (name === "save_plan") {
            const r = await handleSavePlan(args);
            return { result: r, allowed: true };
          }

          // Check if it's a plugin tool
          if (pluginTools.some((pt) => pt.function.name === name)) {
            const pluginRes = await pluginManager.executePluginTool(name, args, cwd);
            if (pluginRes.error) {
              return { result: JSON.stringify({ error: pluginRes.error }), allowed: false };
            }
            return { result: typeof pluginRes.result === "string" ? pluginRes.result : JSON.stringify(pluginRes.result), allowed: true };
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
          const result = await executeTool(name, args, { cwd, skipPermission: true });
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
        tuiState.messages[assistantIdx] = { role: "assistant", content: A.fgGreen + "✔ " + A.reset + finalContent };
        tuiState.saveCurrentSession();
        setTimeout(() => {
          if (tuiState.messages[assistantIdx]) {
            tuiState.messages[assistantIdx].content = finalContent;
            tuiState.requestRender();
          }
        }, 1500);
      }
    }

    tuiState.scrollOffset = 0;
    stopSpinner();
    const elapsed = ((Date.now() - tuiState.startTime) / 1000).toFixed(1);
    tuiState.setStatus(`✔ Done in ${elapsed}s`);
    tuiState.elapsedDisplay = "";
  } catch (err: any) {
    stopSpinner();
    if (err?.name === "AbortError") {
      tuiState.messages.push({ role: "assistant", content: "(cancelled)" });
    } else {
      tuiState.messages.push({ role: "assistant", content: "✖ Error: " + (err?.message || String(err)) });
    }
    tuiState.saveCurrentSession();
  } finally {
    tuiState.abortController = null;
    pluginManager.triggerAgentEnd({ sessionId: tuiState.currentSessionId });
  }

  tuiState.requestRender();
}

function stopSpinner(): void {
  if (tuiState.spinnerTimer) {
    clearInterval(tuiState.spinnerTimer);
    tuiState.spinnerTimer = null;
  }
  tuiState.isStreaming = false;
}

export async function handleSlashCommand(cmd: string): Promise<void> {
  const parts = cmd.split(" ");
  const name = parts[0].toLowerCase();

  switch (name) {
    case "/exit":
    case "/quit":
      process.stdout.write("Goodbye!\r\n");
      process.exit(0);
      break;

    case "/help":
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
      tuiState.showToast("Switched to " + tuiState.agentMode + " Mode");
      tuiState.setStatus("Mode: " + tuiState.agentMode);
      break;
    }

    case "/plan": {
      tuiState.agentMode = "Plan";
      tuiState.showToast("Switched to Plan Mode");
      tuiState.setStatus("Mode: Plan");
      tuiState.messages.push({ role: "system", content: "→ Switched to Plan Mode. Generating plan..." });
      tuiState.requestRender();
      setTimeout(() => sendMessage("Please create a detailed checklist for the task in .toolnet/plan.md and wait for my /approve command before executing anything."), 50);
      return;
    }

    case "/approve": {
      tuiState.agentMode = "Build";
      tuiState.showToast("Plan Approved - Switched to Build Mode");
      tuiState.setStatus("Mode: Build");
      tuiState.messages.push({ role: "system", content: "→ Plan approved. Switched to execution mode." });
      tuiState.requestRender();
      setTimeout(() => sendMessage("I approve the plan. You may now shift into execution mode and execute the checklist."), 50);
      return;
    }

    case "/build": {
      tuiState.agentMode = "Build";
      tuiState.showToast("Switched to Build Mode");
      tuiState.setStatus("Mode: Build");
      break;
    }

    default: {
      const gw = new GatewayClient(tuiState.gatewayUrl);
      const ctx = {
        gateway: gw,
        addMessage: (role: "user" | "assistant" | "system", content: string) => {
          tuiState.messages.push({ role, content });
        },
        setModel: (m: string) => {
          tuiState.currentModel = m;
          tuiState.setStatus("Model: " + m);
        },
        setStatusMsg: (s: string) => tuiState.setStatus(s),
        exit: () => { process.stdout.write("Goodbye!\r\n"); process.exit(0); },
        currentModel: () => tuiState.currentModel,
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
          tuiState.saveCurrentSession();
          tuiState.setStatus(`Session: ${tuiState.currentSessionId}`);
          return true;
        },
        setAgentMode: (mode: "Build" | "Plan") => {
          tuiState.agentMode = mode;
          tuiState.setStatus("Mode: " + mode);
        },
      };

      const handled = await dispatchCommand(cmd, ctx);
      if (!handled) {
        tuiState.messages.push({ role: "system", content: "Unknown command: " + name + "  (type /help)" });
      }
      break;
    }
  }

  tuiState.requestRender();
}
