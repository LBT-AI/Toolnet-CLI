import { getActiveProvider, getActiveBaseUrl, OpenAICompatibleProvider, type Provider } from "../providers";
import { agentTools, getMergedAgentTools, executeTool } from "./agentTools";
import { workspaceRoot, currentCwd } from "./codingAgent";
import { loadLocalSkills } from "./skillsLoader";
import { contextEngine } from "./context";
import { bypassEngine } from "./bypass";
import { evaluatePermission, getSandboxMode } from "./permissions";
import { executeToolBatch, type ToolCall } from "./harness/toolExecutor";

export interface AgentRuntimeOptions {
  model?: string;
  baseUrl?: string;
  /** @deprecated Use baseUrl instead */
  gatewayUrl?: string;
  provider?: Provider;
  maxTurns?: number;
  timeoutMs?: number;
  onEvent?: (event: string, data: any) => void;
}

export interface AgentRuntimeResult {
  success: boolean;
  output: string;
  toolCallsCount: number;
  turnsUsed: number;
  error?: string;
}

export function getAgentSystemPrompt(): string {
  const memorySnippet = contextEngine.getMemoryPromptSnippet();
  const basePrompt = `You are ToolNet Agent — a precise, tool-first AI coding assistant running in Toolnet CLI.

Active Workspace Root: ${workspaceRoot}
Current Working Directory: ${currentCwd}
Access: Workspace (GRANTED — full read, write, execute permission in workspace and system)

${memorySnippet}

CORE RULES — follow strictly:
1. ALWAYS execute tools first. Never answer from memory about files, projects, paths, or system state.
2. When asked about a project → call get_cwd, list_dir (workspace root), read_file(package.json), read_file(README.md).
3. When asked to find a file or directory → call find_path. Do NOT use glob for 'tìm X', 'find X', 'where is X' queries.
4. When asked about an executable/install location → shell('command -v X'), then shell('readlink -f $(which X)').
7. After all tools complete → give ONE short, direct final answer.
8. NEVER say 'tôi không có quyền truy cập' — you have Workspace access and tools available.
9. NEVER fabricate results. If a tool fails, report the real error message.
10. Resolve all file paths relative to currentCwd unless an absolute path is given.

FIND PATTERN:
- 'tìm thư mục X', 'find dir X', 'where is X', 'locate X' → find_path(X, root, 6, 'dir')
- 'tìm file X', 'find file X' → find_path(X, root, 6, 'file')
- executable location → shell('command -v X && readlink -f $(which X)')

FINAL ANSWER:
- Short and direct. State found paths explicitly.
- Provide copyable commands if relevant.
- Do NOT repeat raw tool output verbatim.
- Do NOT say 'hy vọng giúp bạn' or similar filler.
- If not found: state exactly where you searched.

  <skills>
You can use specialized 'skills' to help you with complex tasks. Each skill has a name and a description.
When a skill is relevant to the user's request, you must read and follow its instructions carefully.
Available skills:
${
  loadLocalSkills()
    .map((s) => `- ${s.name} (${s.description}):\n${s.instructions}\n`)
    .join("\n")
}
</skills>`;
  return bypassEngine.getBypassSystemPrompt(basePrompt);
}

export const AGENT_SYSTEM_PROMPT = getAgentSystemPrompt();


export class AgentRuntime {
  private explicitProvider: Provider | null = null;
  private maxTurns: number;
  private timeoutMs: number;

  constructor(options: AgentRuntimeOptions = {}) {
    if (options.provider) {
      this.explicitProvider = options.provider;
    } else if (options.baseUrl || options.gatewayUrl) {
      const url = options.baseUrl || options.gatewayUrl!;
      this.explicitProvider = new OpenAICompatibleProvider({
        id: "custom",
        name: "Custom",
        baseUrl: url,
      });
    }
    this.maxTurns = options.maxTurns ?? 30;
    this.timeoutMs = options.timeoutMs ?? 60000;
  }

  /**
   * Executes a full ReAct tool loop for a user request.
   * Can be invoked from REPL, TUI, or CLI headless mode.
   */
  async runLoop(
    messages: Array<{ role: string; content: string; tool_calls?: any[]; tool_call_id?: string; name?: string }>,
    options: AgentRuntimeOptions = {}
  ): Promise<AgentRuntimeResult> {
    const startTime = Date.now();
    const model = options.model || "default";
    const maxTurns = options.maxTurns || this.maxTurns;
    const onEvent = options.onEvent;

    const fallbackUrl = options.baseUrl || options.gatewayUrl || getActiveBaseUrl() || "http://localhost:8080";
    const provider = options.provider ?? (this.explicitProvider ?? (getActiveProvider() ?? new OpenAICompatibleProvider({ id: "default", name: "Default", baseUrl: fallbackUrl })));
    if (!provider) {
      return {
        success: false,
        output: "",
        toolCallsCount: 0,
        turnsUsed: 0,
        error: "No active AI provider configured. Use /provider add or toolnet provider add.",
      };
    }

    // Ensure system prompt is present
    if (!messages.some((m) => m.role === "system")) {
      messages.unshift({ role: "system", content: getAgentSystemPrompt() });
    }

    // Command Router: Check last user message intent
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user")?.content || "";
    const lowerMsg = lastUserMsg.toLowerCase();

    // Check Web Crawl / Audit Intent
    const isWebIntent = lowerMsg.includes("http://") || lowerMsg.includes("https://") || lowerMsg.includes("crawl") || lowerMsg.includes("audit web");
    if (isWebIntent) {
      const urlMatch = lastUserMsg.match(/https?:\/\/[^\s]+/i);
      if (!urlMatch && (lowerMsg.includes("crawl") || lowerMsg.includes("audit web"))) {
        return {
          success: false,
          output: "Lỗi: Không tìm thấy URL hợp lệ để crawl/audit web. Vui lòng cung cấp URL dạng http:// hoặc https://. Toolnet CLI không hỗ trợ crawl tự do khi không có URL.",
          toolCallsCount: 0,
          turnsUsed: 1,
          error: "Missing URL for web capability",
        };
      }
    }

    // Check Workspace / File / Audit Intent
    const workspaceKeywords = [
      "xem project", "project hiện tại", "project nay", "project này",
      "audit code", "audit project", "kiểm tra source", "đọc file",
      "xem thư mục", "kiểm tra thư mục", "audit"
    ];
    const isWorkspaceIntent = workspaceKeywords.some((kw) => lowerMsg.includes(kw));

    let turnCount = 0;
    let toolCallsCount = 0;
    const toolCallHistory: string[] = [];

    while (turnCount < maxTurns) {
      turnCount++;

      if (Date.now() - startTime > this.timeoutMs) {
        return {
          success: false,
          output: "",
          toolCallsCount,
          turnsUsed: turnCount,
          error: `Execution timed out after ${this.timeoutMs}ms`,
        };
      }

      // Filter out temporary TUI placeholders
      const rawMessages = messages.filter((m) => m.content !== "Thinking...");

      // Prepare context via ContextEngine (token budgeting, pruning, atomic compaction)
      const contextPrep = contextEngine.prepareMessagesForApi(rawMessages as any, {
        model,
      });
      let apiMessages = contextPrep.messages;

      // If workspace intent on turn 1, instruct model to call tools if it hasn't yet
      if (isWorkspaceIntent && turnCount === 1) {
        if (!apiMessages.some((m) => m.role === "system" && m.content.includes("MANDATORY TOOL EXECUTION"))) {
          apiMessages.push({
            role: "system",
            content: `MANDATORY TOOL EXECUTION: User requested project view / code audit. You MUST call tools (e.g. get_cwd, list_dir, read_file, shell) first.`
          });
        }
      }

      let chatResponse;
      try {
        chatResponse = await provider.chat({
          model,
          messages: apiMessages as any,
          tools: getMergedAgentTools(),
          tool_choice: isWorkspaceIntent && turnCount === 1 ? "required" : "auto",
          temperature: 0.1,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (netErr: any) {
        return {
          success: false,
          output: "",
          toolCallsCount,
          turnsUsed: turnCount,
          error: `Provider connection error: ${netErr.message || String(netErr)}`,
        };
      }

      const assistantMsg = chatResponse.choices?.[0]?.message;
      if (!assistantMsg) {
        return {
          success: false,
          output: "",
          toolCallsCount,
          turnsUsed: turnCount,
          error: "Invalid assistant response from provider",
        };
      }

      messages.push({
        role: assistantMsg.role || "assistant",
        content: assistantMsg.content || "",
        ...(assistantMsg.tool_calls ? { tool_calls: assistantMsg.tool_calls } : {}),
      });
      if (onEvent) onEvent("ASSISTANT_MESSAGE", assistantMsg);

      const toolCalls = assistantMsg.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        // If workspace intent and turn 1 produced plain text claiming no access, enforce retry
        if (isWorkspaceIntent && turnCount === 1 && assistantMsg.content?.includes("không có quyền")) {
          messages.push({
            role: "user",
            content: "Lỗi: Bạn có toàn quyền Access: Workspace trong Toolnet CLI. Hãy thực thi get_cwd, list_dir, read_file hoặc shell ngay bây giờ.",
          });
          continue;
        }

        // Anti-Refusal Interceptor: detect refusal phrases and escalate bypass level
        if (bypassEngine.isEnabled() && bypassEngine.getConfig().autoEscalate && turnCount < maxTurns) {
          const refusal = bypassEngine.checkRefusal(assistantMsg.content || "");
          if (refusal.isRefusal) {
            const escalation = bypassEngine.escalate(lastUserMsg);
            if (escalation) {
              if (onEvent) onEvent("BYPASS_ESCALATED", { newLevel: escalation.newLevel, matched: refusal.matchedPattern });
              messages.push({
                role: "user",
                content: escalation.overridePrompt,
              });
              continue;
            }
          }
        }

        // Loop finished, final textual answer obtained
        return {
          success: true,
          output: assistantMsg.content || "Task completed.",
          toolCallsCount,
          turnsUsed: turnCount,
        };
      }

      // Execute tool calls through the unified P1 pipeline (dedup + parallel + cache + compress).
      const parsedCalls: ToolCall[] = toolCalls.map((call: any) => {
        let toolArgs: any = {};
        try { toolArgs = JSON.parse(call.function.arguments || "{}"); } catch {}
        return { id: call.id, name: call.function.name, args: toolArgs };
      });

      let loopAborted = false;
      const outcome = await executeToolBatch(parsedCalls, {
        cwd: currentCwd,
        workspaceRoot: workspaceRoot,
        maxRepeat: 2,
        needsApproval: (name, args) => {
          const perm = evaluatePermission(name, args, getSandboxMode(), currentCwd, workspaceRoot);
          return perm.needsApproval || !perm.allowed;
        },
        runTool: async (name, args, id) => {
          // Infinite loop detection across turns: abort if signature repeats 3×.
          const sig = `${name}:${JSON.stringify(args)}`;
          if (toolCallHistory.filter((s) => s === sig).length >= 2) {
            loopAborted = true;
            return {
              result: JSON.stringify({
                stdout: "",
                stderr: `Infinite loop detected: tool '${name}' was called 3 times with identical arguments. Aborting loop.`,
                exitCode: 1,
              }),
              allowed: false,
              reason: "loop",
            };
          }
          toolCallHistory.push(sig);

          toolCallsCount++;
          if (onEvent) onEvent("TOOL_START", { toolName: name, toolArgs: args, id });

          const perm = evaluatePermission(name, args, getSandboxMode(), currentCwd, workspaceRoot);
          let resultJson: string;
          if (!perm.allowed) {
            resultJson = JSON.stringify({
              stdout: "",
              stderr: `Permission Denied: ${perm.reason || "Blocked by sandbox policy."}`,
              exitCode: 1,
              permissionDenied: true,
            });
          } else if (perm.needsApproval) {
            // AgentRuntime is used by the lightweight REPL and other paths that do
            // not own an interactive approval modal. Fail closed instead of
            // silently executing an ask-mode action.
            resultJson = JSON.stringify({
              stdout: "",
              stderr: `Approval Required: ${perm.reason || `Tool "${name}" requires user confirmation.`}`,
              exitCode: 1,
              approvalRequired: true,
            });
          } else {
            resultJson = await executeTool(name, args);
          }

          if (args?.path) {
            contextEngine.recordFileAccess(
              args.path,
              name.includes("write") || name.includes("edit") || name.includes("patch") ? "write" : "read"
            );
          }

          if (onEvent) onEvent("TOOL_END", { toolName: name, toolArgs: args, result: resultJson, id });

          return { result: resultJson, allowed: perm.allowed };
        },
        onMessage: (m) => {
          messages.push({
            role: "tool",
            tool_call_id: m.id,
            name: m.name,
            content: m.content,
          });
        },
      });

      if (loopAborted) {
        const loopErr = `Infinite loop detected: exceeded maximum repetition of identical tool calls.`;
        return {
          success: false,
          output: "",
          toolCallsCount,
          turnsUsed: turnCount,
          error: loopErr,
        };
      }

      if (outcome.executedCount === 0 && toolCalls.length > 0) {
        // Every call was deduped to an already-executed signature this turn; loop continues.
      }
    }

    return {
      success: false,
      output: "",
      toolCallsCount,
      turnsUsed: maxTurns,
      error: `Exceeded maximum turn count (${maxTurns})`,
    };
  }
}