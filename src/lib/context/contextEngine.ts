import type {
  CompactionOptions,
  CompactionResult,
  ContextBudget,
  ContextMessage,
  PruneOptions,
  SessionMemoryData,
} from "./types";
import { calculateContextBudget, getModelContextSpec } from "./modelBudgets";
import { pruneOldToolResults } from "./toolPruner";
import { compactMessagesAtomically } from "./atomicCompactor";
import { getSessionMemory, SessionMemoryStore } from "./sessionMemory";
import { getSessionContext } from "./contextRegistry";
import { estimateMessageChars, estimateTotalTokens } from "./tokenEstimator";

/**
 * Layer 4 — Phase 4: ContextEngine is a per-harness/per-loop instance.
 *
 * Production call sites MUST pass an explicit sessionId. The class
 * retains an instance-level `compactionCount` (no global counter) and
 * routes every memory touch through the SessionContext registry.
 *
 * The exported `contextEngine` singleton is preserved for backward
 * compatibility: it routes through the legacy `sessionMemory` accessor
 * (which itself resolves via the current explicit session) and accepts
 * an optional sessionId in each public method.
 */

interface ContextEngineOptions {
  defaultModel?: string;
  /** When provided, memory access is bound to this session. */
  sessionId?: string;
}

export class ContextEngine {
  private defaultModel: string;
  private compactionCount = 0;
  /** Optional binding; if null, callers must pass sessionId. */
  private boundSessionId: string | null;

  constructor(options: ContextEngineOptions = {}) {
    this.defaultModel = options.defaultModel || "default";
    this.boundSessionId = options.sessionId || null;
  }

  /**
   * Resolves which memory store this engine should use, in priority:
   *   1. explicit `sessionId` argument,
   *   2. the engine's bound sessionId (if set at construction),
   *   3. the bound sessionId supplied at construction.
   */
  private resolveMemory(sessionId?: string): SessionMemoryStore {
    const sid = sessionId || this.boundSessionId;
    if (!sid) {
      // Compatibility calls that do not yet carry a session id receive a
      // throwaway store. This is deliberately not registered or shared, so it
      // cannot become an implicit cross-session trust/memory bucket.
      return new SessionMemoryStore("ephemeral-context-call");
    }
    return getSessionMemory(sid);
  }

  private resolveSessionId(sessionId?: string): string | null {
    return sessionId || this.boundSessionId || null;
  }

  /**
   * Prepares a message list for LLM API invocation.
   *
   * Pipeline:
   *  1. Ingest user goals into the bound session memory.
   *  2. Auto-prune bulky older tool results.
   *  3. Atomic compaction if context exceeds model threshold.
   *  4. Return optimized messages and real-time budget metrics.
   *
   * The model's context spec determines when to start pruning/compacting.
   */
  prepareMessagesForApi(
    messages: ContextMessage[],
    options?: {
      model?: string;
      maxTokens?: number;
      forceCompact?: boolean;
      autoPrune?: boolean;
      sessionId?: string;
    }
  ): {
    messages: ContextMessage[];
    budget: ContextBudget;
    compacted: boolean;
    prunedCount: number;
  } {
    const model = options?.model || this.defaultModel;
    const spec = getModelContextSpec(model);
    const memory = this.resolveMemory(options?.sessionId);
    const sessionId = this.resolveSessionId(options?.sessionId);
    let workingMessages = [...messages];

    // 1. Ingest user goals into the bound session memory.
    for (const msg of workingMessages) {
      if (msg.role === "user" && msg.content) {
        memory.recordUserGoal(msg.content.split("\n")[0]);
      }
    }

    // 2. Priority-based pruning: start at 70% utilization
    let prunedCount = 0;
    if (options?.autoPrune !== false) {
      const budgetCheck = calculateContextBudget(workingMessages, model);
      const utilization = budgetCheck.utilizationPercent;

      if (utilization >= 70) {
        const pruneResult = pruneOldToolResults(workingMessages, {
          maxToolResultChars: utilization >= 85 ? 400 : 600,
          keepRecentToolsCount: utilization >= 85 ? 2 : 3,
        });
        workingMessages = pruneResult.messages;
        prunedCount = pruneResult.prunedCount;
      }
    }

    // 3. Check if compaction is needed based on model threshold
    const budgetBefore = calculateContextBudget(workingMessages, model);
    let compacted = false;

    if (options?.forceCompact || budgetBefore.needsCompaction) {
      const compResult = compactMessagesAtomically(workingMessages, {
        force: options?.forceCompact || budgetBefore.needsCompaction,
        model,
        thresholdChars: spec.autoCompactThresholdTokens * 3.8,
        sessionId: sessionId || undefined,
        memory,
      });

      if (compResult.compacted) {
        workingMessages = compResult.messages;
        compacted = true;
        this.compactionCount++;
        if (sessionId) {
          const ctx = getSessionContext(sessionId);
          ctx.compactionState.count = this.compactionCount;
          ctx.compactionState.lastCompactedAt = Date.now();
          ctx.compactionState.lastSummary = (compResult.messages.find(m => m.role === "user" && typeof m.content === "string" && m.content.startsWith("["))?.content as string) || "";
        }
      }
    }

    const finalBudget = calculateContextBudget(workingMessages, model);
    if (sessionId) {
      const ctx = getSessionContext(sessionId);
      ctx.tokenBudgetState.estimatedContextTokens = finalBudget.currentEstimatedTokens;
      ctx.tokenBudgetState.lastUpdated = Date.now();
    }

    return {
      messages: workingMessages,
      budget: finalBudget,
      compacted,
      prunedCount,
    };
  }

  compact(messages: ContextMessage[], options?: CompactionOptions): CompactionResult {
    return compactMessagesAtomically(messages, {
      ...options,
      memory: options?.memory || this.resolveMemory(options?.sessionId),
    });
  }

  prune(messages: ContextMessage[], options?: PruneOptions) {
    return pruneOldToolResults(messages, options);
  }

  getBudget(messages: ContextMessage[], model?: string, sessionId?: string): ContextBudget {
    const budget = calculateContextBudget(messages, model || this.defaultModel);
    if (sessionId) {
      const ctx = getSessionContext(sessionId);
      ctx.tokenBudgetState.estimatedContextTokens = budget.currentEstimatedTokens;
    }
    return budget;
  }

  recordUserGoal(goal: string, sessionId?: string) {
    this.resolveMemory(sessionId).recordUserGoal(goal);
  }

  recordFileAccess(path: string, action: "read" | "write" | "patch", sessionId?: string) {
    this.resolveMemory(sessionId).recordFileAccess(path, action);
  }

  recordInsight(insight: string, sessionId?: string) {
    this.resolveMemory(sessionId).recordInsight(insight);
  }

  getSessionMemory(sessionId?: string): SessionMemoryData {
    return this.resolveMemory(sessionId).getSnapshot();
  }

  getMemoryPromptSnippet(sessionId?: string): string {
    return this.resolveMemory(sessionId).generateSystemPromptSnippet();
  }

  getToolUsageRulesSnippet(): string {
    return [
      "",
      "## Tool Usage Rules",
      "- Prefer native read_file/grep over shell sed/grep.",
      "- Reuse already observed information unless the file changed.",
      "- Prefer one sufficiently large read over repeated adjacent reads.",
      "- Batch independent reads/searches.",
      "- Consult workspace code map before broad exploration.",
    ].join("\n");
  }

  getCompactionCount(): number {
    return this.compactionCount;
  }

  /** Token-accounting surface for Phase 4. */
  getTokenBudget(sessionId?: string) {
    const sid = this.resolveSessionId(sessionId);
    if (sid) return getSessionContext(sid).tokenBudgetState;
    return {
      estimatedContextTokens: 0,
      actualUsagePromptTokens: 0,
      actualUsageCompletionTokens: 0,
      actualUsageCachedTokens: 0,
      actualUsageReasoningTokens: 0,
      cumulativeSessionTokens: 0,
      lastUpdated: 0,
    };
  }

  /**
   * Accumulates actual usage from a provider response into the session
   * token budget. promptTokens + completionTokens are the provider's
   * reported usage for the turn. cumulativeSessionTokens is the
   * monotonically increasing session total.
   */
  recordUsage(
    usage: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      cachedTokens?: number;
      reasoningTokens?: number;
    },
    sessionId?: string
  ): void {
    const sid = this.resolveSessionId(sessionId);
    if (!sid) return;
    const ctx = getSessionContext(sid);
    const prompt = nonNegativeFinite(usage.promptTokens);
    const completion = nonNegativeFinite(usage.completionTokens);
    const cached = nonNegativeFinite(usage.cachedTokens);
    const reasoning = nonNegativeFinite(usage.reasoningTokens);
    const reportedTotal = nonNegativeFinite(usage.totalTokens);
    // Provider total is authoritative when valid. Otherwise sum only the
    // known top-level components once; cached/reasoning details are metadata,
    // not extra tokens to add a second time.
    const total = reportedTotal > 0 ? reportedTotal : prompt + completion;
    ctx.tokenBudgetState.actualUsagePromptTokens += prompt;
    ctx.tokenBudgetState.actualUsageCompletionTokens += completion;
    ctx.tokenBudgetState.actualUsageCachedTokens += cached;
    ctx.tokenBudgetState.actualUsageReasoningTokens += reasoning;
    ctx.tokenBudgetState.cumulativeSessionTokens += total;
    ctx.tokenBudgetState.lastUpdated = Date.now();
  }
}

/**
 * Backward-compat default singleton. Routes through the legacy
 * `sessionMemory` accessor (current explicit session) and accepts an
 * optional sessionId on every public method.
 */
function nonNegativeFinite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export const contextEngine = new ContextEngine();
