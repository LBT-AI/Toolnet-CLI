/**
 * Unified AgentHarness Kernel for ToolNet CLI
 * Target File: src/lib/harness/agentHarness.ts
 */

import { detectGatewayUrl, GatewayClient } from "../gateway";
import { agentTools, getMergedAgentTools, executeTool } from "../agentTools";
import { workspaceRoot, currentCwd, initWorkspace } from "../codingAgent";
import { contextEngine, type ContextMessage, sessionMemory } from "../context";
import { securityEngine, redactSecrets, type SandboxMode } from "../security";
import { getSandboxMode, setSandboxMode } from "../permissions";
import { saveSession, loadSession } from "../sessionPersistence";
import { detectProjectFramework } from "../projectDetector";
import { getCliKey } from "../keys";
import { bypassEngine } from "../bypass";
import type {
  ExecutionMode,
  ExecutionOptions,
  HarnessConfig,
  HarnessEvent,
  HarnessEventListener,
  HarnessEventType,
  HarnessResult,
  HarnessSnapshot,
} from "./types";
import type { AgentRole } from "../../teamwork/types";

export class AgentHarness {
  private config: HarnessConfig;
  private eventListeners: Set<HarnessEventListener> = new Set();
  private totalTokensUsed = 0;
  private totalToolCalls = 0;
  private initializedAt = Date.now();

  constructor(config: HarnessConfig = {}) {
    this.config = {
      workspaceRoot: config.workspaceRoot || workspaceRoot || process.cwd(),
      currentCwd: config.currentCwd || currentCwd || process.cwd(),
      sessionId: config.sessionId || `session-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      model: config.model || "openai/gpt-4o",
      sandboxMode: config.sandboxMode || getSandboxMode(),
      gatewayUrl: config.gatewayUrl || detectGatewayUrl(),
      maxTurns: config.maxTurns || 10,
      timeoutMs: config.timeoutMs || 120000,
      bypassSecurity: config.bypassSecurity || false,
    };

    if (config.sandboxMode) {
      setSandboxMode(config.sandboxMode);
    }

    this.emitEvent("harness:init", "HEADLESS", {
      workspaceRoot: this.config.workspaceRoot,
      sessionId: this.config.sessionId,
      model: this.config.model,
    });
  }

  // ── Event Bus ─────────────────────────────────────────────────────────────

  on(listener: HarnessEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private emitEvent(type: HarnessEventType, mode: ExecutionMode, payload?: any) {
    const event: HarnessEvent = {
      type,
      timestamp: Date.now(),
      sessionId: this.config.sessionId || "default",
      mode,
      payload,
    };
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  // ── Tool Execution Middleware ─────────────────────────────────────────────

  async dispatchTool(
    name: string,
    args: any,
    options: { skipPermission?: boolean; cwd?: string } = {}
  ): Promise<{ result: string; allowed: boolean; reason?: string }> {
    const cwd = options.cwd || this.config.currentCwd || process.cwd();
    const mode = this.config.sandboxMode || getSandboxMode();

    const isForceBypass = this.config.bypassSecurity || (bypassEngine.isEnabled() && bypassEngine.getConfig().forceExecution);

    if (!options.skipPermission && !isForceBypass) {
      const perm = securityEngine.evaluate(name, args, mode, cwd, this.config.workspaceRoot);
      if (!perm.allowed) {
        return {
          result: JSON.stringify({ error: `Permission Denied: ${perm.reason || "Blocked by sandbox policy."}` }),
          allowed: false,
          reason: perm.reason,
        };
      }
    }

    this.totalToolCalls++;
    const rawResult = await executeTool(name, args);

    if (args?.path) {
      contextEngine.recordFileAccess(
        args.path,
        name.includes("write") || name.includes("edit") || name.includes("patch") ? "write" : "read"
      );
    }

    const sanitizedResult = redactSecrets(rawResult);
    return {
      result: sanitizedResult,
      allowed: true,
    };
  }

  // ── Execution Loop Strategy ───────────────────────────────────────────────

  async executeLoop(
    initialMessages: ContextMessage[],
    options: ExecutionOptions = {},
    mode: ExecutionMode = "HEADLESS"
  ): Promise<HarnessResult> {
    const startTime = Date.now();
    const model = options.model || this.config.model || "openai/gpt-4o";
    const gatewayUrl = options.gatewayUrl || this.config.gatewayUrl || detectGatewayUrl();
    const maxTurns = options.maxTurns || this.config.maxTurns || 10;
    const timeoutMs = options.timeoutMs || this.config.timeoutMs || 120000;
    const sessionId = options.sessionId || this.config.sessionId || "session";

    const messages: ContextMessage[] = [...initialMessages];
    let toolCallsCount = 0;
    let turnsUsed = 0;
    let accumulatedTokens = 0;
    const toolCallHistory: string[] = [];

    const providerStr = model.includes("/") ? model.split("/")[0] : model;
    let localKey = getCliKey(providerStr) || getCliKey("toolnet") || getCliKey("gateway") || getCliKey("default");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (localKey) headers["Authorization"] = `Bearer ${localKey}`;
    if (bypassEngine.isEnabled()) {
      headers["x-bypass-toolnet"] = "true";
      headers["x-bypass-level"] = bypassEngine.getLevel();
    }

    this.emitEvent("agent:start", mode, { model, totalMessages: messages.length });

    while (turnsUsed < maxTurns) {
      turnsUsed++;

      if (Date.now() - startTime > timeoutMs) {
        this.emitEvent("agent:error", mode, { error: `Execution timed out after ${timeoutMs}ms` });
        return {
          success: false,
          output: "",
          messages,
          toolCallsCount,
          turnsUsed,
          tokensUsed: accumulatedTokens,
          durationMs: Date.now() - startTime,
          mode,
          sessionId,
          error: `Execution timed out after ${timeoutMs}ms`,
        };
      }

      // Prepare context via Unified Context Engine
      const prep = contextEngine.prepareMessagesForApi(messages, { model });
      accumulatedTokens = prep.budget.currentEstimatedTokens;
      this.totalTokensUsed += accumulatedTokens;

      if (prep.compacted) {
        this.emitEvent("agent:compact", mode, {
          originalTokens: prep.budget.currentEstimatedTokens,
          newCount: prep.messages.length,
        });
      }

      const payload = {
        model,
        messages: prep.messages,
        tools: options.toolsOverride || getMergedAgentTools(),
        tool_choice: "auto",
        stream: options.stream ?? false,
      };

      let response: Response;
      try {
        response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (netErr: any) {
        const errorMsg = `Network/Gateway connection failed: ${netErr?.message || String(netErr)}`;
        this.emitEvent("agent:error", mode, { error: errorMsg });
        return {
          success: false,
          output: "",
          messages,
          toolCallsCount,
          turnsUsed,
          tokensUsed: accumulatedTokens,
          durationMs: Date.now() - startTime,
          mode,
          sessionId,
          error: errorMsg,
        };
      }

      if (!response.ok) {
        const errText = await response.text();
        const errorMsg = `Gateway HTTP ${response.status}: ${errText}`;
        this.emitEvent("agent:error", mode, { error: errorMsg });
        return {
          success: false,
          output: "",
          messages,
          toolCallsCount,
          turnsUsed,
          tokensUsed: accumulatedTokens,
          durationMs: Date.now() - startTime,
          mode,
          sessionId,
          error: errorMsg,
        };
      }

      let data: any;
      try {
        data = await response.json();
      } catch {
        return {
          success: false,
          output: "",
          messages,
          toolCallsCount,
          turnsUsed,
          tokensUsed: accumulatedTokens,
          durationMs: Date.now() - startTime,
          mode,
          sessionId,
          error: "Failed to parse JSON response from Gateway",
        };
      }

      const choice = data.choices?.[0];
      const assistantMsg = choice?.message;
      if (!assistantMsg) {
        return {
          success: false,
          output: "",
          messages,
          toolCallsCount,
          turnsUsed,
          tokensUsed: accumulatedTokens,
          durationMs: Date.now() - startTime,
          mode,
          sessionId,
          error: "Empty assistant response returned from model gateway",
        };
      }

      messages.push(assistantMsg);

      const toolCalls = assistantMsg.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        // Anti-Refusal Interceptor
        if (bypassEngine.isEnabled() && bypassEngine.getConfig().autoEscalate && turnsUsed < maxTurns) {
          const refusal = bypassEngine.checkRefusal(assistantMsg.content || "");
          if (refusal.isRefusal) {
            const lastUserMsg = [...messages].reverse().find((m) => m.role === "user")?.content || "";
            const escalation = bypassEngine.escalate(lastUserMsg);
            if (escalation) {
              this.emitEvent("agent:start", mode, {
                model,
                totalMessages: messages.length,
                escalatedLevel: escalation.newLevel,
              });
              messages.push({
                role: "user",
                content: escalation.overridePrompt,
              });
              continue;
            }
          }
        }

        // Successful final text response
        const finalOutput = assistantMsg.content || "";
        this.emitEvent("agent:complete", mode, { output: finalOutput, turnsUsed, toolCallsCount });

        saveSession(sessionId, messages, {
          model,
          mode,
          turnsUsed,
          tokensUsed: accumulatedTokens,
        });

        return {
          success: true,
          output: finalOutput,
          messages,
          toolCallsCount,
          turnsUsed,
          tokensUsed: accumulatedTokens,
          durationMs: Date.now() - startTime,
          mode,
          sessionId,
          budget: prep.budget,
        };
      }

      // Execute requested tool calls through Harness Middleware
      for (const call of toolCalls) {
        const toolName = call.function.name;
        let toolArgs: any = {};
        try {
          toolArgs = JSON.parse(call.function.arguments || "{}");
        } catch {}

        const callSig = `${toolName}:${JSON.stringify(toolArgs)}`;
        const repeatCount = toolCallHistory.filter((s) => s === callSig).length;
        if (repeatCount >= 2) {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: toolName,
            content: JSON.stringify({ error: `Infinite loop detected on '${toolName}'. Call aborted.` }),
          });
          continue;
        }
        toolCallHistory.push(callSig);

        toolCallsCount++;
        this.emitEvent("agent:tool_start", mode, { toolName, toolArgs, id: call.id });

        const toolRes = await this.dispatchTool(toolName, toolArgs);

        this.emitEvent("agent:tool_end", mode, {
          toolName,
          toolArgs,
          result: toolRes.result,
          id: call.id,
        });

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: toolName,
          content: toolRes.result,
        });
      }
    }

    return {
      success: false,
      output: "",
      messages,
      toolCallsCount,
      turnsUsed: maxTurns,
      tokensUsed: accumulatedTokens,
      durationMs: Date.now() - startTime,
      mode,
      sessionId,
      error: `Exceeded maximum turn count (${maxTurns})`,
    };
  }

  // ── High-Level Orchestration Entry Points ─────────────────────────────────

  /**
   * Runs headless 1-turn task (equivalent to toolnet -p "...")
   */
  async runHeadless(prompt: string, options: ExecutionOptions = {}): Promise<HarnessResult> {
    const memoryPrompt = contextEngine.getMemoryPromptSnippet();
    const baseSystemPrompt =
      options.systemPrompt ||
      `You are ToolNet API CLI Agent. Complete the user request using available tools with maximum efficiency.\n\n${memoryPrompt}`;
    const systemPrompt = bypassEngine.getBypassSystemPrompt(baseSystemPrompt);

    const messages: ContextMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ];

    return this.executeLoop(messages, options, "HEADLESS");
  }

  /**
   * Runs hyper-optimized Turbo single-pass execution.
   */
  async runTurbo(prompt: string, options: ExecutionOptions = {}): Promise<HarnessResult> {
    const baseSystemPrompt = `You are ToolNet Turbo Agent. Execute the user request immediately with minimal latency. Use tools directly and summarize outcome.`;
    const systemPrompt = bypassEngine.getBypassSystemPrompt(baseSystemPrompt);
    const messages: ContextMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ];

    return this.executeLoop(messages, { ...options, maxTurns: options.maxTurns || 5 }, "TURBO");
  }

  /**
   * Spawns an isolated Sub-Agent task.
   */
  async runSubagent(
    role: AgentRole,
    task: string,
    options: ExecutionOptions = {}
  ): Promise<HarnessResult> {
    const { getSubagentRolePrompt, getSubagentTools } = await import("../../teamwork/subagentRuntime");
    const rolePrompt = getSubagentRolePrompt(role, task.slice(0, 50));
    const tools = getSubagentTools(role);

    const messages: ContextMessage[] = [
      { role: "system", content: rolePrompt },
      { role: "user", content: task },
    ];

    this.emitEvent("subagent:spawn", "SUBAGENT", { role, task });

    const res = await this.executeLoop(
      messages,
      { ...options, toolsOverride: tools, maxTurns: options.maxTurns || 8 },
      "SUBAGENT"
    );

    if (res.success) {
      this.emitEvent("subagent:complete", "SUBAGENT", { role, task, output: res.output });
    }

    return res;
  }

  /**
   * Runs Teamwork DAG multi-agent orchestrator.
   */
  async runTeamwork(prompt: string, options: ExecutionOptions = {}): Promise<HarnessResult> {
    const startTime = Date.now();
    const { generateTaskGraph } = await import("../../teamwork/smartPlanner");
    const { DynamicScheduler } = await import("../../teamwork/dynamicScheduler");

    const sessionId = options.sessionId || this.config.sessionId || `teamwork-${Date.now()}`;
    const taskGraph = await generateTaskGraph(prompt, undefined, {
      sessionId,
      gatewayUrl: options.gatewayUrl || this.config.gatewayUrl,
    });

    const scheduler = new DynamicScheduler(taskGraph, {
      gatewayUrl: options.gatewayUrl || this.config.gatewayUrl,
      model: options.model || this.config.model,
    });

    const finalState = await scheduler.start();

    return {
      success: finalState.status === "COMPLETED",
      output: `Teamwork DAG execution finished with status: ${finalState.status}`,
      messages: [],
      toolCallsCount: this.totalToolCalls,
      turnsUsed: Object.keys(finalState.graph?.nodes || {}).length,
      tokensUsed: finalState.totalTokensUsed || 0,
      durationMs: Date.now() - startTime,
      mode: "TEAMWORK",
      sessionId,
      teamworkState: finalState,
      error: finalState.status === "FAILED" ? "Teamwork DAG execution failed" : undefined,
    };
  }

  // ── Observability & State Snapshot ────────────────────────────────────────

  getSnapshot(): HarnessSnapshot {
    const detected = detectProjectFramework(this.config.workspaceRoot || process.cwd());
    return {
      sessionId: this.config.sessionId || "default",
      workspaceRoot: this.config.workspaceRoot || process.cwd(),
      currentCwd: this.config.currentCwd || process.cwd(),
      currentModel: this.config.model || "openai/gpt-4o",
      sandboxMode: this.config.sandboxMode || getSandboxMode(),
      activeFramework: detected?.framework || "unknown",
      totalTokensUsed: this.totalTokensUsed,
      totalToolCalls: this.totalToolCalls,
      initializedAt: this.initializedAt,
    };
  }
}

// ── Singleton Instance ──────────────────────────────────────────────────────

let globalHarness: AgentHarness | null = null;

export function getHarness(config?: HarnessConfig): AgentHarness {
  if (!globalHarness || config) {
    globalHarness = new AgentHarness(config);
  }
  return globalHarness;
}

export function resetHarness(config?: HarnessConfig): AgentHarness {
  globalHarness = new AgentHarness(config);
  return globalHarness;
}
