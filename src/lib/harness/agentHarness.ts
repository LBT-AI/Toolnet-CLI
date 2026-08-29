/**
 * Unified AgentHarness Kernel for ToolNet CLI
 * Target File: src/lib/harness/agentHarness.ts
 */

import { getActiveProvider, getActiveBaseUrl, OpenAICompatibleProvider, type Provider } from "../../providers";
import { agentTools, getMergedAgentTools, executeTool } from "../agentTools";
import { workspaceRoot, currentCwd, initWorkspace } from "../codingAgent";
import { contextEngine, type ContextMessage, sessionMemory } from "../context";
import { securityEngine, redactSecrets, type SandboxMode } from "../security";
import { getSandboxMode, setSandboxMode } from "../permissions";
import { saveSession, loadSession } from "../sessionPersistence";
import { detectProjectFramework } from "../projectDetector";
import { getCliKey } from "../keys";
import { bypassEngine } from "../bypass";
import { ToolCache, createMetrics, type ToolCall, type DispatchResult, type ToolPlannerMetrics } from "./toolPlanner";
import { compressToolResult } from "./toolOutputCompressor";
import { executeToolBatch } from "./toolExecutor";
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
  private toolCache = new ToolCache();
  private metrics = createMetrics();

  constructor(config: HarnessConfig = {}) {
    this.config = {
      workspaceRoot: config.workspaceRoot || workspaceRoot || process.cwd(),
      currentCwd: config.currentCwd || currentCwd || process.cwd(),
      sessionId: config.sessionId || `session-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      model: config.model || "openai/gpt-4o",
      sandboxMode: config.sandboxMode || getSandboxMode(),
      gatewayUrl: config.gatewayUrl || "",
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

    this.metrics.toolCallsRequested++;

    const isForceBypass = this.config.bypassSecurity || (bypassEngine.isEnabled() && bypassEngine.getConfig().forceExecution);
    const skipPermission = options.skipPermission || isForceBypass;

    if (!skipPermission) {
      const perm = securityEngine.evaluate(name, args, mode, cwd, this.config.workspaceRoot);
      if (!perm.allowed) {
        this.metrics.toolCallsExecuted++;
        return {
          result: JSON.stringify({ error: `Permission Denied: ${perm.reason || "Blocked by sandbox policy."}` }),
          allowed: false,
          reason: perm.reason,
        };
      }
      if (perm.needsApproval) {
        this.metrics.toolCallsExecuted++;
        return {
          result: JSON.stringify({
            stdout: "",
            stderr: `Approval Required: ${perm.reason || `Tool ${name} requires interactive approval.`}`,
            exitCode: 1,
            approvalRequired: true,
          }),
          allowed: false,
          reason: perm.reason,
        };
      }
    }

    this.totalToolCalls++;
    this.metrics.toolCallsExecuted++;
    const rawResult = await executeTool(name, args, {
      cwd,
      workspaceRoot: this.config.workspaceRoot,
      skipPermission,
    });

    this.metrics.rawToolOutputChars += rawResult.length;
    this.metrics.retainedToolOutputChars += rawResult.length;

    // Track file access for context engine
    const isWriteTool = name === "write_file" || name === "edit_file" || name === "replace_all" || name === "apply_patch";
    if (args?.path) {
      contextEngine.recordFileAccess(
        args.path,
        isWriteTool ? "write" : "read"
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
    const maxTurns = options.maxTurns || this.config.maxTurns || 10;
    const timeoutMs = options.timeoutMs || this.config.timeoutMs || 120000;
    const sessionId = options.sessionId || this.config.sessionId || "session";

    const fallbackUrl = options.gatewayUrl || this.config.gatewayUrl || getActiveBaseUrl() || "http://localhost:8080";
    const provider = getActiveProvider() ?? new OpenAICompatibleProvider({ id: "default", name: "Default", baseUrl: fallbackUrl });

    if (!provider) {
      const errorMsg = "No active AI provider configured.";
      this.emitEvent("agent:error", mode, { error: errorMsg });
      return {
        success: false,
        output: "",
        messages: initialMessages,
        toolCallsCount: 0,
        turnsUsed: 0,
        tokensUsed: 0,
        durationMs: Date.now() - startTime,
        mode,
        sessionId,
        error: errorMsg,
      };
    }

    const messages: ContextMessage[] = [...initialMessages];
    let toolCallsCount = 0;
    let turnsUsed = 0;
    let accumulatedTokens = 0;

    const extraHeaders: Record<string, string> = {};
    if (bypassEngine.isEnabled()) {
      extraHeaders["x-bypass-toolnet"] = "true";
      extraHeaders["x-bypass-level"] = bypassEngine.getLevel();
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

      let chatRes;
      try {
        chatRes = await provider.chat({
          model,
          messages: prep.messages as any,
          tools: options.toolsOverride || getMergedAgentTools(),
          tool_choice: "auto",
          headers: extraHeaders,
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

      const choice = chatRes.choices?.[0];
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
          error: "Empty assistant response returned from model provider",
        };
      }

      messages.push({
        role: assistantMsg.role || "assistant",
        content: assistantMsg.content || "",
        ...(assistantMsg.tool_calls ? { tool_calls: assistantMsg.tool_calls } : {}),
      });

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

      // Execute requested tool calls through the unified P1 pipeline:
      //   dedup → parallel-safe classification → cache/compress (via executeTool in dispatchTool).
      const parsedCalls: ToolCall[] = toolCalls.map((call: any) => {
        let toolArgs: any = {};
        try { toolArgs = JSON.parse(call.function.arguments || "{}"); } catch {}
        return { id: call.id, name: call.function.name, args: toolArgs };
      });

      const needsApproval = (name: string, args: any): boolean => {
        const cwd = this.config.currentCwd || process.cwd();
        const mode_ = this.config.sandboxMode || getSandboxMode();
        const perm = securityEngine.evaluate(name, args, mode_, cwd, this.config.workspaceRoot);
        return perm.needsApproval || !perm.allowed;
      };

      const outcome = await executeToolBatch(parsedCalls, {
        cwd: this.config.currentCwd || process.cwd(),
        needsApproval,
        maxRepeat: 2,
        runTool: async (name, args, id) => {
          this.emitEvent("agent:tool_start", mode, { toolName: name, toolArgs: args, id });
          const res = await this.dispatchTool(name, args);
          this.emitEvent("agent:tool_end", mode, {
            toolName: name, toolArgs: args, result: res.result, id,
          });
          return res;
        },
        onMessage: (m) => {
          messages.push({ role: "tool", tool_call_id: m.id, name: m.name, content: m.content });
          toolCallsCount++;
        },
      });

      this.metrics.toolCallsDeduplicated += outcome.deduplicatedCount;
      this.metrics.toolCallsBatched += outcome.parallelCalls;
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
    const toolRules = contextEngine.getToolUsageRulesSnippet();
    const baseSystemPrompt =
      options.systemPrompt ||
      `You are ToolNet API CLI Agent. Complete the user request using available tools with maximum efficiency.\n\n${memoryPrompt}${toolRules}`;
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
    const cacheStats = this.toolCache.getStats();
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
      metrics: {
        toolCallsRequested: this.metrics.toolCallsRequested,
        toolCallsExecuted: this.metrics.toolCallsExecuted,
        toolCallsDeduplicated: this.metrics.toolCallsDeduplicated,
        toolCacheHits: cacheStats.hits,
        toolCallsBatched: this.metrics.toolCallsBatched,
        rawToolOutputChars: this.metrics.rawToolOutputChars,
        retainedToolOutputChars: this.metrics.retainedToolOutputChars,
        contextCompactions: contextEngine.getCompactionCount(),
        workspaceIndexHits: 0,
      },
    };
  }

  /** Get the tool cache instance for external inspection. */
  getToolCache(): ToolCache {
    return this.toolCache;
  }

  /** Get planner metrics. */
  getMetrics(): ToolPlannerMetrics {
    return { ...this.metrics, ...this.toolCache.getStats() } as any;
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
