/**
 * THE ContextManager.
 *
 * One owner for "what does the model see this turn": budgeting, planning,
 * bounded compaction, the cache, and the durable record of a compaction. It is
 * a coordinator, not an executor — it never calls a provider, never runs a tool
 * and never writes session files directly. Compaction steps are injected by the
 * caller so provider and persistence concerns stay outside this layer, and
 * durable state is written through the session store's public API.
 */

import { sessionStore } from "../session/store";
import { contextCache, type CacheStats, type ContextCache, hashContent, tokenCacheKey } from "./cache";
import { computeContextBudget, projectedRequestTokens, type BudgetInput } from "./budget";
import { runBoundedCompaction, type CompactionRunInput } from "./compaction";
import { tokenEstimator, type EstimatableMessage, type TokenEstimator } from "./estimator";
import { planContext, type PlannerInput } from "./planner";
import type { CompactionOutcome, CompactionRecord, ContextBudget, ContextPlan } from "./types";

export interface ContextManagerOptions {
  cache?: ContextCache;
  estimator?: TokenEstimator;
}

export interface PrepareInput extends BudgetInput, Omit<CompactionRunInput, "messages" | "model"> {
  sessionId?: string;
  /** Persist a compaction record into the session journal. */
  persist?: boolean;
  /** Emit context lifecycle events on the existing event surface. */
  onEvent?: (event: ContextEvent) => void;
}

export type ContextEvent =
  | { type: "context:planned"; budget: ContextBudget; compactionNeeded: boolean }
  | { type: "context:near_limit"; budget: ContextBudget }
  | { type: "context:compaction_started"; beforeTokens: number }
  | { type: "context:compaction_completed"; beforeTokens: number; afterTokens: number; passes: number }
  | { type: "context:compaction_failed"; reason: string; failure: string };

export interface PrepareResult {
  messages: EstimatableMessage[];
  budget: ContextBudget;
  plan: ContextPlan;
  compacted: boolean;
  compaction?: CompactionOutcome;
  record?: CompactionRecord;
}

export class ContextManager {
  private readonly cache: ContextCache;
  private readonly estimator: TokenEstimator;
  private lastCompactionRecord: CompactionRecord | null = null;

  constructor(options: ContextManagerOptions = {}) {
    this.cache = options.cache ?? contextCache;
    this.estimator = options.estimator ?? tokenEstimator;
  }

  budget(input: BudgetInput): ContextBudget {
    return computeContextBudget(input);
  }

  plan(input: PlannerInput): ContextPlan {
    return planContext(input);
  }

  /**
   * Budget → plan → bounded compaction. Compaction is skipped entirely when the
   * estimate is inside the budget, so a normal short request is untouched.
   *
   * Async because the summary step is written by a model; the trigger decision
   * and every measurement stay exactly where they were.
   */
  async prepare(input: PrepareInput): Promise<PrepareResult> {
    const budget = this.budget(input);
    const plan = this.plan({ messages: input.messages, budget });
    input.onEvent?.({ type: "context:planned", budget, compactionNeeded: plan.compactionNeeded });
    if (!plan.compactionNeeded && budget.remaining < budget.usableInput * 0.1) {
      input.onEvent?.({ type: "context:near_limit", budget });
    }

    if (!plan.compactionNeeded && input.force !== true && input.overflowObserved !== true) {
      return { messages: input.messages, budget, plan, compacted: false };
    }

    input.onEvent?.({ type: "context:compaction_started", beforeTokens: budget.estimatedInput });
    const compaction = await runBoundedCompaction({
      messages: input.messages,
      ...(input.model ? { model: input.model } : {}),
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.force !== undefined ? { force: input.force } : {}),
      ...(input.maxPasses !== undefined ? { maxPasses: input.maxPasses } : {}),
      ...(input.minSavingsTokens !== undefined ? { minSavingsTokens: input.minSavingsTokens } : {}),
      ...(input.minSavingsRatio !== undefined ? { minSavingsRatio: input.minSavingsRatio } : {}),
      ...(input.outputBudget !== undefined ? { outputBudget: input.outputBudget } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.prune ? { prune: input.prune } : {}),
      ...(input.summarize ? { summarize: input.summarize } : {}),
      ...(input.overflowObserved !== undefined ? { overflowObserved: input.overflowObserved } : {}),
    });

    if (!compaction.compacted) {
      const failure = compaction.failure ?? "no_reduction";
      input.onEvent?.({ type: "context:compaction_failed", reason: compaction.reason, failure });
      return { messages: input.messages, budget, plan, compacted: false, compaction };
    }

    const messages = compaction.messages as EstimatableMessage[];
    const nextBudget = this.budget({ ...input, messages });
    const nextPlan = this.plan({ messages, budget: nextBudget });
    input.onEvent?.({
      type: "context:compaction_completed",
      beforeTokens: compaction.beforeTokens,
      afterTokens: compaction.afterTokens,
      passes: compaction.passes,
    });

    let record = compaction.record;
    if (record && input.sessionId && input.persist !== false) {
      record = this.persistRecord(input.sessionId, record) ?? record;
    }
    if (record) this.lastCompactionRecord = record;

    return {
      messages,
      budget: nextBudget,
      plan: nextPlan,
      compacted: true,
      compaction,
      ...(record ? { record } : {}),
    };
  }

  /**
   * Durable record of a compaction, written through the session store: an event
   * on the journal so it survives a restart, then a checkpoint so resume sees a
   * consistent head. Never rewrites the transcript — original history stays
   * recoverable.
   */
  persistRecord(sessionId: string, record: CompactionRecord): CompactionRecord | null {
    try {
      // Only a session the store already owns gets journaled. Writing an event
      // for an unknown id would create session files as a side effect of a
      // context optimization, which is not this layer's call to make.
      if (!sessionStore.exists(sessionId)) return null;
      const event = sessionStore.appendSessionEvent(sessionId, "context.compaction", {
        compactionId: record.id,
        strategy: record.strategy,
        beforeTokens: record.estimatedTokensBefore,
        afterTokens: record.estimatedTokensAfter,
        ...(record.summaryRef ? { summaryRef: record.summaryRef } : {}),
      });
      const withRange: CompactionRecord = { ...record, sourceEventRange: { from: event.seq, to: event.seq } };
      sessionStore.checkpoint(sessionId, { reason: "compaction" });
      return withRange;
    } catch {
      // A context optimization must never break the run: if the session store is
      // unavailable the compaction still stands, it is just not journaled.
      return null;
    }
  }

  lastRecord(): CompactionRecord | null {
    return this.lastCompactionRecord;
  }

  // ── Token estimation surface ──────────────────────────────────────────────

  estimateText(text: string | null | undefined, model?: string) {
    return this.estimator.estimateText(text, model);
  }

  estimateMessages(messages: EstimatableMessage[], model?: string) {
    return this.estimator.estimateMessages(messages, model);
  }

  /** Cached estimate, keyed by content so an edit is automatically a miss. */
  cachedEstimate(text: string, modelFamily = "default") {
    const key = tokenCacheKey(text, modelFamily);
    const cached = this.cache.getTokenEstimate(key);
    if (cached) return cached;
    const estimate = this.estimator.estimateText(text, modelFamily);
    this.cache.setTokenEstimate(key, estimate);
    return estimate;
  }

  /**
   * Fold provider-reported usage back into estimation. This calibrates FUTURE
   * estimates; it never rewrites a recorded measurement.
   */
  observeCompletedRequest(input: { model?: string; estimatedInputTokens: number; actualPromptTokens: number }): void {
    this.estimator.observeProviderUsage(input);
  }

  // ── Cache surface ─────────────────────────────────────────────────────────

  getFileContent(
    path: string,
    stat: () => { size: number; mtimeMs: number } | null,
    read: () => string | null,
  ): { content: string; hit: boolean } | null {
    return this.cache.getFile(path, stat, read);
  }

  invalidateFile(path: string): void {
    this.cache.invalidatePath(path);
  }

  cacheStats(): CacheStats {
    return this.cache.stats();
  }

  clearCache(): void {
    this.cache.clear();
  }

  contentHash(text: string): string {
    return hashContent(text);
  }

  /** Effective request size for reporting/telemetry. */
  projected(budget: ContextBudget): number {
    return projectedRequestTokens(budget);
  }
}

export const contextManager = new ContextManager();
