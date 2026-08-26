/**
 * Token usage tracking, pricing, and budget control for ToolNet CLI.
 *
 * Architecture:
 * - ModelPricing: known pricing per model (null if unknown)
 * - UsageTracker: accumulates per-request usage in memory
 * - BudgetManager: enforces USD spending limits
 *
 * Usage is persisted to session metadata on session end.
 */

import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "./appConfig";

/* ------------------------------------------------------------------ */
/*  Model Pricing Registry                                            */
/* ------------------------------------------------------------------ */

export interface ModelPricing {
  model: string;
  inputPer1M: number;   // USD per 1M input tokens
  outputPer1M: number;  // USD per 1M output tokens
  cachedInputPer1M?: number; // USD per 1M cached input tokens
}

/**
 * Known pricing for popular models (Aug 2025).
 * Models not in this list return null cost — we never guess.
 */
const PRICING_REGISTRY: ModelPricing[] = [
  { model: "openai/gpt-4o", inputPer1M: 2.50, outputPer1M: 10.00, cachedInputPer1M: 1.25 },
  { model: "openai/gpt-4o-mini", inputPer1M: 0.15, outputPer1M: 0.60, cachedInputPer1M: 0.075 },
  { model: "openai/o3", inputPer1M: 2.00, outputPer1M: 8.00, cachedInputPer1M: 0.50 },
  { model: "openai/o3-mini", inputPer1M: 1.10, outputPer1M: 4.40, cachedInputPer1M: 0.275 },
  { model: "openai/o4-mini", inputPer1M: 1.10, outputPer1M: 4.40, cachedInputPer1M: 0.275 },
  { model: "anthropic/claude-sonnet-4-20250514", inputPer1M: 3.00, outputPer1M: 15.00, cachedInputPer1M: 0.30 },
  { model: "anthropic/claude-3-5-sonnet-20241022", inputPer1M: 3.00, outputPer1M: 15.00, cachedInputPer1M: 0.30 },
  { model: "anthropic/claude-3-5-haiku-20241022", inputPer1M: 0.80, outputPer1M: 4.00, cachedInputPer1M: 0.08 },
  { model: "google/gemini-2.0-flash", inputPer1M: 0.10, outputPer1M: 0.40, cachedInputPer1M: 0.025 },
  { model: "google/gemini-2.5-pro", inputPer1M: 1.25, outputPer1M: 10.00, cachedInputPer1M: 0.315 },
  { model: "deepseek/deepseek-chat", inputPer1M: 0.27, outputPer1M: 1.10 },
  { model: "deepseek/deepseek-reasoner", inputPer1M: 0.55, outputPer1M: 2.19 },
];

const pricingMap = new Map<string, ModelPricing>();
for (const p of PRICING_REGISTRY) {
  pricingMap.set(p.model, p);
}

/** Look up pricing for a model. Returns null if unknown. */
export function getModelPricing(model: string): ModelPricing | null {
  return pricingMap.get(model) ?? null;
}

/* ------------------------------------------------------------------ */
/*  Usage types                                                       */
/* ------------------------------------------------------------------ */

export interface RequestUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  model: string;
  provider: string;
  latencyMs: number;
  timestamp: number;
  estimated: boolean;
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  requests: number;
}

/* ------------------------------------------------------------------ */
/*  UsageTracker — accumulates per-session usage                      */
/* ------------------------------------------------------------------ */

export class UsageTracker {
  private requests: RequestUsage[] = [];
  private _sessionId: string | null = null;
  private sessionUsage: SessionUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    requests: 0,
  };

  /** Bind this tracker to a session for auto-persistence. */
  bindSession(sessionId: string): void {
    this._sessionId = sessionId;
    // Load existing usage from session (resume)
    this.loadFromSession(sessionId);
  }

  /** Record a single request's usage. */
  recordUsage(usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    model: string;
    provider?: string;
    latencyMs?: number;
    estimated?: boolean;
  }): void {
    const cached = usage.cachedInputTokens ?? 0;
    const total = usage.inputTokens + usage.outputTokens;
    const req: RequestUsage = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: cached,
      totalTokens: total,
      model: usage.model,
      provider: usage.provider ?? extractProvider(usage.model),
      latencyMs: usage.latencyMs ?? 0,
      timestamp: Date.now(),
      estimated: usage.estimated ?? false,
    };
    this.requests.push(req);

    this.sessionUsage.inputTokens += usage.inputTokens;
    this.sessionUsage.outputTokens += usage.outputTokens;
    this.sessionUsage.cachedInputTokens += cached;
    this.sessionUsage.totalTokens += total;
    this.sessionUsage.requests += 1;

    const cost = calculateRequestCost(req);
    if (cost !== null) {
      this.sessionUsage.estimatedCostUsd = (this.sessionUsage.estimatedCostUsd ?? 0) + cost;
    }

    // Auto-persist if bound to a session
    if (this._sessionId) {
      this.saveToSession(this._sessionId);
    }
  }

  getSessionUsage(): SessionUsage {
    return { ...this.sessionUsage };
  }

  getRequests(): readonly RequestUsage[] {
    return this.requests;
  }

  /** Merge usage from a loaded session (for resume). */
  mergeFromSession(other: SessionUsage): void {
    this.sessionUsage.inputTokens += other.inputTokens;
    this.sessionUsage.outputTokens += other.outputTokens;
    this.sessionUsage.cachedInputTokens += other.cachedInputTokens;
    this.sessionUsage.totalTokens += other.totalTokens;
    if (other.estimatedCostUsd !== null && this.sessionUsage.estimatedCostUsd !== null) {
      this.sessionUsage.estimatedCostUsd += other.estimatedCostUsd;
    }
    this.sessionUsage.requests += other.requests;
  }

  /** Save current usage to session metadata file. */
  saveToSession(sessionId: string): void {
    try {
      const { saveSession, loadSession } = require("./sessionPersistence");
      const existing = loadSession(sessionId);
      const messages = existing?.messages ?? [];
      const metadata = { ...(existing?.metadata ?? {}), usage: this.getSessionUsage() };
      saveSession(sessionId, messages, metadata);
    } catch {}
  }

  /** Load usage from session metadata (for resume). */
  loadFromSession(sessionId: string): boolean {
    try {
      const { loadSession } = require("./sessionPersistence");
      const session = loadSession(sessionId);
      if (session?.metadata?.usage) {
        this.mergeFromSession(session.metadata.usage);
        return true;
      }
    } catch {}
    return false;
  }

  reset(): void {
    this.requests = [];
    this._sessionId = null;
    this.sessionUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      requests: 0,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Cost calculation                                                  */
/* ------------------------------------------------------------------ */

export function calculateRequestCost(req: RequestUsage): number | null {
  const pricing = getModelPricing(req.model);
  if (!pricing) return null;

  let cost = (req.inputTokens / 1_000_000) * pricing.inputPer1M;
  cost += (req.outputTokens / 1_000_000) * pricing.outputPer1M;

  if (req.cachedInputTokens > 0 && pricing.cachedInputPer1M !== undefined) {
    // cached tokens are already counted in inputTokens by most providers,
    // so we adjust: charged at cached rate instead of full input rate
    const savings = (req.cachedInputTokens / 1_000_000) * (pricing.inputPer1M - pricing.cachedInputPer1M);
    cost -= savings;
  }

  return Math.round(cost * 1_000_000) / 1_000_000; // avoid float noise
}

/* ------------------------------------------------------------------ */
/*  Budget Manager                                                    */
/* ------------------------------------------------------------------ */

export interface BudgetConfig {
  budgetUsd: number | null;
  budgetWarningPercent: number;
  enforceBudget: boolean;
}

const DEFAULT_BUDGET: BudgetConfig = {
  budgetUsd: null,
  budgetWarningPercent: 80,
  enforceBudget: false,
};

export function getBudgetConfig(): BudgetConfig {
  try {
    const budgetPath = path.join(getConfigDir(), "budget.json");
    const raw = fs.readFileSync(budgetPath, "utf8");
    return { ...DEFAULT_BUDGET, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_BUDGET };
  }
}

export function saveBudgetConfig(config: Partial<BudgetConfig>): BudgetConfig {
  const current = getBudgetConfig();
  const next = { ...current, ...config };
  try {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(getConfigDir(), "budget.json"), JSON.stringify(next, null, 2), "utf8");
  } catch {}
  return next;
}

export function clearBudget(): void {
  try {
    fs.unlinkSync(path.join(getConfigDir(), "budget.json"));
  } catch {}
}

export function checkBudget(spentUsd: number): { ok: boolean; warning: boolean; message?: string } {
  const config = getBudgetConfig();
  if (!config.budgetUsd || config.budgetUsd <= 0) {
    return { ok: true, warning: false };
  }

  const percent = (spentUsd / config.budgetUsd) * 100;

  if (percent >= 100) {
    return {
      ok: !config.enforceBudget,
      warning: true,
      message: `Budget exceeded: $${spentUsd.toFixed(2)} / $${config.budgetUsd.toFixed(2)} (${percent.toFixed(0)}%)`,
    };
  }

  if (percent >= config.budgetWarningPercent) {
    return {
      ok: true,
      warning: true,
      message: `Budget warning: $${spentUsd.toFixed(2)} / $${config.budgetUsd.toFixed(2)} (${percent.toFixed(0)}%)`,
    };
  }

  return { ok: true, warning: false };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function extractProvider(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : "unknown";
}

// Lazy singleton tracker for global usage
let _globalTracker: UsageTracker | null = null;

export function getGlobalTracker(): UsageTracker {
  if (!_globalTracker) _globalTracker = new UsageTracker();
  return _globalTracker;
}
