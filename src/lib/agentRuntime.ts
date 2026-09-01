import { getActiveProvider, getActiveBaseUrl, type Provider } from "../providers";
import { workspaceRoot, currentCwd } from "./codingAgent";
import { loadLocalSkills } from "./skillsLoader";
import { contextEngine } from "./context";
import { bypassEngine } from "./bypass";
import { getSandboxMode } from "./permissions";
import { getPermissionContextPrompt } from "./security/permissionContext";
import { getHarness, AgentHarness } from "./harness";
import type { ContextMessage } from "./context/types";

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
  const permissionContext = getPermissionContextPrompt(getSandboxMode());
  const basePrompt = `You are ToolNet Agent — a precise, tool-first AI coding assistant running in Toolnet CLI.

Active Workspace Root: ${workspaceRoot}
Current Working Directory: ${currentCwd}

${permissionContext}

Your access is strictly limited to the policy described in [RUNTIME PERMISSION CONTEXT] above. Never claim or rely on broader permissions than listed there.

${memorySnippet}

CORE RULES — follow strictly:
1. ALWAYS execute tools first. Never answer from memory about files, projects, paths, or system state.
2. When asked about a project → call get_cwd, list_dir (workspace root), read_file(package.json), read_file(README.md).
3. When asked to find a file or directory → call find_path. Do NOT use glob for 'tìm X', 'find X', 'where is X' queries.
4. When asked about an executable/install location → shell('command -v X'), then shell('readlink -f $(which X)').
5. Resolve all file paths relative to currentCwd unless an absolute path is given.
6. Only act within the permissions granted by [RUNTIME PERMISSION CONTEXT]. Actions outside them will be blocked by the sandbox.

FIND PATTERN:
- 'tìm thư mục X', 'find dir X', 'where is X', 'locate X' → find_path(X, root, 6, 'dir')
- 'tìm file X', 'find file X' → find_path(X, root, 6, 'file')
- executable location → shell('command -v X && readlink -f $(which X)')

FINAL ANSWER:
- Short and direct. State found paths explicitly.
- Provide copyable commands if relevant.
- Do NOT repeat raw tool output verbatim.
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


/**
 * Thin facade over the AgentHarness kernel.
 *
 * AgentRuntime is intentionally a lightweight wrapper: provider invocation,
 * context/compaction, SecurityEngine enforcement, executeToolBatch, ToolCache,
 * ToolOutputCompressor, loop detection, approval flow, EventBus, and session
 * persistence all live in AgentHarness. This class only maps the generic
 * kernel API onto the convenience run()/resume()/cancel() surface and the
 * legacy runLoop() contract.
 */
export class AgentRuntime {
  private harness: AgentHarness;

  constructor(options: AgentRuntimeOptions = {}) {
    const baseUrl = options.baseUrl || options.gatewayUrl || getActiveBaseUrl() || "http://localhost:8080";
    this.harness = new AgentHarness({
      model: options.model,
      baseUrl,
      maxTurns: options.maxTurns ?? 30,
      timeoutMs: options.timeoutMs ?? 60000,
    });

    if (options.onEvent) {
      const onEvent = options.onEvent;
      this.harness.on((evt) => {
        switch (evt.type) {
          case "tool:start":
            onEvent("TOOL_START", evt.payload);
            break;
          case "tool:complete":
          case "tool:error":
            onEvent("TOOL_END", evt.payload);
            break;
          case "agent:complete":
            onEvent("ASSISTANT_MESSAGE", { content: evt.payload?.output, role: "assistant" });
            break;
          case "agent:start":
            onEvent("AGENT_START", evt.payload);
            break;
          default:
            break;
        }
      });
    }
  }

  private mapResult(res: import("./harness/types").HarnessResult): AgentRuntimeResult {
    return {
      success: res.success,
      output: res.output,
      toolCallsCount: res.toolCallsCount,
      turnsUsed: res.turnsUsed,
      error: res.error,
    };
  }

  /**
   * Runs the full ReAct loop for a fresh user prompt.
   */
  async run(prompt: string, options: AgentRuntimeOptions = {}): Promise<AgentRuntimeResult> {
    const res = await this.harness.run(prompt, {
      model: options.model || "default",
      maxTurns: options.maxTurns,
      timeoutMs: options.timeoutMs,
    });
    return this.mapResult(res);
  }

  /**
   * Resumes the ReAct loop from an existing message history.
   */
  async resume(messages: Array<{ role: string; content: string; tool_calls?: any[]; tool_call_id?: string; name?: string }>, options: AgentRuntimeOptions = {}): Promise<AgentRuntimeResult> {
    const res = await this.harness.resume(messages as ContextMessage[], {
      model: options.model || "default",
      maxTurns: options.maxTurns,
      timeoutMs: options.timeoutMs,
    });
    return this.mapResult(res);
  }

  /**
   * Cancels the currently-running loop.
   */
  cancel(): void {
    this.harness.cancel();
  }

  /**
   * Executes a full ReAct tool loop for a user request (legacy API).
   * Can be invoked from REPL, TUI, or CLI headless mode.
   * Delegates to the AgentHarness kernel and syncs the resulting messages
   * back onto the caller's array so the previous in-place contract holds.
   */
  async runLoop(
    messages: Array<{ role: string; content: string; tool_calls?: any[]; tool_call_id?: string; name?: string }>,
    options: AgentRuntimeOptions = {}
  ): Promise<AgentRuntimeResult> {
    if (!messages.some((m) => m.role === "system")) {
      messages.unshift({ role: "system", content: getAgentSystemPrompt() });
    }

    const res = await this.harness.resume(messages as ContextMessage[], {
      model: options.model || "default",
      maxTurns: options.maxTurns,
      timeoutMs: options.timeoutMs,
    });

    // In-place sync so callers that read the passed-in array see the loop.
    messages.length = 0;
    messages.push(...(res.messages as any[]));

    return this.mapResult(res);
  }

  private harnessSnapshotModel(options: AgentRuntimeOptions): string | undefined {
    return options.model;
  }
}
