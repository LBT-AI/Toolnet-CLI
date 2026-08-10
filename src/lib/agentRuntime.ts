import { detectGatewayUrl } from "./gateway";
import { agentTools, getMergedAgentTools, executeTool } from "./agentTools";
import { workspaceRoot, currentCwd } from "./codingAgent";
import { loadLocalSkills } from "./skillsLoader";

export interface AgentRuntimeOptions {
  model?: string;
  gatewayUrl?: string;
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
  return `You are ToolNet Agent — a precise, tool-first AI coding assistant running in Toolnet CLI.

Active Workspace Root: ${workspaceRoot}
Current Working Directory: ${currentCwd}
Access: Workspace (GRANTED — full read, write, execute permission in workspace and system)

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
}

export const AGENT_SYSTEM_PROMPT = getAgentSystemPrompt();


export class AgentRuntime {
  private gatewayUrl: string;
  private maxTurns: number;
  private timeoutMs: number;

  constructor(options: AgentRuntimeOptions = {}) {
    this.gatewayUrl = options.gatewayUrl || detectGatewayUrl();
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
      let apiMessages = messages.filter((m) => m.content !== "Thinking...");

      // Sliding window context truncation
      const MAX_CONTEXT_CHARS = 32000;
      let totalLength = apiMessages.reduce((sum, m) => sum + (m.content ? m.content.length : 0), 0);
      if (totalLength > MAX_CONTEXT_CHARS && apiMessages.length > 2) {
        const sys = apiMessages[0];
        const rest = apiMessages.slice(1);
        while (totalLength > MAX_CONTEXT_CHARS && rest.length > 2) {
          const removed = rest.shift();
          totalLength -= (removed?.content?.length || 0);
        }
        apiMessages = [sys, ...rest];
      }

      // If workspace intent on turn 1, instruct model to call tools if it hasn't yet
      if (isWorkspaceIntent && turnCount === 1) {
        if (!apiMessages.some((m) => m.role === "system" && m.content.includes("MANDATORY TOOL EXECUTION"))) {
          apiMessages.push({
            role: "system",
            content: `MANDATORY TOOL EXECUTION: User requested project view / code audit. You MUST call tools (e.g. get_cwd, list_dir, read_file, shell) first.`
          });
        }
      }

      let response: Response;
      try {
        response = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: apiMessages,
            tools: getMergedAgentTools(),
            tool_choice: isWorkspaceIntent && turnCount === 1 ? "required" : "auto",
            temperature: 0.1,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (netErr: any) {
        return {
          success: false,
          output: "",
          toolCallsCount,
          turnsUsed: turnCount,
          error: `Gateway connection error: ${netErr.message}`,
        };
      }

      if (!response.ok) {
        const errText = await response.text();
        return {
          success: false,
          output: "",
          toolCallsCount,
          turnsUsed: turnCount,
          error: `HTTP ${response.status}: ${errText}`,
        };
      }

      const data = await response.json();
      const assistantMsg = data.choices?.[0]?.message;

      if (!assistantMsg) {
        return {
          success: false,
          output: "",
          toolCallsCount,
          turnsUsed: turnCount,
          error: "Invalid assistant response from model gateway",
        };
      }

      messages.push(assistantMsg);
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

        // Loop finished, final textual answer obtained
        return {
          success: true,
          output: assistantMsg.content || "Task completed.",
          toolCallsCount,
          turnsUsed: turnCount,
        };
      }

      // Execute tool calls
      for (const call of toolCalls) {
        const toolName = call.function.name;
        const toolArgsStr = call.function.arguments || "{}";
        let toolArgs: any = {};
        try {
          toolArgs = JSON.parse(toolArgsStr);
        } catch {}

        // Infinite loop detection: trigger abort if the same call signature appears 3 times
        const callSignature = `${toolName}:${JSON.stringify(toolArgs)}`;
        const repeatCount = toolCallHistory.filter((sig) => sig === callSignature).length;
        if (repeatCount >= 2) {
          const loopErr = `Infinite loop detected: tool '${toolName}' was called 3 times with identical arguments. Aborting loop.`;
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: toolName,
            content: JSON.stringify({ stdout: "", stderr: loopErr, exitCode: 1 }),
          });
          return {
            success: false,
            output: "",
            toolCallsCount,
            turnsUsed: turnCount,
            error: loopErr,
          };
        }
        toolCallHistory.push(callSignature);

        toolCallsCount++;
        if (onEvent) onEvent("TOOL_START", { toolName, toolArgs, id: call.id });

        const resultJson = await executeTool(toolName, toolArgs);

        if (onEvent) onEvent("TOOL_END", { toolName, toolArgs, result: resultJson, id: call.id });

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: toolName,
          content: resultJson,
        });
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
