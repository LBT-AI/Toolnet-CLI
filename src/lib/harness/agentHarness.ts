/**
 * Unified AgentHarness Kernel for ToolNet CLI
 * Target File: src/lib/harness/agentHarness.ts
 */

import fs from "node:fs";
import { getActiveProvider, getActiveBaseUrl, getActiveDefaultModel, OpenAICompatibleProvider, type Provider } from "../../providers";
import { getMergedAgentTools } from "../agentTools";
import { workspaceRoot, currentCwd } from "../codingAgent";
import { contextEngine, type ContextMessage } from "../context";
import { securityEngine, type SandboxMode, getPermissionContextPrompt, clampSandboxMode } from "../security";
import { getSandboxMode, setSandboxMode } from "../permissions";
import { saveSession } from "../sessionPersistence";
import { detectProjectFramework, buildProjectContext } from "../projectDetector";
import { getCodingAgentPolicy, getCodingAgentToolUseGuidance } from "../codingAgentPolicy";
import { ChangeTracker } from "./changeTracker";
import { analyzePrompt, buildSystemPromptForTask } from "./taskUnderstanding";
import { TaskContextManager } from "./taskContext";
import { bypassEngine } from "../bypass";
import { getLanguageDirective, getResponseLanguage } from "../language";
import { getModelCapabilities } from "../reasoning";
import { ToolCache, createMetrics, type ToolCall, type ToolPlannerMetrics } from "./toolPlanner";
import { executeToolBatch, signatureForToolCall } from "./toolExecutor";
import { toolRegistry } from "./toolRegistry";
import { createWorkspaceContext, type WorkspaceContext } from "./workspace";
import { AgentStateMachine } from "./agentState";
import { normalizeChatResponse } from "./modelAdapter";
import { parseTaskRequirements, evaluateCompletionGate, recordEvidence, emptyEvidence } from "../../core/agent/completionGate";
import type { CompletionEvidence, TaskRequirement } from "../../core/contracts";
import type {
  ExecutionMode,
  ExecutionOptions,
  HarnessConfig,
  HarnessEvent,
  HarnessEventListener,
  HarnessEventType,
  HarnessResult,
  HarnessSnapshot,
  ActiveTaskContext,
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
  private lastToolSig: string | null = null;
  private consecutiveToolRepeat = 0;
  private loopAbortController: (AbortController & { aborted?: boolean }) | null = null;
  private activeMode: ExecutionMode = "HEADLESS";
  private agentState = new AgentStateMachine();
  private workspaceCtx: WorkspaceContext;
  private changeTracker = new ChangeTracker();
  private taskContextManager = new TaskContextManager();
  /** Phase 73.9 — verified side effects from the most recent loop run. */
  private lastCompletionEvidence: CompletionEvidence = emptyEvidence();

  constructor(config: HarnessConfig = {}) {
    const stableRoot =
      workspaceRoot && fs.existsSync(workspaceRoot) ? workspaceRoot : process.cwd();
    const stableCwd =
      currentCwd && fs.existsSync(currentCwd) ? currentCwd : stableRoot;

    this.config = {
      workspaceRoot: config.workspaceRoot || stableRoot,
      currentCwd: config.currentCwd || stableCwd,
      sessionId: config.sessionId || `session-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      model: config.model || getActiveDefaultModel() || "default",
      sandboxMode: config.sandboxMode || getSandboxMode(),
      gatewayUrl: config.gatewayUrl || "",
      maxTurns: config.maxTurns || 10,
      timeoutMs: config.timeoutMs || 120000,
    };

    if (config.sandboxMode) {
      setSandboxMode(config.sandboxMode);
    }

    this.workspaceCtx = createWorkspaceContext({
      root: this.config.workspaceRoot,
      cwd: this.config.currentCwd,
      sandboxMode: this.config.sandboxMode as WorkspaceContext["sandboxMode"],
    });

    this.emitEvent("harness:init", "HEADLESS", {
      workspaceRoot: this.config.workspaceRoot,
      sessionId: this.config.sessionId,
      model: this.config.model,
    });
  }

  // ── Workspace awareness (§8) ─────────────────────────────────────────────

  getWorkspace(): WorkspaceContext {
    return { ...this.workspaceCtx };
  }

  getAgentState(): string {
    return this.agentState.state;
  }

  /** Verified side effects (mutations/executions/tests) from the last run. */
  getCompletionEvidence(): CompletionEvidence {
    return { ...this.lastCompletionEvidence };
  }

  // ── Event Bus ─────────────────────────────────────────────────────────────

  on(listener: HarnessEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  emitEvent(type: HarnessEventType, mode: ExecutionMode, payload?: any) {
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
    options: { cwd?: string; userApproved?: boolean; agentRole?: string; agentDepth?: number; signal?: AbortSignal } = {}
  ): Promise<{ result: string; allowed: boolean; reason?: string }> {
    const cwd = options.cwd || this.config.currentCwd || process.cwd();
    const mode = this.config.sandboxMode || getSandboxMode();

    if (options.signal?.aborted) {
      return {
        result: JSON.stringify({ stdout: "", stderr: "Cancelled", exitCode: 130 }),
        allowed: false,
        reason: "Cancelled",
      };
    }

    this.metrics.toolCallsRequested++;

    const { ToolGateway } = await import("../security/toolGateway");
    const gatewayRes = await ToolGateway.execute({ name, args }, {
      cwd,
      workspaceRoot: this.config.workspaceRoot,
      sandboxMode: mode,
      userApproved: options.userApproved,
      agentRole: options.agentRole || (this.activeMode === "SUBAGENT" ? "subagent" : undefined),
      agentDepth: options.agentDepth || (this.activeMode === "SUBAGENT" ? 1 : 0),
      sessionId: this.config.sessionId,
      source: this.activeMode === "SUBAGENT" ? "subagent" : this.activeMode === "TEAMWORK" ? "teamwork" : "headless",
      signal: options.signal,
    });

    if (gatewayRes.needsApproval) {
      this.metrics.toolCallsExecuted++;
      this.emitEvent("tool:approval_required", this.activeMode, { toolName: name, toolArgs: args, reason: gatewayRes.reason });
      return {
        result: JSON.stringify({
          stdout: "",
          stderr: gatewayRes.stderr || `Approval Required: ${gatewayRes.reason || `Tool ${name} requires interactive approval.`}`,
          exitCode: 1,
          approvalRequired: true,
        }),
        allowed: false,
        reason: gatewayRes.reason,
      };
    }

    if (!gatewayRes.allowed) {
      this.metrics.toolCallsExecuted++;
      return {
        result: JSON.stringify({ error: `Permission Denied: ${gatewayRes.reason || "Blocked by sandbox policy."}` }),
        allowed: false,
        reason: gatewayRes.reason,
      };
    }

    this.totalToolCalls++;
    this.metrics.toolCallsExecuted++;

    const isWriteTool = name === "write_file" || name === "edit_file" || name === "replace_all" || name === "apply_patch";
    if (args?.path) {
      contextEngine.recordFileAccess(
        args.path,
        isWriteTool ? "write" : "read",
        this.config.sessionId
      );
      if (isWriteTool) {
        if (name === "write_file" && !fs.existsSync(args.path)) {
          this.changeTracker.trackCreated(args.path);
        } else {
          this.changeTracker.trackModified(args.path);
        }
      }
    }

    const output = gatewayRes.stdout || JSON.stringify({ success: true });
    this.metrics.rawToolOutputChars += output.length;
    this.metrics.retainedToolOutputChars += output.length;

    return {
      result: output,
      allowed: true,
    };
  }

  getChangeTracker(): ChangeTracker {
    return this.changeTracker;
  }

  getTaskContextManager(): TaskContextManager {
    return this.taskContextManager;
  }

  // ── Core Execution Loop ──────────────────────────────────────────────────

  async executeLoop(
    initialMessages: ContextMessage[],
    options: ExecutionOptions = {},
    mode: ExecutionMode = "HEADLESS"
  ): Promise<HarnessResult> {
    const startTime = Date.now();
    const model = options.model || this.config.model || getActiveDefaultModel() || "default";
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

    // Phase 73.9 — Completion Gate: derive task requirements from the user
    // prompt (or caller-provided requirements) and track verified evidence.
    const userPrompt =
      [...initialMessages].reverse().find((m) => m.role === "user")?.content ?? "";
    const requirements: TaskRequirement =
      options.taskRequirements ??
      (userPrompt ? parseTaskRequirements(String(userPrompt)) : { mutationRequired: false, executionRequired: false, verificationRequired: false, testRequired: false });
    const evidence: CompletionEvidence =
      options.completionEvidence ?? emptyEvidence();
    this.lastCompletionEvidence = evidence;

    this.lastToolSig = null;
    this.consecutiveToolRepeat = 0;
    this.activeMode = mode;

    const abort = new AbortController() as AbortController & { aborted?: boolean };
    this.loopAbortController = abort;

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signals: AbortSignal[] = [timeoutSignal];
    if (abort.signal) signals.push(abort.signal);
    if (options.signal) signals.push(options.signal);
    const combinedSignal =
      typeof AbortSignal.any === "function"
        ? AbortSignal.any(signals)
        : timeoutSignal;

    const extraHeaders: Record<string, string> = {};
    if (bypassEngine.isEnabled()) {
      extraHeaders["x-bypass-toolnet"] = "true";
      extraHeaders["x-bypass-level"] = bypassEngine.getLevel();
    }

    this.emitEvent("agent:start", mode, { model, totalMessages: messages.length });
    this.agentState.transition("thinking");

    while (turnsUsed < maxTurns) {
      turnsUsed++;

      if (Date.now() - startTime > timeoutMs) {
        this.agentState.transition("error", "timeout");
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

      const prep = contextEngine.prepareMessagesForApi(messages, { model, sessionId });
      accumulatedTokens = prep.budget.currentEstimatedTokens;
      this.totalTokensUsed += accumulatedTokens;

      if (prep.compacted) {
        this.emitEvent("agent:compact", mode, {
          originalTokens: prep.budget.currentEstimatedTokens,
          newCount: prep.messages.length,
        });
      }

      // §2/§3 — capability-gate tool definitions: models that declare
      // `tools: false` never receive tool schemas, so they cannot pretend to
      // call tools. Models without native tool calling still receive schemas;
      // their structured JSON tool blocks are parsed by the adapter below.
      const caps = getModelCapabilities(model);
      const toolsForRequest =
        caps?.tools === false
          ? undefined
          : options.toolsOverride || toolRegistry.schemas();

      let chatRes;
      try {
        chatRes = await provider.chat({
          model,
          messages: prep.messages as any,
          tools: toolsForRequest,
          tool_choice: toolsForRequest ? options.toolChoice || "auto" : undefined,
          headers: extraHeaders,
          signal: combinedSignal,
        });
      } catch (netErr: any) {
        if (abort.signal?.aborted) {
          this.agentState.transition("cancelled");
          this.emitEvent("agent:error", mode, { error: "Execution cancelled by user" });
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
            error: "Execution cancelled by user",
          };
        }
        const errorMsg = `Gateway network error: Network/Gateway connection failed: ${netErr?.message || String(netErr)}`;
        this.agentState.transition("error", "network");
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

      // §2 — normalize through the ModelAdapter contract. For models with
      // nativeToolCalls=false, a structured JSON tool block inside the text
      // content is parsed into toolCalls here — never by the TUI or the loop.
      const normalized = normalizeChatResponse(chatRes, model);

      if (chatRes.usage) {
        contextEngine.recordUsage(
          {
            promptTokens: chatRes.usage.prompt_tokens || chatRes.usage.input_tokens,
            completionTokens: chatRes.usage.completion_tokens || chatRes.usage.output_tokens,
            totalTokens: chatRes.usage.total_tokens,
            cachedTokens: chatRes.usage.prompt_tokens_details?.cached_tokens || chatRes.usage.cache_read_input_tokens,
            reasoningTokens: chatRes.usage.completion_tokens_details?.reasoning_tokens || chatRes.usage.reasoning_tokens,
          },
          sessionId
        );
      }

      if (!assistantMsg) {
        this.agentState.transition("error", "empty-response");
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

      const toolCalls = normalized.toolCalls;
      if (!toolCalls || toolCalls.length === 0) {
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

        const finalOutput = assistantMsg.content || "";

        // ── Completion Gate (§19/§73.9) ────────────────────────────────────
        // A text-only answer is NOT final when the task required a mutation,
        // execution, verification, or test run that never succeeded. Feed the
        // corrective instruction back and continue the loop instead.
        const gate = evaluateCompletionGate({
          requirements,
          evidence,
          proposedAnswer: finalOutput,
          turnsRemaining: maxTurns - turnsUsed,
          toolCallsExecuted: toolCallsCount,
        });

        if (gate.decision === "continue") {
          this.agentState.transition("thinking", "completion-gate");
          messages.push({
            role: "user",
            content: gate.correctiveInstruction || "The task is not complete yet. Use tools to finish it.",
          });
          this.emitEvent("agent:thinking", mode, { turnsUsed, toolCallsCount, gateReason: gate.reason });
          continue;
        }

        this.agentState.transition("responding");
        this.emitEvent("agent:complete", mode, { output: finalOutput, turnsUsed, toolCallsCount });

        if (this.loopAbortController) {
          try { this.loopAbortController.abort(); } catch {}
          this.loopAbortController = null;
        }

        saveSession(sessionId, messages, {
          model,
          mode,
          turnsUsed,
          tokensUsed: accumulatedTokens,
        });
        this.emitEvent("session:saved", mode, { sessionId, turnsUsed, toolCallsCount });

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
          evidence: { ...evidence },
        };
      }

      const parsedCalls: ToolCall[] = toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        args: (tc.arguments ?? {}) as Record<string, unknown>,
      }));

      const needsApproval = (name: string, args: any): boolean => {
        const cwd = this.config.currentCwd || process.cwd();
        const mode_ = this.config.sandboxMode || getSandboxMode();
        const perm = securityEngine.evaluate(name, args, mode_, cwd, this.config.workspaceRoot);
        return perm.needsApproval || !perm.allowed;
      };

      let loopAborted = false;
      this.agentState.transition("executing-tool");
      const outcome = await executeToolBatch(parsedCalls, {
        cwd: this.config.currentCwd || process.cwd(),
        needsApproval,
        maxRepeat: 2,
        runTool: async (name, args, id) => {
          // Loop detection is CONSECUTIVE-only: the same (tool, args) repeated
          // three times in a row with no other tool call in between signals a
          // stuck model. A coding agent legitimately re-runs the same command
          // (e.g. `bun test`) between edits — that interleaving resets the
          // counter so valid repair loops are never flagged as infinite loops.
          const sig = signatureForToolCall(name, args);
          if (this.lastToolSig === sig) {
            this.consecutiveToolRepeat++;
          } else {
            this.lastToolSig = sig;
            this.consecutiveToolRepeat = 1;
          }
          if (this.consecutiveToolRepeat >= 3) {
            loopAborted = true;
            return {
              result: JSON.stringify({
                stdout: "",
                stderr: `Infinite loop detected: tool '${name}' was called ${this.consecutiveToolRepeat} times consecutively with identical arguments. Aborting loop.`,
                exitCode: 1,
              }),
              allowed: false,
              reason: "loop",
            };
          }


          this.emitEvent("tool:queued", mode, { toolName: name, toolArgs: args, id });
          this.emitEvent("tool:start", mode, { toolName: name, toolArgs: args, id });

          const res = await this.dispatchTool(name, args, {
            agentRole: options.agentRole,
            agentDepth: options.agentDepth ?? (this.activeMode === "SUBAGENT" ? 1 : 0),
            signal: combinedSignal,
          });

          // ── Completion evidence (§19) — only VERIFIED outcomes count.
          // A write/edit/patch tool that returned ok is a mutation; a shell
          // command with exitCode 0 is an execution (and a test run when the
          // command looks like a test invocation).
          if (res.allowed) {
            const parsed = parseResultJson(res.result);
            const exitCode = parsed?.exitCode ?? (parsed?.success === false ? 1 : 0);
            if (exitCode === 0) {
              if (isMutationTool(name)) recordEvidence(evidence, "mutation", true);
              if (isShellTool(name)) {
                recordEvidence(evidence, "execution", true);
                if (looksLikeTestCommand(name, args)) recordEvidence(evidence, "test", true);
                if (looksLikeVerificationCommand(name, args)) recordEvidence(evidence, "verification", true);
              }
            }
            this.emitEvent("tool:complete", mode, { toolName: name, toolArgs: args, result: res.result, id });
          } else {
            this.emitEvent("tool:error", mode, {
              toolName: name, toolArgs: args, result: res.result, reason: res.reason, id,
            });
          }
          return res;
        },
        onMessage: (m) => {
          messages.push({ role: "tool", tool_call_id: m.id, name: m.name, content: m.content });
          toolCallsCount++;
        },
      });

      this.metrics.toolCallsDeduplicated += outcome.deduplicatedCount;
      this.metrics.toolCallsBatched += outcome.parallelCalls;

      this.agentState.transition("thinking", "tool-batch-complete");

      if (loopAborted) {
        this.agentState.transition("error", "loop-detected");
        this.emitEvent("agent:error", mode, { error: "Infinite loop detected: exceeded maximum repetition of identical tool calls." });
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
          error: "Infinite loop detected: exceeded maximum repetition of identical tool calls.",
        };
      }

      this.emitEvent("agent:thinking", mode, { turnsUsed, toolCallsCount });
    }

    this.agentState.transition("error", "max-turns");
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

  // ── AgentLoop entry point ─────────────────────────────────────────────────

  private buildSystemPrompt(extra?: string, taskSummary?: string): string {
    const memoryPrompt = contextEngine.getMemoryPromptSnippet(this.config.sessionId);
    const toolRules = contextEngine.getToolUsageRulesSnippet();
    const permissionContext = getPermissionContextPrompt(this.config.sandboxMode || getSandboxMode());
    const codingPolicy = getCodingAgentPolicy();
    const toolGuidance = getCodingAgentToolUseGuidance();
    const projectCtx = buildProjectContext(this.config.workspaceRoot || process.cwd(), this.config.currentCwd || this.config.workspaceRoot || process.cwd());
    const projectSummary = this.formatProjectContext(projectCtx);
    const taskBlock = taskSummary ? `\n${taskSummary}\n` : "";
    const base = `${codingPolicy}

${toolGuidance}

${projectSummary}${taskBlock}

${permissionContext}

Your access is strictly limited to the policy described in [RUNTIME PERMISSION CONTEXT] above.

${memoryPrompt}${toolRules}

${getLanguageDirective(getResponseLanguage())}`;
    return bypassEngine.getBypassSystemPrompt(extra || base);
  }

  private formatProjectContext(ctx: ReturnType<typeof buildProjectContext>): string {
    const lines: string[] = ["[PROJECT CONTEXT]"];
    lines.push(`Workspace: ${ctx.workspaceRoot}`);
    if (ctx.gitRoot) lines.push(`Git root: ${ctx.gitRoot}`);
    if (ctx.language.length > 0) lines.push(`Languages: ${ctx.language.join(", ")}`);
    if (ctx.packageManager) lines.push(`Package manager: ${ctx.packageManager}`);
    if (ctx.framework.length > 0) lines.push(`Frameworks: ${ctx.framework.join(", ")}`);
    if (ctx.manifestFiles.length > 0) lines.push(`Manifest files: ${ctx.manifestFiles.join(", ")}`);
    if (ctx.testCommands.length > 0) lines.push(`Test commands: ${ctx.testCommands.join(", ")}`);
    if (ctx.buildCommands.length > 0) lines.push(`Build commands: ${ctx.buildCommands.join(", ")}`);
    if (ctx.lintCommands.length > 0) lines.push(`Lint commands: ${ctx.lintCommands.join(", ")}`);
    if (ctx.typecheckCommands.length > 0) lines.push(`Typecheck commands: ${ctx.typecheckCommands.join(", ")}`);
    lines.push("");
    return lines.join("\n");
  }

  private formatActiveTaskContext(ctx: ActiveTaskContext, task: import("./types").TaskContext): string {
    const lines: string[] = ["[ACTIVE TASK CONTEXT]"];
    if (ctx.currentGoal) lines.push(`Current goal: ${ctx.currentGoal}`);
    if (ctx.currentFiles.length > 0) lines.push(`Current files: ${ctx.currentFiles.join(", ")}`);
    if (ctx.currentUrls.length > 0) lines.push(`Current URLs: ${ctx.currentUrls.join(", ")}`);
    if (ctx.currentPlan.length > 0) lines.push(`Plan: ${ctx.currentPlan.join(" → ")}`);
    if (ctx.completedSteps.length > 0) lines.push(`Completed: ${ctx.completedSteps.join(", ")}`);
    if (ctx.pendingSteps.length > 0) lines.push(`Pending: ${ctx.pendingSteps.join(", ")}`);
    if (ctx.constraints.length > 0) lines.push(`Constraints: ${ctx.constraints.join(", ")}`);
    if (ctx.requirements.length > 0) {
      lines.push("Requirements:");
      for (const r of ctx.requirements) {
        const icon = r.status === "satisfied" ? "✓" : r.status === "blocked" ? "✗" : "○";
        lines.push(`  ${icon} ${r.text}`);
      }
    }
    if (task.intent) lines.push(`Detected intent: ${task.intent}`);
    if (task.ambiguities.length > 0) {
      lines.push(`Ambiguities: ${task.ambiguities.join("; ")}`);
    }
    lines.push("");
    return lines.join("\n");
  }

  /**
   * Single-shot execution entry point used by AgentLoop.
   * Builds a standard system+user message pair and runs the full ReAct loop.
   */
  async execute(options: ExecutionOptions = {}): Promise<HarnessResult> {
    const mode = options.mode || "HEADLESS";
    const prompt = options.prompt || "";

    // ── Task Understanding Layer (§2/§30) ───────────────────────────────────
    this.agentState.transition("understanding");
    const task = analyzePrompt(prompt);
    this.taskContextManager.setGoal(task.objectives[0] || prompt);
    this.taskContextManager.addFiles(task.referencedFiles);
    this.taskContextManager.addUrls(task.referencedUrls);
    for (const c of task.constraints) {
      this.taskContextManager.addConstraint(c);
    }

    this.agentState.transition("gathering-context");
    const activeCtx = this.taskContextManager.getContext();
    const taskSummary = this.formatActiveTaskContext(activeCtx, task);
    const systemPrompt = this.buildSystemPrompt(options.systemPrompt, taskSummary);

    const messages: ContextMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ];

    return this.executeLoop(messages, options, mode);
  }

  /**
   * Cancels the currently-running loop (if any).
   */
  cancel(): void {
    const ctrl = this.loopAbortController;
    if (ctrl) {
      try { ctrl.abort(); } catch {}
    }
  }

  // ── High-Level Orchestration Entry Points ─────────────────────────────────

  async run(prompt: string, options: ExecutionOptions = {}): Promise<HarnessResult> {
    const mode = options.mode || "HEADLESS";
    const systemPrompt = this.buildSystemPrompt(options.systemPrompt);

    const messages: ContextMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ];

    return this.executeLoop(messages, options, mode);
  }

  async resume(messages: ContextMessage[], options: ExecutionOptions = {}): Promise<HarnessResult> {
    const mode = options.mode || "HEADLESS";
    return this.executeLoop([...messages], options, mode);
  }

  async runHeadless(prompt: string, options: ExecutionOptions = {}): Promise<HarnessResult> {
    const systemPrompt = this.buildSystemPrompt(options.systemPrompt);

    const messages: ContextMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ];

    return this.executeLoop(messages, options, "HEADLESS");
  }

  async runTurbo(prompt: string, options: ExecutionOptions = {}): Promise<HarnessResult> {
    const turboPrompt = `You are ToolNet Turbo Agent. Execute the user request immediately with minimal latency. Use tools directly and summarize outcome.

${getCodingAgentPolicy()}

${getCodingAgentToolUseGuidance()}`;
    const systemPrompt = this.buildSystemPrompt(options.systemPrompt || turboPrompt);
    const messages: ContextMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ];

    return this.executeLoop(messages, { ...options, maxTurns: options.maxTurns || 5 }, "TURBO");
  }

  async runSubagent(
    role: AgentRole,
    task: string,
    options: ExecutionOptions = {}
  ): Promise<HarnessResult> {
    const { getSubagentRolePrompt, getSubagentTools } = await import("../../teamwork/subagentRuntime");
    const rolePrompt = getSubagentRolePrompt(role, task.slice(0, 50), options.sessionId || this.config.sessionId);
    const tools = options.toolsOverride || getSubagentTools(role);

    const parentMode = this.config.sandboxMode || getSandboxMode();
    const effectiveSandboxMode = clampSandboxMode(options.sandboxMode, parentMode);
    const permissionContext = getPermissionContextPrompt(effectiveSandboxMode);
    const inheritedRolePrompt = `${rolePrompt}

[RUNTIME PERMISSION CONTEXT (inherited)]
${permissionContext}

Your access is strictly limited to the policy described in [RUNTIME PERMISSION CONTEXT] above. A child agent cannot self-elevate filesystem, network, shell, or MCP permissions.`;

    const messages: ContextMessage[] = [
      { role: "system", content: inheritedRolePrompt },
      { role: "user", content: task },
    ];

    this.emitEvent("subagent:spawn", "SUBAGENT", { role, task, parentMode, effectiveSandboxMode });

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

    const cancelTeamwork = () => { try { scheduler.cancel(); } catch {} };
    if (options.signal) {
      if (options.signal.aborted) cancelTeamwork();
      else options.signal.addEventListener("abort", cancelTeamwork, { once: true });
    }

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
      currentModel: this.config.model || getActiveDefaultModel() || "default",
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

// ── Completion-evidence helpers (Phase 73.9) ────────────────────────────────

const MUTATION_TOOLS = new Set([
  "write_file",
  "edit_file",
  "replace_all",
  "apply_patch",
  "create_artifact",
  "update_artifact",
]);

const SHELL_TOOLS = new Set(["shell", "bash", "run_command"]);

function isMutationTool(name: string): boolean {
  return MUTATION_TOOLS.has(name);
}

function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name);
}

function parseResultJson(result: string): Record<string, unknown> | null {
  if (!result || typeof result !== "string") return null;
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function commandFromArgs(name: string, args: any): string {
  if (!isShellTool(name)) return "";
  return String(args?.command ?? args?.cmd ?? "");
}

function looksLikeTestCommand(name: string, args: any): boolean {
  const cmd = commandFromArgs(name, args);
  return /\b(bun test|npm test|yarn test|pnpm test|pytest|jest|vitest|go test|cargo test|mvn test|dotnet test|gradlew test|rspec|phpunit)\b/i.test(cmd);
}

function looksLikeVerificationCommand(name: string, args: any): boolean {
  const cmd = commandFromArgs(name, args);
  return /\b(typecheck|tsc --noEmit|tsc -b|lint|build|go vet|ruff check|mypy|shellcheck)\b/i.test(cmd);
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
