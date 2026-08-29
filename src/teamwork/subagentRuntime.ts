/**
 * Real Sub-Agent Execution Engine for ToolNet Teamwork v2
 * Target File: src/teamwork/subagentRuntime.ts
 */

import { getActiveProvider, getActiveBaseUrl, OpenAICompatibleProvider, type Provider } from "../providers";
import { agentTools, executeTool } from "../lib/agentTools";
import { workspaceRoot, currentCwd } from "../lib/codingAgent";
import { contextEngine, type ContextMessage } from "../lib/context";
import { getCliKey } from "../lib/keys";
import { evaluatePermission, getSandboxMode } from "../lib/permissions";
import { executeToolBatch, type ToolCall } from "../lib/harness/toolExecutor";
import type { AgentRole, TaskNode } from "./types";
import type { EventBus } from "./eventBus";

export interface SubagentOptions {
  model?: string;
  gatewayUrl?: string;
  baseUrl?: string;
  maxTurns?: number;
  timeoutMs?: number;
  eventBus?: EventBus;
  sessionId?: string;
  onEvent?: (event: string, data: any) => void;
}

export interface SubagentResult {
  success: boolean;
  output: string;
  toolCallsCount: number;
  turnsUsed: number;
  tokensUsed: number;
  role: AgentRole;
  nodeId: string;
  error?: string;
}

import fs from "node:fs";
import path from "node:path";

export function loadCustomPersonas(): Record<string, string> {
  try {
    const cwd = currentCwd || process.cwd();
    const personasFile = path.join(cwd, ".toolnet", "personas.json");
    if (fs.existsSync(personasFile)) {
      const raw = fs.readFileSync(personasFile, "utf8");
      return JSON.parse(raw);
    }
  } catch {}
  return {};
}

/**
 * Returns role-specific system prompts with strict operational guidelines.
 */
export function getSubagentRolePrompt(role: AgentRole, title: string): string {
  const baseMemory = contextEngine.getMemoryPromptSnippet();
  const customPersonas = loadCustomPersonas();

  const rolePrompts: Record<string, string> = {
    RESEARCHER: `You are ToolNet Sub-Agent [RESEARCHER].
Your goal is to inspect code, explore directory structures, search patterns, and gather architectural facts.
Guidelines:
1. Use read_file, grep, glob, find_path, and web_fetch to explore the workspace.
2. Synthesize your findings into a clear, concise, structured report.
3. Do NOT make file modifications or run destructive commands.
4. Conclude with concrete, actionable recommendations for Coder agents.`,

    CODER: `You are ToolNet Sub-Agent [CODER].
Your goal is to write, modify, and refactor code precisely according to requirements.
Guidelines:
1. Inspect target files before editing.
2. Use write_file, edit_file, or apply_patch to apply surgical code modifications.
3. Keep code clean, type-safe, and self-contained.
4. After completing code changes, provide a concise summary of modified files and functions.`,

    TESTER: `You are ToolNet Sub-Agent [TESTER].
Your goal is to verify correctness, run unit/integration tests, and validate build integrity.
Guidelines:
1. Run verification commands (bun test, npm test, tsc --noEmit, cargo test).
2. If tests fail, inspect the failure trace, identify root causes, and report exact line numbers.
3. Summarize test pass/fail statistics in your final response.`,

    REVIEWER: `You are ToolNet Sub-Agent [REVIEWER].
Your goal is to review code changes, audit security implications, and check code style.
Guidelines:
1. Inspect git_diff and read modified files.
2. Check for security vulnerabilities, memory leaks, unhandled exceptions, and edge cases.
3. Provide a structured review verdict (APPROVED / CHANGES REQUESTED) with actionable suggestions.`,

    ARCHITECT: `You are ToolNet Sub-Agent [ARCHITECT].
Your goal is high-level system design, module boundary formulation, and technical planning.
Guidelines:
1. Analyze existing project structure and dependency boundaries.
2. Produce modular, scalable component specifications.
3. Define clear interface contracts and data models.`,

    GENERAL: `You are ToolNet Autonomous Sub-Agent.
Your goal is to execute the designated task with maximum autonomy, using available tools efficiently.`,
    ...customPersonas,
  };

  const selectedRolePrompt = customPersonas[role] || rolePrompts[role] || rolePrompts.GENERAL;

  return `${selectedRolePrompt}

Current Task: "${title}"
Workspace Root: ${workspaceRoot}
Working Directory: ${currentCwd}

${baseMemory}

Operational Rules:
- Execute necessary tools immediately.
- Report exact facts without hallucinating.
- When finished, summarize your completed work and key outputs clearly.`;
}

/**
 * Returns filtered tools allowed for the specific agent role.
 */
export function getSubagentTools(role: AgentRole): any[] {
  const roleName = String(role).toUpperCase();

  if (roleName === "RESEARCHER") {
    const allowed = new Set([
      "read_file", "file_exists", "list_dir", "tree", "grep", "glob",
      "find_path", "web_fetch", "audit_url", "git_status", "git_diff", "get_cwd"
    ]);
    return agentTools.filter((t: any) => allowed.has(t.function?.name));
  }

  if (roleName === "TESTER") {
    const allowed = new Set([
      "read_file", "file_exists", "list_dir", "tree", "grep", "glob",
      "find_path", "shell", "run_command", "git_status", "git_diff", "get_cwd"
    ]);
    return agentTools.filter((t: any) => allowed.has(t.function?.name));
  }

  if (roleName === "REVIEWER") {
    const allowed = new Set([
      "read_file", "file_exists", "list_dir", "tree", "grep", "glob",
      "find_path", "git_status", "git_diff", "get_cwd"
    ]);
    return agentTools.filter((t: any) => allowed.has(t.function?.name));
  }

  // Coder, Architect, General get all tools
  return agentTools;
}

/**
 * Executes a real Sub-Agent task node using full LLM runtime with tool-calling capabilities.
 */
export async function executeSubagentTask(
  node: TaskNode,
  options: SubagentOptions = {}
): Promise<SubagentResult> {
  const role = (node.role || "CODER") as AgentRole;
  const maxTurns = options.maxTurns || node.maxTurns || 8;
  const timeoutMs = options.timeoutMs || 120000;
  const model = options.model || "default";
  const onEvent = options.onEvent;

  const fallbackUrl = options.gatewayUrl || options.baseUrl || getActiveBaseUrl() || "http://localhost:8080";
  const provider = getActiveProvider() ?? new OpenAICompatibleProvider({ id: "default", name: "Default", baseUrl: fallbackUrl });

  if (!provider) {
    return {
      success: false,
      output: "",
      toolCallsCount: 0,
      turnsUsed: 0,
      tokensUsed: 0,
      role,
      nodeId: node.id,
      error: "No active AI provider configured. Use /provider add or toolnet provider add.",
    };
  }

  const rolePrompt = getSubagentRolePrompt(role, node.title);
  const tools = getSubagentTools(role);

  const messages: ContextMessage[] = [
    { role: "system", content: rolePrompt },
    { role: "user", content: node.prompt || node.title },
  ];

  let toolCallsCount = 0;
  let turnsUsed = 0;
  let estimatedTokens = 0;
  const toolCallHistory: string[] = [];

  if (onEvent) {
    onEvent("subagent:start", { nodeId: node.id, role, title: node.title });
  }

  const startTime = Date.now();

  while (turnsUsed < maxTurns) {
    turnsUsed++;

    if (Date.now() - startTime > timeoutMs) {
      return {
        success: false,
        output: "",
        toolCallsCount,
        turnsUsed,
        tokensUsed: estimatedTokens,
        role,
        nodeId: node.id,
        error: `Sub-Agent execution timed out after ${timeoutMs}ms`,
      };
    }

    const prep = contextEngine.prepareMessagesForApi(messages, { model });
    estimatedTokens = prep.budget.currentEstimatedTokens;

    let chatRes;
    try {
      chatRes = await provider.chat({
        model,
        messages: prep.messages as any,
        tools,
        tool_choice: "auto",
        temperature: 0.1,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (netErr: any) {
      return {
        success: false,
        output: "",
        toolCallsCount,
        turnsUsed,
        tokensUsed: estimatedTokens,
        role,
        nodeId: node.id,
        error: `Gateway network error: ${netErr?.message || String(netErr)}`,
      };
    }

    const choice = chatRes.choices?.[0];
    const assistantMsg = choice?.message;
    if (!assistantMsg) {
      return {
        success: false,
        output: "",
        toolCallsCount,
        turnsUsed,
        tokensUsed: estimatedTokens,
        role,
        nodeId: node.id,
        error: "Invalid empty response from model provider",
      };
    }

    messages.push({
      role: assistantMsg.role || "assistant",
      content: assistantMsg.content || "",
      ...(assistantMsg.tool_calls ? { tool_calls: assistantMsg.tool_calls } : {}),
    });

    const toolCalls = assistantMsg.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      // Subagent finished execution turn
      const finalOutput = assistantMsg.content || `[Subagent ${role} finished task '${node.title}']`;
      if (onEvent) {
        onEvent("subagent:complete", { nodeId: node.id, role, output: finalOutput });
      }
      return {
        success: true,
        output: finalOutput,
        toolCallsCount,
        turnsUsed,
        tokensUsed: estimatedTokens,
        role,
        nodeId: node.id,
      };
    }

    // Execute requested tools through the unified P1 pipeline (dedup + parallel + cache + compress).
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
        const sig = `${name}:${JSON.stringify(args)}`;
        if (toolCallHistory.filter((s) => s === sig).length >= 2) {
          loopAborted = true;
          return {
            result: JSON.stringify({ error: `Infinite loop detected on '${name}'. Tool call aborted.` }),
            allowed: false,
            reason: "loop",
          };
        }
        toolCallHistory.push(sig);

        toolCallsCount++;
        if (onEvent) {
          onEvent("subagent:tool", { nodeId: node.id, role, toolName: name, toolArgs: args, id });
        }

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
          // Child agents cannot grant their own permissions. Any ask-mode action
          // that requires approval must be surfaced to the parent/user instead of
          // being executed silently.
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
      break;
    }
  }

  return {
    success: false,
    output: "",
    toolCallsCount,
    turnsUsed,
    tokensUsed: estimatedTokens,
    role,
    nodeId: node.id,
    error: `Sub-Agent exceeded maximum turns (${maxTurns})`,
  };
}