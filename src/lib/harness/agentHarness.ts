/**
 * Unified AgentHarness Kernel for ToolNet CLI
 * Target File: src/lib/harness/agentHarness.ts
 */

import fs from "node:fs";
import path from "node:path";
import { getActiveDefaultModel, type Provider } from "../../providers";
import {
  invokeRouteChain,
  noteModelFailure,
  noteModelSuccess,
  persistRoutingIntelligence,
  providerRegistry,
  resolveRuntimeModel,
  type ProviderRoute,
} from "../../core/models";
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
import { sessionInbox } from "../../core/background/inbox";
import { ToolCache, createMetrics, type ToolCall, type ToolPlannerMetrics } from "./toolPlanner";
import { executeToolBatch, signatureForToolCall } from "./toolExecutor";
import { toolRegistry } from "./toolRegistry";
import { hookRegistry } from "../../core/hooks";
import { createWorkspaceContext, type WorkspaceContext } from "./workspace";
import { AgentStateMachine } from "./agentState";
import { ModelAdapter, type AgentModelResponse, type AgentToolCall } from "./modelAdapter";
import { makeCheckpointSummarizer } from "./checkpointSummarizer";
import { asContextOverflow } from "../../core/context/overflow";
import {
  requireStreamTerminal,
  StreamStallWatch,
  STREAM_STALL_TIMEOUT_MS,
} from "../streamReliability";
import { observabilityHub } from "../observability/hub";
import { newTraceId, newTurnId, type CorrelationContext } from "../observability/correlation";
import { MetricsRegistry, boundedModelLabel } from "../observability/metrics";
import { redactedErrorEvidence } from "../observability/redact";
import { parseTaskRequirements, evaluateCompletionGate, recordEvidence, emptyEvidence } from "../../core/agent/completionGate";
import type { CompletionEvidence, TaskRequirement } from "../../core/contracts";
// harness compatibility layer. POLICY ONLY: the profile shapes the
// prompt, the exposed tool set, the loop bounds and the completion verdict. It
// cannot change a permission decision, and it is never a second loop.
import {
  applyToolOrdering,
  composeSystemPrompt,
  computeVerdict,
  defaultProfile,
  emptyExecutionEvidence,
  ensureDenialsRetained,
  exceedsRepeatedToolCalls,
  ExecutionEvidenceCollector,
  exposedToolNames,
  fingerprintResponse,
  isMutationTool,
  isPassthroughToolPolicy,
  isShellTool,
  isToolExposed,
  looksLikeTestCommand,
  looksLikeVerificationCommand,
  maxTurnsError,
  noProgressError,
  prepareOptionsFor,
  ProgressTracker,
  repeatedToolCallError,
  resolveHarnessProfile,
  resolveMaxTurns,
  toolGuidance as toolPolicyGuidance,
  type ExecutionEvidence,
  type HarnessProfile,
} from "../../core/harness";
// Import the subagent pieces surgically (not via the module barrel) so the
// harness graph does not pull the manager + registry in eagerly.
import { DEFAULT_SUBAGENT_MAX_DEPTH, decideTool, type ToolPermissionScope } from "../../core/agent/agents/types";
import { permissionScopeFromSandbox } from "../../core/agent/agents/permissions";
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

/**
 * process-lifetime ledger of `session.start` activations.
 *
 * Deliberately module-level, not per-harness: `AgentEngine.run` constructs a
 * NEW harness for every turn, so an instance field would re-fire the hook on
 * each turn and break the exactly-once contract. Child sessions get their own
 * `sessionId` (subagent / teamwork ids), so they activate separately here too.
 */
const sessionStartActivated = new Set<string>();

/**
 * test seam: forget every activated session. Production code
 * never calls this; the process lifetime IS the dedup window.
 */
export function resetSessionStartLedger(): void {
  sessionStartActivated.clear();
}

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
 /** verified side effects from the most recent loop run. */
  private lastCompletionEvidence: CompletionEvidence = emptyEvidence();
 /** permission scope applied to every tool call in this run. */
  private toolPermissions?: ToolPermissionScope;
 /** maximum subagent nesting depth for this run. */
  private maxSubagentDepth = DEFAULT_SUBAGENT_MAX_DEPTH;
 /** approval hook handed to child subagents. */
  private approvalHook?: (input: { name: string; args: any; reason?: string }) => Promise<boolean>;
 /** the resolved policy contract for this harness instance. */
  private profile: HarnessProfile = defaultProfile;
 /** evidence collector for the active run (null outside a run). */
  private evidenceCollector: ExecutionEvidenceCollector | null = null;
 /** set when a requested profile id could not be resolved. */
  private profileError: string | null = null;
 /**
 * — explicit terminal run state.
   *
   * Deliberately NOT derived from the error string: a loop abort message
   * contains "Aborting loop.", so string-matching `abort` reported a stuck loop
   * as a user cancellation. The verdict must reflect what actually ended the
   * run.
   */
  private lastRunState: { cancelled: boolean; timedOut: boolean; approvalRequired: boolean } = {
    cancelled: false,
    timedOut: false,
    approvalRequired: false,
  };
 /** requirements parsed for the active run, for the verdict. */
  private lastRequirements: TaskRequirement = {
    mutationRequired: false,
    executionRequired: false,
    verificationRequired: false,
    testRequired: false,
  };

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

 // resolve the configured harness profile at construction.
    // A CONFIG-sourced id that the registry does not know falls back to
    // `default` and reports itself in the init event rather than bricking the
    // CLI; a PER-CALL id (below) is strict, because that is the one a user just
    // typed.
    if (config.harness) {
      try {
        this.profile = resolveHarnessProfile({ profile: config.harness }).profile;
      } catch (error) {
        this.profile = defaultProfile;
        this.profileError = error instanceof Error ? error.message : String(error);
      }
    }

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
      harness: this.profile.id,
      harnessError: this.profileError ?? undefined,
    });
  }

  /**
 * — apply a per-call harness id.
   *
   * An explicit id is a contract: an unknown one is recorded as an error and
   * the run fails loudly in `executeLoopInner` rather than silently running a
   * different behavioural contract.
   */
  private applyRunProfile(options?: ExecutionOptions): void {
    const requested = options?.harness;
    if (!requested) {
      this.profileError = null;
      return;
    }
    try {
      this.profile = resolveHarnessProfile({ profile: requested }).profile;
      this.profileError = null;
    } catch (error) {
      this.profileError = error instanceof Error ? error.message : String(error);
    }
  }
  /** Reset the explicit terminal state for a new run. */
  private resetRunState(): void {
    this.lastRunState = { cancelled: false, timedOut: false, approvalRequired: false };
  }

 // ── Workspace awareness () ─────────────────────────────────────────────

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

 /** the policy contract this harness instance runs under. */
  getProfile(): HarnessProfile {
    return this.profile;
  }

 /** observed evidence (files touched, commands, denials) for the last run. */
  getExecutionEvidence(): ExecutionEvidence {
    return this.evidenceCollector?.snapshot() ?? emptyExecutionEvidence();
  }

  /**
 * — tool EXPOSURE for this profile.
   *
   * Only shrinks (or reorders) the set offered to the model. Every executed
   * call still goes securityEngine → ToolGateway, so this has no way to grant a
   * capability that permission did not already allow.
   */
  private toolsForProfile() {
    const policy = this.profile.toolPolicy;
    if (isPassthroughToolPolicy(policy)) return toolRegistry.schemas();
    const filtered = toolRegistry.schemasFiltered((tool) => isToolExposed(tool.name, policy));
    return applyToolOrdering(filtered, policy);
  }

  /**
   * Compute the run verdict from evidence, then attach the harness identity so
   * every consumer can say which policy contract produced the result.
   */
  private finalizeResult(result: HarnessResult): HarnessResult {
    const { cancelled, timedOut, approvalRequired } = this.lastRunState;
    const evidence = this.getExecutionEvidence();
    const verified = this.lastCompletionEvidence;

    const { verdict, reasons } = computeVerdict({
      policy: this.profile.completionPolicy,
      requirements: this.lastRequirements,
      verified: {
        mutations: verified.successfulMutations,
        executions: verified.successfulExecutions,
        tests: verified.testsPassed,
        verifications: verified.verificationsPassed,
      },
      evidence,
      runSucceeded: result.success,
      cancelled,
      timedOut,
      hasOutput: Boolean(result.output),
    });

    return {
      ...result,
      harnessId: this.profile.id,
      harnessVersion: this.profile.version,
      verdict,
      completionReasons: reasons,
      executionEvidence: evidence,
      approvalRequired,
    };
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

 // ── LLM Runtime () ──────────────────────────────────────────────

  /**
   * The ONLY place the agent loop talks to a model. Every provider response is
   * normalized by ModelAdapter, so no raw provider schema (OpenAI deltas,
   * Anthropic blocks, gateway payloads) ever reaches the loop.
   *
   * When `wantStream` is set and the provider supports streaming, deltas are
   * emitted as contract events (`agent:stream_chunk` / `agent:reasoning_chunk`)
   * and the final response is reassembled from them. Otherwise a single
   * non-streaming completion is used.
   *
 * — `routes` is the ordered provider/upstream chain for this
   * model. A single route (the default: no fallback configured) takes the
 * legacy path verbatim. A multi-route chain walks it with BOUNDED
   * fallback: each route once, retryable failures only, and never after output
   * has already been streamed to the user.
   */
  private async completeModel(
    provider: Provider,
    req: {
      model: string;
      messages: any[];
      tools?: any[];
      toolChoice?: "auto" | "required" | "none";
      headers?: Record<string, string>;
      signal?: AbortSignal;
      onContentDelta?: (text: string) => void;
      reasoningEffort?: "low" | "medium" | "high";
      /** forwarded to the model hooks as session metadata. */
      sessionId?: string;
      turn?: number;
      runId?: string;
    },
    mode: ExecutionMode,
    wantStream: boolean,
    routes?: ProviderRoute[]
  ): Promise<{ response: AgentModelResponse; hadMessage: boolean; route?: ProviderRoute }> {
    const chain = routes && routes.length > 1 ? routes : [];

    // Identity path: exactly one route — no fallback machinery is engaged.
    if (chain.length === 0) {
      const startedAt = Date.now();
      try {
        const result = await this.completeModelOnce(provider, req, mode, wantStream);
 // health derives from observed outcomes only.
        noteModelSuccess(provider.id, Date.now() - startedAt);
        try {
          const dur = Date.now() - startedAt;
          observabilityHub.metrics.increment(MetricsRegistry.NAMES.modelRequestCount, { labels: { model: boundedModelLabel(req.model) } });
          observabilityHub.metrics.increment(MetricsRegistry.NAMES.modelRequestDuration, { labels: { model: boundedModelLabel(req.model) }, valueMs: dur });
          observabilityHub.metrics.increment(MetricsRegistry.NAMES.providerAttemptCount, { labels: { provider: provider.id } });
          observabilityHub.metrics.increment(MetricsRegistry.NAMES.providerAttemptDuration, { labels: { provider: provider.id }, valueMs: dur });
        } catch {}
        return result;
      } catch (error) {
        noteModelFailure(provider.id, error instanceof Error ? error.message : String(error));
        try {
          const ev = redactedErrorEvidence(error);
          observabilityHub.metrics.increment(MetricsRegistry.NAMES.modelRequestError, { labels: { model: boundedModelLabel(req.model), error_class: ev.code ?? "network" } });
          observabilityHub.metrics.increment(MetricsRegistry.NAMES.providerAttemptCount, { labels: { provider: provider.id, error_class: ev.code ?? "network" } });
        } catch {}
        throw error;
      }
    }

    // Multi-route chain. `emitted` makes a partially streamed turn terminal: the
    // consumer already saw output, so replaying it on another provider would
    // duplicate content and corrupt the transcript.
    let emitted = false;
    const outcome = await invokeRouteChain(
      chain,
      async (route) => {
        const instance = this.providerForRoute(route) ?? provider;
        return this.completeModelOnce(
          instance,
          {
            ...req,
            model: route.apiModelId,
            onFirstDelta: () => {
              emitted = true;
            },
          },
          mode,
          wantStream
        );
      },
      {
        ...(req.signal ? { signal: req.signal } : {}),
        maxAttempts: chain.length,
        // Terminal once anything reached the user, or the caller cancelled.
        isTerminal: (error) => emitted || req.signal?.aborted === true,
        onAttempt: (record) => {
          try {
            if (!record.ok) {
              observabilityHub.metrics.increment(MetricsRegistry.NAMES.providerAttemptCount, { labels: { provider: record.providerId, error_class: record.failureKind ?? "unknown" } });
            }
            if (!record.ok && record.retryable) {
              observabilityHub.metrics.increment(MetricsRegistry.NAMES.providerFallbackCount, { labels: { provider: record.providerId } });
            }
          } catch {}
          if (!record.ok && record.retryable) {
            this.emitEvent("agent:routing", mode, {
              routeId: record.routeId,
              providerId: record.providerId,
              failureKind: record.failureKind,
              message: `provider ${record.providerId} failed (${record.failureKind ?? "error"}); trying next route`,
            });
          }
        },
      }
    );

 // — the chain just produced real routing evidence (latency,
    // success, failure classifications). Snapshot the derived numeric
    // intelligence to disk so the next process routes on it. Best-effort: a
    // persistence failure can never fail a completed request.
    persistRoutingIntelligence();

    return { ...outcome.result, route: outcome.route };
  }

  /**
   * Build the adapter for a fallback route without a second provider factory.
   * Returns null when the registry cannot produce an instance, in which case the
   * caller keeps the already-resolved provider.
   */
  private providerForRoute(route: ProviderRoute): Provider | null {
    try {
      return providerRegistry.createInstance(route.providerId);
    } catch {
      return null;
    }
  }

  /** One provider call without health bookkeeping, so success/failure is exact. */
  private async completeModelOnce(
    provider: Provider,
    req: {
      model: string;
      messages: any[];
      tools?: any[];
      toolChoice?: "auto" | "required" | "none";
      headers?: Record<string, string>;
      signal?: AbortSignal;
      onContentDelta?: (text: string) => void;
 /** fires once, on the first emitted delta of any kind. */
      onFirstDelta?: () => void;
      reasoningEffort?: "low" | "medium" | "high";
      sessionId?: string;
      turn?: number;
      runId?: string;
    },
    mode: ExecutionMode,
    wantStream: boolean
  ): Promise<{ response: AgentModelResponse; hadMessage: boolean }> {
    const adapter = new ModelAdapter(provider);
    let firstDeltaSeen = false;
    // Only USER-VISIBLE deltas count: partial tool-call deltas are internal (the
    // tool has not run yet), so a failure after them is still safely retryable.
    const noteFirstDelta = () => {
      if (firstDeltaSeen) return;
      firstDeltaSeen = true;
      req.onFirstDelta?.();
    };
    const canStream = typeof provider.stream === "function";

    if (!wantStream || !canStream) {
      const response = await adapter.complete({
        model: req.model,
        messages: req.messages,
        tools: req.tools,
        toolChoice: req.toolChoice,
        headers: req.headers,
        signal: req.signal,
        reasoningEffort: req.reasoningEffort,
        sessionId: req.sessionId,
      });
      return {
        response,
        hadMessage: response.content.length > 0 || response.toolCalls.length > 0 || response.finishReason != null,
      };
    }

    let content = "";
    let reasoning = "";
    let reasoningStarted = false;
    let reasoningStartTime = 0;
    let usage: AgentModelResponse["usage"] | undefined;
    let finishReason: string | null = null;
    let sawChunk = false;
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();

    // Two observability-backed reliability guards, armed only for real streams:
    // inactivity abort (a live socket can still be dead) and terminal
    // validation (an EOF without protocol evidence is not success).
    const stallAbort = new AbortController();
    const combinedStallSignal = req.signal
      ? AbortSignal.any([req.signal, stallAbort.signal])
      : stallAbort.signal;
    const stallWatch = new StreamStallWatch(STREAM_STALL_TIMEOUT_MS, () => {
      stallAbort.abort();
    });

    try {
      stallWatch.start();
      for await (const chunk of adapter.stream({
        model: req.model,
        messages: req.messages,
        tools: req.tools,
        toolChoice: req.toolChoice,
        headers: req.headers,
        signal: combinedStallSignal,
        reasoningEffort: req.reasoningEffort,
        sessionId: req.sessionId,
      })) {
        stallWatch.noteChunk();
        sawChunk = true;

        if (chunk.reasoningDelta) {
          noteFirstDelta();
          if (!reasoningStarted) {
            reasoningStarted = true;
            reasoningStartTime = Date.now();
            this.emitEvent("agent:reasoning_start", mode, {
              id: `rs_${Date.now()}`,
              turn: req.turn ?? 0,
              runId: req.runId,
              timestamp: reasoningStartTime,
            });
          }
          reasoning += chunk.reasoningDelta;
          this.emitEvent("agent:reasoning_chunk", mode, {
            text: chunk.reasoningDelta,
            turn: req.turn ?? 0,
            runId: req.runId,
            timestamp: Date.now(),
          });
        }

        if (reasoningStarted && (chunk.contentDelta || chunk.toolCallDelta)) {
          reasoningStarted = false;
          this.emitEvent("agent:reasoning_end", mode, {
            id: `rs_${reasoningStartTime}`,
            turn: req.turn ?? 0,
            runId: req.runId,
            durationMs: Date.now() - reasoningStartTime,
            timestamp: Date.now(),
          });
        }

        if (chunk.contentDelta) {
          noteFirstDelta();
          content += chunk.contentDelta;
          this.emitEvent("agent:stream_chunk", mode, { text: chunk.contentDelta });
          req.onContentDelta?.(chunk.contentDelta);
        }

        if (chunk.toolCallDelta) {
          const d = chunk.toolCallDelta;
          const idx = d.index ?? 0;
          const cur = toolAcc.get(idx) ?? { id: "", name: "", args: "" };
          if (d.id) cur.id = d.id;
          if (d.name) cur.name = d.name;
          if (d.argumentsDelta) cur.args += d.argumentsDelta;
          toolAcc.set(idx, cur);
        }

        if (chunk.usage) usage = chunk.usage;
        if (chunk.finishReason) finishReason = chunk.finishReason;
      }

      if (reasoningStarted) {
        reasoningStarted = false;
        this.emitEvent("agent:reasoning_end", mode, {
          id: `rs_${reasoningStartTime}`,
          turn: req.turn ?? 0,
          runId: req.runId,
          durationMs: Date.now() - reasoningStartTime,
          timestamp: Date.now(),
        });
      }
    } catch (streamErr: any) {
      // An inactivity abort reads as a TIMEOUT (retryable), never as a user
      // cancellation (terminal) — the AbortError produced by the stall abort is
      // converted so failure classification stays truthful. A genuine user
      // abort (req.signal) keeps its original error.
      if (stallWatch.stalled && !req.signal?.aborted) {
        const timeoutErr: any = new Error(
          `Provider stream stalled: no chunk within ${STREAM_STALL_TIMEOUT_MS}ms.`,
        );
        timeoutErr.name = "TimeoutError";
        throw timeoutErr;
      }
      throw streamErr;
    } finally {
      // Disarm without recording a stall; a clean end is not inactivity.
      stallWatch.complete();
    }

    // A connection that dissolved without protocol evidence is incomplete,
    // not successful: classified as a retryable failure, never fake success.
    requireStreamTerminal({ sawChunk, sawFinishReason: finishReason != null, sawUsage: usage != null });

    const toolCalls: AgentToolCall[] = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, t]) => ({
        id: t.id || `call_${idx}`,
        name: t.name,
        arguments: safeParseJson(t.args),
      }));

    return {
      response: {
        content,
        reasoningSummary: reasoning || undefined,
        toolCalls,
        usage,
        finishReason,
      },
      hadMessage: sawChunk,
    };
  }

  // ── Tool Execution Middleware ─────────────────────────────────────────────

  async dispatchTool(
    name: string,
    args: any,
    options: { cwd?: string; userApproved?: boolean; agentRole?: string; agentDepth?: number; signal?: AbortSignal; onProgress?: (progress: any) => void } = {}
  ): Promise<{ result: string; allowed: boolean; reason?: string; needsApproval?: boolean }> {
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

 // scope gate. A tool denied by the active permission scope is
    // refused BEFORE the security gateway, so a scoped agent (plan mode, a
    // role-scoped subagent) can never reach an out-of-scope executor. This is
    // the enforcement half of `deriveSubagentPermission`: the derived scope is
    // not advisory, it is a hard gate.
    const scope = this.toolPermissions;
    if (scope) {
      const verdict = decideTool(scope, name);

      // An explicit deny can never be unlocked — not by the model, and not by
      // a user approval prompt for a different (ASK) tool.
      if (verdict === "deny") {
        this.metrics.toolCallsExecuted++;
        this.emitEvent("tool:error", this.activeMode, {
          toolName: name,
          toolArgs: args,
          reason: "denied-by-scope",
        });
        return {
          result: JSON.stringify({
            error: `Permission Denied: tool '${name}' is not permitted in this agent's scope.`,
          }),
          allowed: false,
          reason: `Tool '${name}' is outside the active permission scope.`,
        };
      }

      if (verdict === "ask" && options.userApproved !== true) {
        this.metrics.toolCallsExecuted++;
        this.emitEvent("tool:approval_required", this.activeMode, {
          toolName: name,
          toolArgs: args,
          reason: "scope-requires-approval",
        });
        return {
          result: JSON.stringify({
            stdout: "",
            stderr: `Approval Required: tool '${name}' is gated by the active permission scope.`,
            exitCode: 1,
            approvalRequired: true,
          }),
          allowed: false,
          needsApproval: true,
          reason: `Tool '${name}' requires approval in the active permission scope.`,
        };
      }
    }

    const { ToolGateway } = await import("../security/toolGateway");
    const agentDepth = options.agentDepth ?? (this.activeMode === "SUBAGENT" ? 1 : 0);
    const gatewayRes = await ToolGateway.execute({ name, args }, {
      cwd,
      workspaceRoot: this.config.workspaceRoot,
      sandboxMode: mode,
      userApproved: options.userApproved,
      agentRole: options.agentRole || (this.activeMode === "SUBAGENT" ? "subagent" : undefined),
      agentDepth,
      sessionId: this.config.sessionId,
      source: this.activeMode === "SUBAGENT" ? "subagent" : this.activeMode === "TEAMWORK" ? "teamwork" : "headless",
      signal: options.signal,
      onProgress: options.onProgress,
 // a `task` call derives the child scope from the SPAWNING
      // turn's scope. Absent an explicit scope, the sandbox mode is the honest
      // baseline (never unbounded).
      subagent: {
        permission: scope ?? permissionScopeFromSandbox(mode),
        depth: agentDepth,
        maxDepth: this.maxSubagentDepth,
        ...(this.approvalHook ? { requestApproval: this.approvalHook } : {}),
      },
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
        needsApproval: true,
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

    const rawOutput = gatewayRes.stdout;
    let output: string;
    try {
      const parsedOutput = JSON.parse(rawOutput);
      output = parsedOutput && typeof parsedOutput === "object"
        ? rawOutput
        : JSON.stringify({ stdout: rawOutput, stderr: "", exitCode: 0 });
    } catch {
      output = JSON.stringify({ stdout: rawOutput, stderr: "", exitCode: 0 });
    }

 // : mutations get LSP diagnostics as supplementary feedback so the
    // model can repair before running a full test. This never spawns a server
    // and never throws — see `withLspDiagnostics`.
    if (isWriteTool && typeof args?.path === "string" && !options.signal?.aborted) {
      output = await this.withLspDiagnostics(args.path, output, cwd, options.signal);
    }

    this.metrics.rawToolOutputChars += output.length;
    this.metrics.retainedToolOutputChars += output.length;

    return {
      result: output,
      allowed: true,
    };
  }

  /**
   * Attach `<diagnostics>` for a just-mutated file when a language server is
   * already running for it. Deliberately does NOT spawn a server: paying a
   * startup handshake on every edit would be worse than the diagnostics are
   * worth. Failures are swallowed — diagnostics are an optional layer, never a
   * prerequisite for completing a task.
   */
  private async withLspDiagnostics(
    targetPath: string,
    output: string,
    cwd: string,
    signal?: AbortSignal
  ): Promise<string> {
    try {
      const absolute = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
      const { getLspManager } = await import("../../core/lsp/manager");
      const manager = getLspManager({ workspaceRoot: this.config.workspaceRoot || cwd, cwd });
      if (!manager.hasActiveClient(absolute)) return output;
      const items = await manager.diagnostics(absolute, { signal });
      if (items.length === 0) return output;
      const { formatDiagnosticsReport } = await import("../../core/lsp/diagnostics");
      const report = formatDiagnosticsReport(absolute, items);
      return report ? `${output}\n${report}` : output;
    } catch {
      return output;
    }
  }

  getChangeTracker(): ChangeTracker {
    return this.changeTracker;
  }

  getTaskContextManager(): TaskContextManager {
    return this.taskContextManager;
  }

  // ── Core Execution Loop ──────────────────────────────────────────────────

  /**
 * public loop entry that brackets the whole turn with the
   * `agent.start` / `agent.end` hooks.
   *
   * Every front-end (TUI, headless, subagent, teamwork node, REPL) funnels
   * through this method, so a plugin observes exactly one start/end pair per
   * agent turn no matter which entry point was used. Firing happens here rather
   * than in each front-end precisely so it cannot be forgotten or doubled.
   */
  async executeLoop(
    initialMessages: ContextMessage[],
    options: ExecutionOptions = {},
    mode: ExecutionMode = "HEADLESS",
  ): Promise<HarnessResult> {
    const sessionId = options.sessionId || this.config.sessionId || "session";
    const model = options.model || this.config.model || "";
    const hookMeta = { sessionId, signal: options.signal };

 // per-call harness selection wins over the configured one. Done
    // before anything else so policy (and the prompt built by the caller's
    // entry point) reflects the requested contract.
    this.applyRunProfile(options);

    await this.fireSessionStart(sessionId, mode);

    await hookRegistry.run(
      "agent.start",
      { sessionId, model, mode },
      { sessionId, model, mode },
      hookMeta,
    );

 // — evidence is derived from this harness's own event stream.
    // A nested run (a subagent spawned by a tool call) gets its own collector,
    // and the parent's is restored on the way out so the parent's verdict is
    // computed from the parent's evidence.
    const previousCollector = this.evidenceCollector;
    const previousRequirements = this.lastRequirements;
    const previousEvidence = this.lastCompletionEvidence;
    const previousRunState = this.lastRunState;
    const collector = new ExecutionEvidenceCollector();
    this.evidenceCollector = collector;
    const unsubscribeEvidence = this.on((event) => collector.observe(event));

    try {
      const inner = await this.executeLoopInner(initialMessages, options, mode);
 // — the verdict is computed from evidence, never from narration alone.
      const result = this.finalizeResult(inner);
      await hookRegistry.run(
        "agent.end",
        { sessionId, model, mode, success: result.success },
        { sessionId, model, success: result.success, error: result.error },
        hookMeta,
      );
      return result;
    } catch (error) {
      // A plugin must still see the end of a crashed turn.
      await hookRegistry.run(
        "agent.end",
        { sessionId, model, mode, success: false },
        {
          sessionId,
          model,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        hookMeta,
      );
      throw error;
    } finally {
      unsubscribeEvidence();
      this.evidenceCollector = previousCollector;
      this.lastRequirements = previousRequirements;
      this.lastCompletionEvidence = previousEvidence;
      this.lastRunState = previousRunState;
    }
  }

  /**
 * the canonical `session.start` edge.
   *
   * Contract: `session.start` means SESSION ACTIVATION, not per-turn setup. It
   * fires exactly once per sessionId per process lifetime, on the FIRST turn
   * that runs under that session — a fresh CLI session, a resumed session, a
   * subagent child session or a teamwork node child all activate exactly once.
   *
   * Why the harness: executeLoop is the ONE loop entry every front-end funnels
   * through (TUI, headless, REPL, subagent, teamwork node), so activation can
   * neither be forgotten by a front-end nor double-reported. This is the same
   * reasoning that puts `agent.start`/`agent.end` here.
   *
   * Why process-lifetime exactly-once: the persisted-session world has no
   * server-side creation event — a `sess_*` file may already exist on disk when
   * this process starts, and `AgentEngine.run` builds a fresh harness per turn.
   * A per-instance ledger would therefore re-fire on every turn. "First
   * activation in this runtime" is the only edge every consumer can agree on;
   * resuming a session this process has already activated never re-fires it.
   *
   * Hook failures are observe-class (`warn`): activation must never be able to
   * break the turn it precedes.
   */
  private async fireSessionStart(sessionId: string, mode: ExecutionMode): Promise<void> {
    if (sessionStartActivated.has(sessionId)) return;
    sessionStartActivated.add(sessionId);
    try {
      await hookRegistry.run(
        "session.start",
        { sessionId, mode },
        { sessionId, mode },
        { sessionId },
      );
    } catch {
      // The registry already records failures per policy; activation itself
      // must be unconditional.
    }
  }

  private async executeLoopInner(
    initialMessages: ContextMessage[],
    options: ExecutionOptions = {},
    mode: ExecutionMode = "HEADLESS"
  ): Promise<HarnessResult> {
    const startTime = Date.now();
    const sessionId = options.sessionId || this.config.sessionId || "session";
    const timeoutMs = options.timeoutMs || this.config.timeoutMs || 120000;
    const turnId = newTurnId();
    const traceId = newTraceId();
    const corr: CorrelationContext = { sessionId: options.sessionId || this.config.sessionId || "session", turnId, traceId };
    const turnSpan = (() => { try { return observabilityHub.trace.start("agent_turn", `turn:${corr.sessionId}`, corr); } catch { return null; } })();
    try { observabilityHub.info("harness", "turn.start", { correlation: corr, metadata: { mode, model: options.model || this.config.model } as any }); } catch {}
    try { observabilityHub.metrics.increment(MetricsRegistry.NAMES.sessionTurnCount, { labels: { operation: "turn" } }); } catch {}
 // — an explicit caller budget always wins, then the profile's.
    const maxTurns = resolveMaxTurns(
      options.maxTurns,
      this.profile.continuationPolicy.maxTurns,
      this.config.maxTurns,
      10,
    );
    this.resetRunState();
    this.lastCompletionEvidence = emptyEvidence();
    // A run started with an already-aborted signal is a cancellation, not a
    // model failure — and it must not call the provider at all.
    if (options.signal?.aborted) {
      // No state transition: the run never entered thinking, and
      // `idle → cancelled` is not a legal edge in the state machine.
      this.lastRunState.cancelled = true;
      this.emitEvent("agent:error", mode, { error: "Execution cancelled by user" });
      try {
        observabilityHub.info("harness", "turn.cancelled", { correlation: corr, outcome: "cancelled" });
        if (turnSpan) observabilityHub.trace.end(turnSpan.spanId, "cancelled", "cancelled");
      } catch {}
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
        error: "Execution cancelled by user",
      };
    }

 // — a requested profile that does not exist fails the run with
    // a structured error. Running a different contract than the caller asked
    // for would make every result (and every eval) untrustworthy.
    if (this.profileError) {
      this.emitEvent("agent:error", mode, {
        error: this.profileError,
        code: "HARNESS_PROFILE_NOT_FOUND",
      });
      try {
        const ev = redactedErrorEvidence(this.profileError);
        observabilityHub.error("harness", "turn.error", { correlation: corr, error: { message: ev.message, code: "HARNESS_PROFILE_NOT_FOUND" }, outcome: "error" });
        observabilityHub.metrics.increment(MetricsRegistry.NAMES.sessionTurnCount, { labels: { outcome: "error", error_class: "bad-request" } });
        if (turnSpan) observabilityHub.trace.end(turnSpan.spanId, "error", "HARNESS_PROFILE_NOT_FOUND");
      } catch {}
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
        error: this.profileError,
      };
    }

 // the harness resolves provider + model through the canonical
    // ModelRouter (never its own provider map). `resolveRuntimeModel` degrades
    // to the legacy active-provider path when the catalog cannot satisfy the
    // reference, so no existing configuration changes behaviour.
    const modelResolution = resolveRuntimeModel(options.model || this.config.model, {
      gatewayUrl: options.gatewayUrl || this.config.gatewayUrl,
    });
    const model = modelResolution.model;
    const provider = modelResolution.provider;

    if (!provider) {
      const errorMsg = "No active AI provider configured.";
      this.emitEvent("agent:error", mode, { error: errorMsg });
      try {
        observabilityHub.error("harness", "turn.error", { correlation: corr, error: { message: errorMsg, code: "NO_PROVIDER" }, outcome: "error" });
        observabilityHub.metrics.increment(MetricsRegistry.NAMES.sessionTurnCount, { labels: { outcome: "error", error_class: "bad-request" } });
        if (turnSpan) observabilityHub.trace.end(turnSpan.spanId, "error", "NO_PROVIDER");
      } catch {}
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
    let awaitingToolSynthesis = false;
    // Tool calls that FAILED or were DENIED. A denied write can never satisfy
    // its requirement, so the gate must let the model report the failure
    // honestly rather than loop until the turn budget runs out.
    let failedToolCalls = 0;

 // Completion Gate: derive task requirements from the user
    // prompt (or caller-provided requirements) and track verified evidence.
    const userPrompt =
      [...initialMessages].reverse().find((m) => m.role === "user")?.content ?? "";
    const requirements: TaskRequirement =
      options.taskRequirements ??
      (userPrompt ? parseTaskRequirements(String(userPrompt)) : { mutationRequired: false, executionRequired: false, verificationRequired: false, testRequired: false });
    const evidence: CompletionEvidence =
      options.completionEvidence ?? emptyEvidence();
    this.lastCompletionEvidence = evidence;
    this.lastRequirements = requirements;

 // — progress is bounded per profile. `0` disables the bound,
    // which is what keeps the identity profile's loop unchanged.
    const progress = new ProgressTracker(
      this.profile.continuationPolicy.maxConsecutiveNoProgressTurns,
    );
    const snapshotEvidence = () =>
      this.evidenceCollector?.snapshot() ?? emptyExecutionEvidence();

    /**
 * — one progress sample per model turn. Returns a structured abort when
     * the bound is reached, else null. Disabled for the identity profile.
     */
    const checkProgress = (responseText: string): { error: string } | null => {
      if (!progress.enabled) return null;
      const observed = snapshotEvidence();
      const observation = progress.observe({
        responseFingerprint: fingerprintResponse(responseText),
        toolCalls: observed.toolCalls,
        mutations: observed.filesChanged.length,
        commands: observed.commandsRun,
        diagnostics: observed.diagnostics,
        finalResponse: false,
        newFiles: observed.filesChanged.length,
      });
      if (!progress.exceeded()) return null;
      return { error: noProgressError(observation.noProgressTurns) };
    };

    this.lastToolSig = null;
    this.consecutiveToolRepeat = 0;
    this.activeMode = mode;
    this.toolPermissions = options.toolPermissionSet;
    this.maxSubagentDepth = options.subagentMaxDepth ?? DEFAULT_SUBAGENT_MAX_DEPTH;
    this.approvalHook = options.requestApproval;

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

 // notification instead of polling. Runtime messages that
      // arrived for this session (a finished background task) are drained into
      // the conversation before the next model turn, so the model learns about
      // the result through its own context rather than by sleeping and asking.
      const pendingNotifications = sessionInbox.drain(sessionId);
      for (const notification of pendingNotifications) {
        messages.push({ role: "user", content: notification.content });
        this.emitEvent("agent:notification", mode, {
          notificationId: notification.id,
          jobId: notification.jobId,
          text: notification.content,
        });
      }

      if (Date.now() - startTime > timeoutMs) {
        this.lastRunState.timedOut = true;
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

 // — the profile picks the compression strategy; token
      // accounting stays the ContextEngine's (one estimator, not two).
      //
      // The checkpoint summary is written through THIS loop's single model path,
      // with tools disabled and a bounded output — the compaction layer never
      // reaches for a provider itself.
      const prep = await contextEngine.prepareMessagesForApi(messages, {
        model,
        sessionId,
        summarizeWithModel: makeCheckpointSummarizer({
          provider,
          model,
          ...(combinedSignal ? { signal: combinedSignal } : {}),
        }),
        ...prepareOptionsFor(this.profile.contextPolicy),
      });
      accumulatedTokens = prep.budget.currentEstimatedTokens;
      this.totalTokensUsed += accumulatedTokens;

      // A narrowed window must never erase a permission decision: a model that
      // "forgot" a DENY would simply issue the same call again, making a
      // permission problem look like a stuck model.
      const denials = this.evidenceCollector?.denials() ?? [];
      const retention = ensureDenialsRetained(
        prep.messages,
        denials,
        this.profile.contextPolicy,
      );
      if (retention.appended && (prep.compacted || prep.prunedCount > 0)) {
        messages.push({ role: "user", content: retention.appended });
        this.emitEvent("agent:thinking", mode, {
          permissionDecisionsRetained: denials.length,
        });
      }
      let preparedMessages =
        retention.appended && (prep.compacted || prep.prunedCount > 0)
          ? retention.messages
          : prep.messages;

      if (prep.compacted) {
        this.emitEvent("agent:compact", mode, {
          originalTokens: prep.budget.currentEstimatedTokens,
          newCount: prep.messages.length,
          usableTokens: prep.budget.usableTokens,
          usableRule: prep.budget.usableRule,
        });
      }

 // — capability-gate tool definitions: models that declare
      // `tools: false` never receive tool schemas, so they cannot pretend to
      // call tools. Models without native tool calling still receive schemas;
      // their structured JSON tool blocks are parsed by the adapter below.
      const caps = getModelCapabilities(model);
      const toolsForRequest =
        caps?.tools === false
          ? undefined
          : // toolsOverride wins (subagent scoping, plan mode),
            // then the profile's EXPOSURE policy over the canonical registry.
            options.toolsOverride || this.toolsForProfile();

      let modelRes: { response: AgentModelResponse; hadMessage: boolean };
      // A provider reporting context overflow is the ONE failure compaction can
      // actually fix: compact the model-facing context and retry this same turn.
      // `overflowRetried` bounds that to a single attempt, so a request that is
      // genuinely too large fails loudly instead of compacting in a loop.
      let overflowRetried = false;
      for (;;) {
      try {
        modelRes = await this.completeModel(
          provider,
          {
            model,
            messages: preparedMessages,
            tools: toolsForRequest,
            toolChoice: toolsForRequest ? options.toolChoice || "auto" : undefined,
            headers: extraHeaders,
            signal: combinedSignal,
            onContentDelta: options.onChunk,
            reasoningEffort: resolveReasoningEffort(model, options.reasoningSettings),
            sessionId,
            turn: turnsUsed,
          },
          mode,
          options.stream === true,
 // the provider/upstream chain the router decided. A single
 // route keeps the exact legacy path; a multi-route chain (only
          // present when fallback is configured) enables bounded fallback.
          modelResolution.resolved?.routes
        );
        break;
      } catch (netErr: any) {
        if (options.signal?.aborted || abort.signal?.aborted) {
          this.lastRunState.cancelled = true;
          this.agentState.transition("cancelled");
          this.emitEvent("agent:error", mode, { error: "Execution cancelled by user" });
          try {
            observabilityHub.info("harness", "turn.cancelled", { correlation: corr, outcome: "cancelled" });
            observabilityHub.metrics.increment(MetricsRegistry.NAMES.sessionTurnCount, { labels: { outcome: "cancelled", error_class: "cancelled" } });
            if (turnSpan) observabilityHub.trace.end(turnSpan.spanId, "cancelled", "cancelled");
          } catch {}
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
        // A provider call aborted by the run's own timeout budget is a TIMEOUT,
        // not a network failure.
        if (timeoutSignal.aborted) this.lastRunState.timedOut = true;
        const ev = redactedErrorEvidence(netErr);

        // Overflow recovery: classify BEFORE treating this as a network error,
        // because routing a payload the model already rejected to another
        // provider would just replay it against a different counter.
        if (!overflowRetried) {
          const overflow = asContextOverflow(
            {
              message: ev.message,
              ...(ev.code ? { code: ev.code } : {}),
              ...(ev.status !== undefined ? { status: ev.status } : {}),
            },
            { provider: provider.id, model, cause: netErr },
          );
          if (overflow) {
            overflowRetried = true;
            try {
              const recovered = await contextEngine.prepareMessagesForApi(messages, {
                model,
                sessionId,
                // The provider already rejected this request: compaction is not
                // optional here, it is the only way the turn can proceed.
                forceCompact: true,
                summarizeWithModel: makeCheckpointSummarizer({
                  provider,
                  model,
                  ...(combinedSignal ? { signal: combinedSignal } : {}),
                }),
              });
              if (recovered.compacted) {
                preparedMessages = recovered.messages;
                accumulatedTokens = recovered.budget.currentEstimatedTokens;
                this.emitEvent("agent:compact", mode, {
                  trigger: "provider_overflow",
                  matchedBy: overflow.matchedBy,
                  originalTokens: prep.budget.currentEstimatedTokens,
                  compactedTokens: recovered.budget.currentEstimatedTokens,
                  newCount: recovered.messages.length,
                  usableTokens: recovered.budget.usableTokens,
                  usableRule: recovered.budget.usableRule,
                });
                continue;
              }
            } catch {
              // Recovery is best-effort: fall through to the honest error below.
            }
          }
        }

        const errorMsg = `Gateway network error: Network/Gateway connection failed: ${ev.message}`;
        this.agentState.transition("error", "network");
        this.emitEvent("agent:error", mode, { error: errorMsg });
        try {
          const dur = Date.now() - startTime;
          observabilityHub.error("harness", "turn.error", { correlation: corr, error: { message: ev.message, ...(ev.code ? { code: ev.code } : {}), ...(ev.status !== undefined ? { status: ev.status } : {}) }, durationMs: dur, outcome: timeoutSignal.aborted ? "timeout" : "error" });
          observabilityHub.metrics.increment(MetricsRegistry.NAMES.modelRequestError, { labels: { model: boundedModelLabel(model), error_class: timeoutSignal.aborted ? "timeout" : "network" } });
          observabilityHub.metrics.increment(MetricsRegistry.NAMES.sessionTurnCount, { labels: { outcome: timeoutSignal.aborted ? "timeout" : "error", error_class: timeoutSignal.aborted ? "timeout" : "network" } });
          if (turnSpan) observabilityHub.trace.end(turnSpan.spanId, "error", ev.code ?? "network");
        } catch {}
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
      }

      const agentRes = modelRes.response;
      const assistantContent = agentRes.content || "";

      if (agentRes.usage) {
        contextEngine.recordUsage(
          {
            promptTokens: agentRes.usage.inputTokens,
            completionTokens: agentRes.usage.outputTokens,
            totalTokens: agentRes.usage.totalTokens,
            reasoningTokens: agentRes.usage.reasoningTokens,
          },
          sessionId
        );
      }

      if (!modelRes.hadMessage && !awaitingToolSynthesis) {
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

      // Re-serialize normalized tool calls into the provider wire shape so the
      // transcript stays replayable by any adapter on the next turn.
      const nativeToolCalls = agentRes.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
        },
      }));

      messages.push({
        role: "assistant",
        content: assistantContent,
        ...(nativeToolCalls.length ? { tool_calls: nativeToolCalls as any } : {}),
      });

      const toolCalls = agentRes.toolCalls;
      if (awaitingToolSynthesis && toolCalls.length === 0 && assistantContent.trim().length === 0) {
        this.agentState.transition("thinking", "awaiting-tool-synthesis");
        this.emitEvent("agent:thinking", mode, {
          turnsUsed,
          toolCallsCount,
          reason: "awaiting-tool-synthesis",
        });
        continue;
      }

      if (!toolCalls || toolCalls.length === 0) {
        if (bypassEngine.isEnabled() && bypassEngine.getConfig().autoEscalate && turnsUsed < maxTurns) {
          const refusal = bypassEngine.checkRefusal(assistantContent);
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

        const finalOutput = assistantContent;

        // ── Completion Gate (9) ────────────────────────────────────
        // A text-only answer is NOT final when the task required a mutation.
        // Completion is based on verified task evidence, never narration or the
        // absence of tool calls in the current turn.
        //
        // After verified tool work the loop waits for the assistant's synthesis.
        // An EMPTY turn is not a synthesis (handled above: it re-prompts), but
        // once the model produces real prose that prose IS the synthesis — so the
        // gate decides on evidence instead of continuing forever.
        const gate = evaluateCompletionGate({
          requirements,
          evidence,
          proposedAnswer: finalOutput,
          turnsRemaining: maxTurns - turnsUsed,
          toolCallsExecuted: toolCallsCount,
          failedToolCalls,
        });
        if (gate.decision === "continue") {
          // — a repeated non-answer that the gate rejects is not progress.
          const stalledAtGate = checkProgress(finalOutput);
          if (stalledAtGate) {
            this.agentState.transition("error", "no-progress");
            this.emitEvent("agent:error", mode, { error: stalledAtGate.error, gateReason: gate.reason });
            try {
              observabilityHub.warn("harness", "turn.no_progress", { correlation: corr, outcome: "error", errorCode: "NO_PROGRESS", metadata: { gateReason: gate.reason } as any });
              observabilityHub.metrics.increment(MetricsRegistry.NAMES.sessionTurnCount, { labels: { outcome: "error", error_class: "no_progress" } });
              if (turnSpan) observabilityHub.trace.end(turnSpan.spanId, "error", "NO_PROGRESS");
            } catch {}
            return {
              success: false,
              output: finalOutput,
              messages,
              toolCallsCount,
              turnsUsed,
              tokensUsed: accumulatedTokens,
              durationMs: Date.now() - startTime,
              mode,
              sessionId,
              evidence: { ...evidence },
              error: stalledAtGate.error,
            };
          }
          this.agentState.transition("thinking", "completion-gate");
          messages.push({
            role: "user",
            content: gate.correctiveInstruction || "The task is not complete yet. Use tools to finish it.",
          });
          this.emitEvent("agent:thinking", mode, { turnsUsed, toolCallsCount, gateReason: gate.reason, correctiveTurn: true });
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

        {
          const dur = Date.now() - startTime;
          try {
            observabilityHub.info("harness", "turn.complete", {
              correlation: corr,
              durationMs: dur,
              outcome: "ok",
              metadata: { turnsUsed, toolCallsCount, tokensUsed: accumulatedTokens } as any,
            });
            observabilityHub.metrics.increment(MetricsRegistry.NAMES.sessionTurnDuration, { labels: { outcome: "ok" }, valueMs: dur });
            observabilityHub.metrics.increment(MetricsRegistry.NAMES.sessionTurnCount, { labels: { outcome: "ok" } });
            if (turnSpan) observabilityHub.trace.end(turnSpan.spanId, "ok");
          } catch {}
        }

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
      // Set when the user explicitly DENIES a tool. The batch finishes (so every
      // tool_call still gets a transcript answer), then the run stops instead of
      // asking the model/user again.
      let approvalStop: string | null = null;
      this.agentState.transition("executing-tool");
      const outcome = await executeToolBatch(parsedCalls, {
        signal: combinedSignal,
        cwd: this.config.currentCwd || process.cwd(),
        needsApproval,
        maxRepeat: 2,
        runTool: async (name, args, id) => {
          // Front-end specific tools (e.g. the TUI's save_plan) run before the
          // core gateway. Returning null falls through to the normal path.
          if (options.onCustomTool) {
            const custom = await options.onCustomTool(name, args, id);
            if (custom) {
              if (!custom.allowed) failedToolCalls += 1;
              this.emitEvent("tool:queued", mode, { toolName: name, toolArgs: args, id });
              this.emitEvent(custom.allowed ? "tool:complete" : "tool:error", mode, {
                toolName: name, toolArgs: args, result: custom.result, id,
              });
              return custom;
            }
          }

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
 // — the repeat bound comes from the profile, never a literal.
          if (exceedsRepeatedToolCalls(this.profile.continuationPolicy, this.consecutiveToolRepeat)) {
            loopAborted = true;
            failedToolCalls += 1;
            return {
              result: JSON.stringify({
                stdout: "",
                stderr: repeatedToolCallError(name, this.consecutiveToolRepeat),
                exitCode: 1,
              }),
              allowed: false,
              reason: "loop",
            };
          }

          const toolStartTimestamp = Date.now();
          const ctx = {
            // Carry the same workspace resolution the executor uses, so a tool's
            // postcondition `verify` checks the file the tool actually touched
            // instead of falling back to the process cwd.
            cwd: this.config.currentCwd || process.cwd(),
            workspaceRoot: this.config.workspaceRoot,
            sandboxMode: this.config.sandboxMode || getSandboxMode(),
            agentRole: options.agentRole,
            agentDepth: options.agentDepth ?? (this.activeMode === "SUBAGENT" ? 1 : 0),
            signal: combinedSignal,
            onProgress: (progress: any) => {
              this.emitEvent("tool:progress", mode, {
                toolName: name,
                toolArgs: args,
                id,
                callId: id,
                elapsedMs: progress.elapsedMs ?? (Date.now() - toolStartTimestamp),
                tail: progress.tail,
                stdoutDelta: progress.stdoutDelta,
                stderrDelta: progress.stderrDelta,
              });
            },
          };

          this.emitEvent("tool:queued", mode, { toolName: name, toolArgs: args, id });
          this.emitEvent("tool:start", mode, { toolName: name, toolArgs: args, id });
          const res = await this.dispatchTool(name, args, ctx);

          // Ask exactly once when the front-end can resolve the approval gate.
          // A denial never executes the tool and must fail the run explicitly.
          const approveAndExecute = async (): Promise<Awaited<ReturnType<typeof this.dispatchTool>>> => {
            this.emitEvent("tool:start", mode, { toolName: name, toolArgs: args, id });
            const approvedResult = await this.dispatchTool(name, args, { ...ctx, userApproved: true });
            const approvedDefinition = toolRegistry.get(name);
            const approvedVerification = approvedDefinition?.verify
              ? await approvedDefinition.verify(args, approvedResult.result, ctx)
              : undefined;
            if (approvedVerification) {
              this.emitEvent("verification-start", mode, { toolName: name, toolArgs: args, id });
              this.emitEvent("verification-result", mode, { toolName: name, toolArgs: args, id, ...approvedVerification });
            }

            const approvedParsed = parseResultJson(approvedResult.result);
            const approvedExitCode = approvedParsed?.exitCode ?? (approvedParsed?.success === false ? 1 : 0);
            const approvedVerified = approvedVerification ? approvedVerification.ok : approvedExitCode === 0;
            if (approvedExitCode !== 0) {
              this.emitEvent("tool:error", mode, {
                toolName: name,
                toolArgs: args,
                result: approvedResult.result,
                reason: approvedResult.reason ?? `Tool exited with code ${approvedExitCode}`,
                id,
                callId: id,
              });
              return approvedResult;
            }

            recordEvidence(evidence, "execution", true);
            if (isMutationTool(name)) recordEvidence(evidence, "mutation", approvedVerified);
            if (looksLikeTestCommand(name, args)) recordEvidence(evidence, "test", approvedVerified);
            if (looksLikeVerificationCommand(name, args)) recordEvidence(evidence, "verification", approvedVerified);
            this.emitEvent("tool:complete", mode, {
              toolName: name,
              toolArgs: args,
              result: approvedResult.result,
              id,
              callId: id,
              // Carry the postcondition verdict so the evidence collector sees
              // the same verification this loop recorded.
              ...(approvedVerification ? { verification: approvedVerification } : {}),
            });
            return approvedResult;
          };

          if (!res.allowed && res.needsApproval) {
            if (!options.requestApproval) {
              // No front-end can resolve the gate. Surface it and return the
              // typed result so the model learns approval is required (the
              // caller sees `approvalRequired` on the result and can resume).
              this.lastRunState.approvalRequired = true;
              this.emitEvent("agent:error", mode, {
                error: "Permission required before continuing; execution paused for approval.",
                code: "APPROVAL_REQUIRED",
              });
              return res;
            }

            const approved = await options.requestApproval({ name, args, reason: res.reason });
            if (!approved) {
              this.lastRunState.approvalRequired = true;
              approvalStop = "Permission denied by user; execution stopped.";
              this.emitEvent("agent:error", mode, {
                error: approvalStop,
                code: "APPROVAL_DENIED",
              });
              return {
                ...res,
                result: JSON.stringify({
                  stdout: "",
                  stderr: "Permission denied by user.",
                  exitCode: 1,
                  approvalRequired: true,
                  approvalDenied: true,
                }),
              };
            }

            return approveAndExecute();
          }

          if (!res.allowed) {
            failedToolCalls += 1;
            this.emitEvent("tool:error", mode, {
              toolName: name,
              toolArgs: args,
              result: res.result,
              reason: res.reason,
              id,
              callId: id,
            });
            return res;
          }

          const parsed = parseResultJson(res.result);
          const exitCode = parsed?.exitCode ?? (parsed?.success === false ? 1 : 0);
          if (exitCode !== 0) {
            failedToolCalls += 1;
            this.emitEvent("tool:error", mode, {
              toolName: name,
              toolArgs: args,
              result: res.result,
              reason: `Tool exited with code ${exitCode}`,
              id,
              callId: id,
            });
            return res;
          }

          const definition = toolRegistry.get(name);
          const verification = definition?.verify
            ? await definition.verify(args, res.result, ctx)
            : undefined;
          if (verification) {
            this.emitEvent("verification-start", mode, { toolName: name, toolArgs: args, id });
            this.emitEvent("verification-result", mode, { toolName: name, toolArgs: args, id, ...verification });
          }
          const verified = verification ? verification.ok : true;
          recordEvidence(evidence, "execution", true);
          if (isMutationTool(name)) recordEvidence(evidence, "mutation", verified);
          if (looksLikeTestCommand(name, args)) recordEvidence(evidence, "test", verified);
          if (looksLikeVerificationCommand(name, args)) recordEvidence(evidence, "verification", verified);
          this.emitEvent("tool:complete", mode, {
            toolName: name,
            toolArgs: args,
            result: res.result,
            id,
            callId: id,
            // Carry the postcondition verdict so the evidence collector sees
            // the same verification this loop recorded.
            ...(verification ? { verification } : {}),
          });

          return res;
        },
        // Every tool_call the model made must be answered in the transcript —
        // an unanswered tool_call makes the next provider request invalid, and
        // the model would be working without ever seeing a tool result.
        onMessage: (m) => {
          messages.push({ role: "tool", tool_call_id: m.id, name: m.name, content: m.content });
        },
      });

      toolCallsCount += outcome.executedCount;
      this.metrics.toolCallsDeduplicated += outcome.deduplicatedCount;
      this.metrics.toolCallsBatched += outcome.parallelCalls;

      // Back to `thinking` for the next model turn (or `responding` when the
      // loop is about to finish) — `executing-tool` is not a terminal state.
      this.agentState.transition("thinking", "tool-batch-complete");

      // Approval is a hard stop: the run ends with `approvalRequired` set so a
      // front-end can resume it after the user decides, and the model is never
      // asked to route around a permission gate.
      if (approvalStop) {
        this.agentState.transition("error", "approval-required");
        try {
          observabilityHub.warn("harness", "turn.approval_required", { correlation: corr, outcome: "error", errorCode: "APPROVAL_REQUIRED" });
          if (turnSpan) observabilityHub.trace.end(turnSpan.spanId, "error", "APPROVAL_REQUIRED");
        } catch {}
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
          evidence: { ...evidence },
          error: approvalStop,
        };
      }

      if (loopAborted) {
        this.agentState.transition("error", "loop-detected");
        this.emitEvent("agent:error", mode, { error: "Infinite loop detected: exceeded maximum repetition of identical tool calls." });
        try {
          observabilityHub.warn("harness", "turn.loop_detected", { correlation: corr, outcome: "error", errorCode: "LOOP_DETECTED" });
          observabilityHub.metrics.increment(MetricsRegistry.NAMES.sessionTurnCount, { labels: { outcome: "error", error_class: "loop" } });
          if (turnSpan) observabilityHub.trace.end(turnSpan.spanId, "error", "LOOP_DETECTED");
        } catch {}
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
          evidence: { ...evidence },
          error: "Infinite loop detected: exceeded maximum repetition of identical tool calls.",
        };
      }

      // The progress bound is evaluated after evidence is recorded, so a corrective turn with
      // real tool progress is not aborted as a no-progress turn.
      const stalled = checkProgress(assistantContent);
      if (stalled) {
        this.agentState.transition("error", "no-progress");
        this.emitEvent("agent:error", mode, {
          error: stalled.error,
          turnsUsed,
          toolCallsCount,
        });
        try {
          observabilityHub.warn("harness", "turn.no_progress", { correlation: corr, outcome: "error", errorCode: "NO_PROGRESS" });
          observabilityHub.metrics.increment(MetricsRegistry.NAMES.sessionTurnCount, { labels: { outcome: "error", error_class: "no_progress" } });
          if (turnSpan) observabilityHub.trace.end(turnSpan.spanId, "error", "NO_PROGRESS");
        } catch {}
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
          error: stalled.error,
        };
      }

      this.emitEvent("agent:thinking", mode, { turnsUsed, toolCallsCount });
      awaitingToolSynthesis = toolCallsCount > 0 && Boolean(evidence.successfulMutations || evidence.testsPassed || evidence.verificationsPassed);
    }

    this.agentState.transition("error", "max-turns");
    try {
      observabilityHub.warn("harness", "turn.max_turns", { correlation: corr, outcome: "error", errorCode: "MAX_TURNS" });
      observabilityHub.metrics.increment(MetricsRegistry.NAMES.sessionTurnCount, { labels: { outcome: "error", error_class: "max_turns" } });
      if (turnSpan) observabilityHub.trace.end(turnSpan.spanId, "error", "MAX_TURNS");
    } catch {}
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
      // Carry the evidence the run accumulated: a failed run still reports what
      // it actually verified, never an empty placeholder.
      evidence: { ...evidence },
      error: maxTurnsError(maxTurns),
    };
  }

  // ── AgentLoop entry point ─────────────────────────────────────────────────

  private async buildSystemPrompt(extra?: string, taskSummary?: string, prompt?: string): Promise<string> {
    const memoryPrompt = contextEngine.getMemoryPromptSnippet(this.config.sessionId);
    const toolRules = contextEngine.getToolUsageRulesSnippet();
    const permissionContext = getPermissionContextPrompt(this.config.sandboxMode || getSandboxMode());
    const codingPolicy = getCodingAgentPolicy();
    const toolUseGuidance = getCodingAgentToolUseGuidance();
    const projectCtx = buildProjectContext(this.config.workspaceRoot || process.cwd(), this.config.currentCwd || this.config.workspaceRoot || process.cwd());
    let projectSummary = this.formatProjectContext(projectCtx);
    
 // Inject Repository Intelligence
    try {
      const { repositoryIntelligence } = await import("../../core/repo");
      const repoContext = await repositoryIntelligence.getCompactContext(this.config.currentCwd || this.config.workspaceRoot || process.cwd());
      
      const instructionsText = repoContext.instructions.map(i => `\nRules from ${i.path}:\n${i.content}`).join("\n");
      const mapText = repoContext.mapNodes.map(n => `- ${n.filePath} (${n.language}, ${n.size} bytes) - Symbols: ${n.symbols.join(", ")}`).join("\n");
      
      projectSummary += `\n\n[REPOSITORY INSTRUCTIONS]${instructionsText}\n\n[REPOSITORY MAP]\n${mapText}`;

      if (prompt) {
        const changeImpact = await repositoryIntelligence.determineChangeImpact(prompt, repoContext.profile);
        projectSummary += `\n\n[CHANGE IMPACT ANALYSIS]\nRisk: ${changeImpact.risk}\nPrimary Files: ${changeImpact.primaryFiles.join(", ")}\nTests to run: ${changeImpact.tests.join(", ")}`;
      }
    } catch (err) {
      // Degrade gracefully
    }

    const taskBlock = taskSummary ? `\n${taskSummary}\n` : "";

 // — the profile's PromptPolicy decides which blocks appear and
    // how tightly they are joined. `assemblePromptBase` always emits the
    // runtime permission context, so no profile can drop the security boundary.
    const base = composeSystemPrompt({
      profile: this.profile,
      callerOverride: extra,
      toolPolicyGuidance: toolPolicyGuidance(this.profile.toolPolicy),
      availableTools: isPassthroughToolPolicy(this.profile.toolPolicy)
        ? undefined
        : exposedToolNames(toolRegistry.canonicalNames(), this.profile.toolPolicy),
      blocks: {
        codingPolicy,
        toolUseGuidance,
        projectContext: `${projectSummary}${taskBlock}`,
        memoryAndToolRules: `${memoryPrompt}${toolRules}`,
        permissionContext,
        languageDirective: getLanguageDirective(getResponseLanguage()),
      },
    });

    return bypassEngine.getBypassSystemPrompt(base);
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

 // ── Task Understanding Layer () ───────────────────────────────────
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
    const systemPrompt = await this.buildSystemPrompt(options.systemPrompt, taskSummary, prompt);

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
    const systemPrompt = await this.buildSystemPrompt(options.systemPrompt, undefined, prompt);

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

  /**
 * Rebuild the message list for a RESUMED child session.
   *
   * A resumed subagent must run under the same operating contract as its first
   * call, so the live system prompt (project summary, permission context, role
   * prompt) is regenerated instead of trusting a stale copy. Stored child
   * transcripts deliberately exclude the system message for exactly this reason.
   */
  async buildResumeMessages(
    transcript: ContextMessage[],
    options: ExecutionOptions = {}
  ): Promise<ContextMessage[]> {
    const sysPrompt = await this.buildSystemPrompt(options.systemPrompt);
    return [{ role: "system", content: sysPrompt }, ...transcript];
  }

  async runHeadless(prompt: string, options: ExecutionOptions = {}): Promise<HarnessResult> {
    const systemPrompt = await this.buildSystemPrompt(options.systemPrompt, undefined, prompt);

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
    const systemPrompt = await this.buildSystemPrompt(options.systemPrompt || turboPrompt, undefined, prompt);
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
 // : a caller that supplies a system prompt (an AgentDefinition
    // composed by the subagent manager) owns the role contract. The legacy
    // role-prompt generator is the fallback for role-only callers.
    const rolePrompt = options.systemPrompt?.trim()
      ? options.systemPrompt.trim()
      : getSubagentRolePrompt(role, task.slice(0, 50), options.sessionId || this.config.sessionId);
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

// ── Completion-evidence helpers () ────────────────────────────────
//
// : the tool classification (what counts as a mutation / a shell run /
// a test / a verification) MOVED to `core/harness/evidence.ts` and is imported
// above. It has exactly one definition there, shared with the execution-evidence
// collector, so the harness and the verdict can never disagree about whether a
// file changed or a test ran.

function parseResultJson(result: string): Record<string, unknown> | null {
  if (!result || typeof result !== "string") return null;
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Parse a tool-call argument fragment. A model may stream a partial JSON
 * string (or none at all); an unparseable fragment degrades to `{}` rather
 * than crashing the loop — the tool's own schema validation reports the error.
 */
/**
 * Reasoning effort is only forwarded when the model declares both reasoning
 * support and a configurable effort — never guessed from the model id.
 */
function resolveReasoningEffort(
  model: string,
  settings?: { enabled: boolean; effort: "auto" | "low" | "medium" | "high" }
): "low" | "medium" | "high" | undefined {
  if (!settings?.enabled) return undefined;
  if (settings.effort === "auto") return undefined;
  const caps = getModelCapabilities(model);
  if (!caps?.reasoning || !caps.reasoningEffort) return undefined;
  return settings.effort;
}

function safeParseJson(value: string | undefined): unknown {
  if (!value || !value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
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
