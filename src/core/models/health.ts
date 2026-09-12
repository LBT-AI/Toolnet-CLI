/**
 * Phase 79 §12 — Lightweight provider health.
 *
 * In-memory only (no distributed state): counters, an EMA latency and a
 * consecutive-failure streak. Health is derived from OBSERVED request
 * outcomes — never from a model-id guess and never from an unrecorded error.
 *
 * Deterministic transitions:
 *   successes only                       → healthy
 *   1–2 consecutive failures             → degraded
 *   >= FAILURE_THRESHOLD consecutive     → unavailable
 *   a success anywhere                   → healthy again
 *
 * Phase 82 §4 tightens WHICH failures count: only provider-attributable
 * failures move the needle. A permission denial, a user cancellation, a
 * malformed request or an invalid tool schema is recorded as an observation but
 * can never degrade a provider — see `recordOutcome` and `failureKind.ts`.
 */

import type { HealthState, ProviderHealth } from "./types";
import { unknownHealth } from "./types";
import { redactSecret } from "./errors";
import { classifyProviderFailure, type FailureKind } from "./failureKind";

/** Consecutive failures before a provider is considered unavailable. */
export const FAILURE_THRESHOLD = 3;

/** Smoothing factor for the latency EMA. */
const LATENCY_ALPHA = 0.3;

/** Bounded ring of recently observed failure kinds, for diagnostics only. */
const RECENT_FAILURE_LIMIT = 5;

/** Successful outcomes required before `availability` is reported. */
export const AVAILABILITY_MIN_SAMPLES = 2;

export interface ProviderOutcome {
  ok: boolean;
  latencyMs?: number;
  error?: unknown;
  /** Pre-computed classification; when omitted it is derived from `error`. */
  kind?: FailureKind;
  /** Override for whether this outcome counts against provider health. */
  affectsHealth?: boolean;
}

export class ProviderHealthTracker {
  private readonly records = new Map<string, ProviderHealth>();

  get(providerId: string): ProviderHealth {
    return { ...(this.records.get(providerId) ?? unknownHealth()) };
  }

  reset(providerId?: string): void {
    if (providerId) {
      this.records.delete(providerId);
      return;
    }
    this.records.clear();
  }

  recordSuccess(providerId: string, latencyMs?: number, now = Date.now()): ProviderHealth {
    const current = this.records.get(providerId) ?? unknownHealth();
    const previousEma = current.latencyMs;
    const nextEma =
      typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0
        ? previousEma === undefined
          ? latencyMs
          : previousEma * (1 - LATENCY_ALPHA) + latencyMs * LATENCY_ALPHA
        : previousEma;

    const next: ProviderHealth = {
      ...current,
      requestCount: current.requestCount + 1,
      successCount: current.successCount + 1,
      consecutiveFailures: 0,
      state: "healthy",
      latencyMs: nextEma,
      lastSuccessAt: now,
      availability: availabilityOf(current.successCount + 1, current.failureCount),
    };
    this.records.set(providerId, next);
    return { ...next };
  }

  /**
   * Record a provider-attributable failure.
   *
   * This low-level entry point keeps the historical contract (it always counts
   * against health). Callers holding a raw error should prefer `recordOutcome`,
   * which refuses to blame the provider for caller-fault failures.
   */
  recordFailure(providerId: string, error?: string, now = Date.now()): ProviderHealth {
    const current = this.records.get(providerId) ?? unknownHealth();
    const consecutiveFailures = current.consecutiveFailures + 1;

    const next: ProviderHealth = {
      ...current,
      requestCount: current.requestCount + 1,
      failureCount: current.failureCount + 1,
      consecutiveFailures,
      state: consecutiveFailures >= FAILURE_THRESHOLD ? "unavailable" : "degraded",
      lastErrorAt: now,
      lastFailureAt: now,
      availability: availabilityOf(current.successCount, current.failureCount + 1),
      lastError: error ? redactSecret(error).slice(0, 500) : undefined,
    };
    this.records.set(providerId, next);
    return { ...next };
  }

  /**
   * Phase 82 §4 — classification-aware outcome recording. Never throws.
   *
   * A caller-fault failure (permission, cancellation, bad request, schema) is
   * counted in `requestCount` only: it cannot degrade or improve health.
   */
  recordOutcome(providerId: string, outcome: ProviderOutcome, now = Date.now()): ProviderHealth {
    try {
      if (outcome.ok) return this.recordSuccess(providerId, outcome.latencyMs, now);

      const classification = outcome.kind
        ? { kind: outcome.kind, affectsHealth: outcome.affectsHealth ?? true }
        : classifyProviderFailure(outcome.error);
      const affectsHealth = outcome.affectsHealth ?? classification.affectsHealth;
      if (!affectsHealth) return this.recordObservation(providerId, classification.kind, outcome.error, now);

      const message = outcome.error instanceof Error ? outcome.error.message : outcome.error;
      const health = this.recordFailure(providerId, message === undefined ? undefined : String(message), now);
      return this.withFailureKind(providerId, classification.kind, health);
    } catch {
      return this.get(providerId);
    }
  }

  /** Count a caller-fault failure without moving the health state. */
  private recordObservation(
    providerId: string,
    kind: FailureKind,
    error: unknown,
    now: number,
  ): ProviderHealth {
    const current = this.records.get(providerId) ?? unknownHealth();
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
    const next: ProviderHealth = {
      ...current,
      requestCount: current.requestCount + 1,
      recentFailures: boundsRecentFailures([...(current.recentFailures ?? []), kind]),
      // The state is intentionally untouched: this was not the provider's fault.
      ...(current.lastFailureAt === undefined ? { lastFailureAt: now } : {}),
      ...(message ? { lastError: redactSecret(message).slice(0, 500) } : {}),
    };
    this.records.set(providerId, next);
    return { ...next };
  }

  private withFailureKind(providerId: string, kind: FailureKind, health: ProviderHealth): ProviderHealth {
    const next: ProviderHealth = {
      ...health,
      recentFailures: boundsRecentFailures([...(health.recentFailures ?? []), kind]),
    };
    this.records.set(providerId, next);
    return { ...next };
  }

  /** Explicitly mark a provider unavailable (e.g. auth rejected, disabled). */
  markUnavailable(providerId: string, error?: string, now = Date.now()): ProviderHealth {
    const current = this.records.get(providerId) ?? unknownHealth();
    const next: ProviderHealth = {
      ...current,
      state: "unavailable",
      consecutiveFailures: Math.max(current.consecutiveFailures, FAILURE_THRESHOLD),
      lastErrorAt: now,
      lastError: error ? redactSecret(error).slice(0, 500) : current.lastError,
    };
    this.records.set(providerId, next);
    return { ...next };
  }

  /** Derive a state from a raw record without mutating it. */
  static stateOf(health: ProviderHealth): HealthState {
    return health.state;
  }
}

/** Keep the diagnostic failure ring bounded. */
function boundsRecentFailures(kinds: string[]): string[] {
  return kinds.slice(-RECENT_FAILURE_LIMIT);
}

/** Availability over provider-attributable outcomes; withheld until sampled. */
function availabilityOf(successes: number, failures: number): number | undefined {
  const total = successes + failures;
  if (total < AVAILABILITY_MIN_SAMPLES) return undefined;
  return Math.round((successes / total) * 1000) / 1000;
}

/** Ranking used by `priority` routing: healthy first, unknown in the middle. */
export function healthRank(state: HealthState): number {
  switch (state) {
    case "healthy":
      return 0;
    case "unknown":
      return 1;
    case "degraded":
      return 2;
    case "unavailable":
      return 3;
  }
}
