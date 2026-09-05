import type { QualityLevel } from "./types";

export interface BudgetConfig {
  maxTokens?: number;
  maxDurationMs?: number;
  /** Max number of dispatched tasks (dispatch gate). 0/undefined = unlimited. */
  maxTasks?: number;
  /** Max workers that may be spawned concurrently. */
  maxWorkers?: number;
  /** Max total tool calls across all workers (informational gate). */
  maxToolCalls?: number;
  qualityLevel: QualityLevel;
}

export type BudgetExhaustionReason =
  | "TOKENS"
  | "TIME"
  | "TASKS"
  | "TOOL_CALLS";

/**
 * BudgetManager — Layer 4 Phase 2
 *
 * Real enforcement primitive consumed by DynamicScheduler at dispatch gates:
 *   A. before processQueue dispatch loop
 *   B. before each worker start
 *   C. after each worker completion (token accounting)
 *   D. before retry
 *   E. before spawning additional subagents (maxWorkers)
 *
 * When exhausted, DynamicScheduler stops dispatching, marks pending tasks
 * SKIPPED(BUDGET_EXCEEDED) and emits `scheduler:budget_exhausted`.
 */
export class BudgetManager {
  private config: BudgetConfig;
  private currentTokens: number = 0;
  private currentTasks: number = 0;
  private currentToolCalls: number = 0;
  private startTime: number = Date.now();
  private exhaustedReason: BudgetExhaustionReason | null = null;

  constructor(config: BudgetConfig) {
    // Normalize all optional limits to concrete numbers so callers that mutate
    // (sampler/test) or omit fields observe consistent enforcement behavior.
    this.config = {
      ...config,
      maxTokens: config.maxTokens ?? 0,
      maxDurationMs: config.maxDurationMs ?? 0,
      maxTasks: config.maxTasks ?? 0,
      maxToolCalls: config.maxToolCalls ?? 0,
    };
  }

  addTokens(tokens: number) {
    const t = Number.isFinite(tokens) ? Math.max(0, Math.floor(tokens)) : 0;
    this.currentTokens += t;
  }

  /** Called once per task dispatch (worker start). */
  addTask() {
    this.currentTasks += 1;
  }

  addToolCalls(count: number) {
    const c = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    this.currentToolCalls += c;
  }

  isTokenBudgetExhausted(): boolean {
    if (!this.config.maxTokens) return false;
    return this.currentTokens >= this.config.maxTokens;
  }

  isTimeBudgetExhausted(): boolean {
    if (!this.config.maxDurationMs) return false;
    return (Date.now() - this.startTime) >= this.config.maxDurationMs;
  }

  isTaskBudgetExhausted(): boolean {
    if (!this.config.maxTasks) return false;
    return this.currentTasks >= this.config.maxTasks;
  }

  isToolCallBudgetExhausted(): boolean {
    if (!this.config.maxToolCalls) return false;
    return this.currentToolCalls >= this.config.maxToolCalls;
  }

  getRemainingTimeMs(): number | null {
    if (!this.config.maxDurationMs) return null;
    const elapsed = Date.now() - this.startTime;
    return Math.max(0, this.config.maxDurationMs - elapsed);
  }

  getUsedTokens(): number {
    return this.currentTokens;
  }

  getUsedTasks(): number {
    return this.currentTasks;
  }

  getUsedToolCalls(): number {
    return this.currentToolCalls;
  }

  /**
   * True when any configured budget dimension is exhausted.
   * Records the FIRST exhausted dimension as the reason (sticky).
   */
  isExhausted(): boolean {
    if (this.exhaustedReason) return true;
    if (this.isTokenBudgetExhausted()) {
      this.exhaustedReason = "TOKENS";
      return true;
    }
    if (this.isTimeBudgetExhausted()) {
      this.exhaustedReason = "TIME";
      return true;
    }
    if (this.isTaskBudgetExhausted()) {
      this.exhaustedReason = "TASKS";
      return true;
    }
    if (this.isToolCallBudgetExhausted()) {
      this.exhaustedReason = "TOOL_CALLS";
      return true;
    }
    return false;
  }

  /** Which dimension exhausted the budget (null = not exhausted). */
  getExhaustionReason(): BudgetExhaustionReason | null {
    // Re-evaluate lazily; isExhausted() caches the first reason.
    this.isExhausted();
    return this.exhaustedReason;
  }

  getMaxReviewRounds(): number {
    switch (this.config.qualityLevel) {
      case 'FAST':
      case 'DRAFT':
        return 0; // No QA
      case 'BALANCED':
      case 'NORMAL':
        return 1;
      case 'THOROUGH':
      case 'HIGH':
      case 'MAX':
        return 2;
      default:
        return 1;
    }
  }
}
