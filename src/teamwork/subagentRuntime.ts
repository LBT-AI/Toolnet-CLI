/**
 * Real Sub-Agent Execution Engine for ToolNet Teamwork v2
 * Target File: src/teamwork/subagentRuntime.ts
 */

import { agentTools } from "../lib/agentTools";
import { workspaceRoot, currentCwd } from "../lib/codingAgent";
import { contextEngine } from "../lib/context";
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
  const roleName = String(role || "").trim().toUpperCase();

  if (roleName === "RESEARCHER") {
    const allowed = new Set([
      "read_file", "file_exists", "list_dir", "tree", "grep", "glob", "glob_search", "grep_search",
      "find_path", "web_fetch", "audit_url", "git_status", "git_diff", "get_cwd"
    ]);
    return agentTools.filter((t: any) => allowed.has(t.function?.name));
  }

  if (roleName === "TESTER") {
    const allowed = new Set([
      "read_file", "file_exists", "list_dir", "tree", "grep", "glob", "glob_search", "grep_search",
      "find_path", "shell", "run_command", "git_status", "git_diff", "get_cwd"
    ]);
    return agentTools.filter((t: any) => allowed.has(t.function?.name));
  }

  if (roleName === "REVIEWER") {
    const allowed = new Set([
      "read_file", "file_exists", "list_dir", "tree", "grep", "glob", "glob_search", "grep_search",
      "find_path", "git_status", "git_diff", "get_cwd"
    ]);
    return agentTools.filter((t: any) => allowed.has(t.function?.name));
  }

  if (roleName === "CODER" || roleName === "ARCHITECT") {
    // Coder and Architect get workspace tools but NO nested spawn_subagent or delegate_task
    const blocked = new Set(["spawn_subagent", "delegate_task"]);
    return agentTools.filter((t: any) => !blocked.has(t.function?.name));
  }

  // GENERAL or unknown role -> Restrictive default (read-only like researcher)
  const defaultAllowed = new Set([
    "read_file", "file_exists", "list_dir", "tree", "grep", "glob", "glob_search", "grep_search",
    "find_path", "git_status", "git_diff", "get_cwd"
  ]);
  return agentTools.filter((t: any) => defaultAllowed.has(t.function?.name));
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
  const onEvent = options.onEvent;

  if (onEvent) {
    onEvent("subagent:start", { nodeId: node.id, role, title: node.title });
  }

  // Single-kernel delegation: the AgentHarness owns the ReAct loop, provider
  // calls, SecurityEngine enforcement, executeToolBatch, ToolCache + compress,
  // loop detection, approval flow, EventBus, and session persistence. The
  // child inherits the parent harness's sandbox mode (never broader). The
  // harness constructs the provider from the gateway URL / active provider, so
  // no provider wiring is duplicated here.
  const { getHarness } = await import("../lib/harness");
  const harness = getHarness({
    model: options.model || "default",
    gatewayUrl: options.gatewayUrl || options.baseUrl,
    maxTurns,
    timeoutMs,
  });

  const unsubscribe = onEvent
    ? harness.on((evt) => {
        if (evt.type === "tool:start") {
          onEvent("subagent:tool", { nodeId: node.id, role, toolName: evt.payload?.toolName, toolArgs: evt.payload?.toolArgs, id: evt.payload?.id });
        }
      })
    : () => {};

  try {
    const res = await harness.runSubagent(role, node.prompt || node.title, {
      model: options.model || "default",
      gatewayUrl: options.gatewayUrl || options.baseUrl,
      maxTurns,
      timeoutMs,
      sessionId: options.sessionId,
    });

    if (onEvent) {
      onEvent("subagent:complete", { nodeId: node.id, role, output: res.output });
    }

    return {
      success: res.success,
      output: res.output || `[Subagent ${role} finished task '${node.title}']`,
      toolCallsCount: res.toolCallsCount,
      turnsUsed: res.turnsUsed,
      tokensUsed: res.tokensUsed || 0,
      role,
      nodeId: node.id,
      error: res.error || (res.success ? undefined : `Sub-Agent failed for task '${node.title}'`),
    };
  } finally {
    unsubscribe();
  }
}