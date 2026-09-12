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
 */

import type { HealthState, ProviderHealth } from "./types";
import { unknownHealth } from "./types";
import { redactSecret } from "./errors";

/** Consecutive failures before a provider is considered unavailable. */
export const FAILURE_THRESHOLD = 3;

/** Smoothing factor for the latency EMA. */
const LATENCY_ALPHA = 0.3;

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
    };
    this.records.set(providerId, next);
    return { ...next };
  }

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
      lastError: error ? redactSecret(error).slice(0, 500) : undefined,
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
