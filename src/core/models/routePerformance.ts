/**
 * Phase 82 §5 — Per-route performance intelligence.
 *
 * Bounded by construction: counters plus an EWMA plus a fixed-size ring of
 * recent latencies. Nothing unbounded grows, and NO prompt/response content is
 * ever stored — only numeric aggregates keyed by route id.
 *
 * Every method is total: a metric can never fail, throw into, or slow down the
 * request it is measuring. Non-finite input is discarded rather than recorded.
 *
 * Stale data decays to "unknown": after `ROUTE_METRIC_TTL_MS` without a new
 * observation the derived rate/latency fields are withheld so the scorer treats
 * them as neutral instead of as a current fact.
 */

import type { FailureKind } from "./failureKind";

/** Successful samples required before observed latency is trustworthy. */
export const ROUTE_LATENCY_MIN_SAMPLES = 2;
/** Bounded ring of recent latencies used for the median. */
export const ROUTE_RING_SIZE = 20;
/** Observations older than this are withheld as stale. */
export const ROUTE_METRIC_TTL_MS = 6 * 60 * 60 * 1000;
/** EWMA smoothing factor for latency / TTFT. */
const ALPHA = 0.3;

export interface RouteOutcome {
  ok: boolean;
  durationMs?: number;
  /** Time to first streamed token, when the transport exposes it. */
  ttftMs?: number;
  /** Classification for failures (ignored on success). */
  failureKind?: FailureKind;
  /** False when the failure was the caller's fault and must not affect health. */
  affectsHealth?: boolean;
  /** Streaming observability only. */
  streaming?: boolean;
}

export interface RoutePerformanceSnapshot {
  routeId: string;
  samples: number;
  successCount: number;
  failureCount: number;
  /** Failures excluded from provider health (permission/cancel/bad request). */
  callerFaultCount: number;
  /** EWMA of successful latencies, withheld when stale/insufficient. */
  latencyMs?: number;
  /** Median of the recent-latency ring, withheld when stale/insufficient. */
  medianLatencyMs?: number;
  /** EWMA of time-to-first-token, when the transport reported one. */
  ttftMs?: number;
  /** Successful / total, withheld when stale or below the sample floor. */
  successRate?: number;
  /** True when enough fresh observations exist to judge this route. */
  sufficient: boolean;
  /** True when the record exists but is too old to trust. */
  stale: boolean;
  updatedAt: number;
  lastFailureKind?: FailureKind;
}

interface RouteRecord {
  routeId: string;
  samples: number;
  successCount: number;
  failureCount: number;
  callerFaultCount: number;
  latencyEma?: number;
  ttftEma?: number;
  ring: number[];
  updatedAt: number;
  lastFailureKind?: FailureKind;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export class RoutePerformanceTracker {
  private readonly records = new Map<string, RouteRecord>();

  /** Record one observed outcome. Never throws. */
  record(routeId: string, outcome: RouteOutcome, now = Date.now()): void {
    try {
      if (!routeId) return;
      const current = this.records.get(routeId) ?? emptyRecord(routeId);
      current.samples += 1;

      if (outcome.ok) {
        current.successCount += 1;
        const duration = finite(outcome.durationMs);
        if (duration !== undefined) {
          current.latencyEma = current.latencyEma === undefined ? duration : current.latencyEma * (1 - ALPHA) + duration * ALPHA;
          current.ring.push(duration);
          if (current.ring.length > ROUTE_RING_SIZE) current.ring.shift();
        }
        const ttft = finite(outcome.ttftMs);
        if (ttft !== undefined) {
          current.ttftEma = current.ttftEma === undefined ? ttft : current.ttftEma * (1 - ALPHA) + ttft * ALPHA;
        }
      } else {
        if (outcome.affectsHealth === false) current.callerFaultCount += 1;
        else current.failureCount += 1;
        if (outcome.failureKind) current.lastFailureKind = outcome.failureKind;
      }

      current.updatedAt = now;
      this.records.set(routeId, current);
    } catch {
      // Observability must never affect the request it observes.
    }
  }

  has(routeId: string): boolean {
    return this.records.has(routeId);
  }

  /** Derived snapshot. `stale` records withhold every rate/latency field. */
  snapshot(routeId: string, now = Date.now()): RoutePerformanceSnapshot {
    const record = this.records.get(routeId);
    if (!record) return emptySnapshot(routeId);
    return derive(record, now);
  }

  snapshots(now = Date.now()): RoutePerformanceSnapshot[] {
    return [...this.records.values()].map((record) => derive(record, now));
  }

  /** Drop records whose last observation is older than the TTL. */
  prune(now = Date.now(), ttlMs = ROUTE_METRIC_TTL_MS): number {
    let removed = 0;
    for (const [routeId, record] of [...this.records]) {
      if (now - record.updatedAt > ttlMs) {
        this.records.delete(routeId);
        removed += 1;
      }
    }
    return removed;
  }

  reset(routeId?: string): void {
    if (routeId) this.records.delete(routeId);
    else this.records.clear();
  }

  /** Serializable state — numbers and ids only, never content. */
  toJSON(): RoutePerformanceRecord[] {
    return [...this.records.values()].map((record) => ({
      routeId: record.routeId,
      samples: record.samples,
      successCount: record.successCount,
      failureCount: record.failureCount,
      callerFaultCount: record.callerFaultCount,
      ...(record.latencyEma !== undefined ? { latencyEma: record.latencyEma } : {}),
      ...(record.ttftEma !== undefined ? { ttftEma: record.ttftEma } : {}),
      ring: [...record.ring],
      updatedAt: record.updatedAt,
      ...(record.lastFailureKind ? { lastFailureKind: record.lastFailureKind } : {}),
    }));
  }

  /** Restore persisted state. Malformed rows are skipped, never thrown. */
  load(records: unknown): number {
    if (!Array.isArray(records)) return 0;
    let loaded = 0;
    for (const raw of records) {
      const record = parseRecord(raw);
      if (!record) continue;
      this.records.set(record.routeId, record);
      loaded += 1;
    }
    return loaded;
  }
}

export interface RoutePerformanceRecord {
  routeId: string;
  samples: number;
  successCount: number;
  failureCount: number;
  callerFaultCount: number;
  latencyEma?: number;
  ttftEma?: number;
  ring: number[];
  updatedAt: number;
  lastFailureKind?: FailureKind;
}

function emptyRecord(routeId: string): RouteRecord {
  return {
    routeId,
    samples: 0,
    successCount: 0,
    failureCount: 0,
    callerFaultCount: 0,
    ring: [],
    updatedAt: 0,
  };
}

function emptySnapshot(routeId: string): RoutePerformanceSnapshot {
  return {
    routeId,
    samples: 0,
    successCount: 0,
    failureCount: 0,
    callerFaultCount: 0,
    sufficient: false,
    stale: false,
    updatedAt: 0,
  };
}

function derive(record: RouteRecord, now: number): RoutePerformanceSnapshot {
  const stale = record.updatedAt > 0 && now - record.updatedAt > ROUTE_METRIC_TTL_MS;
  const providerOutcomes = record.successCount + record.failureCount;
  const sufficient = !stale && providerOutcomes >= ROUTE_LATENCY_MIN_SAMPLES;

  const snapshot: RoutePerformanceSnapshot = {
    routeId: record.routeId,
    samples: record.samples,
    successCount: record.successCount,
    failureCount: record.failureCount,
    callerFaultCount: record.callerFaultCount,
    sufficient,
    stale,
    updatedAt: record.updatedAt,
    ...(record.lastFailureKind ? { lastFailureKind: record.lastFailureKind } : {}),
  };

  if (stale) return snapshot;

  if (record.successCount >= ROUTE_LATENCY_MIN_SAMPLES) {
    const median = medianOf(record.ring);
    if (median !== undefined) {
      snapshot.medianLatencyMs = median;
      snapshot.latencyMs = record.latencyEma ?? median;
    }
  }
  if (record.ttftEma !== undefined) snapshot.ttftMs = record.ttftEma;
  if (providerOutcomes >= ROUTE_LATENCY_MIN_SAMPLES) {
    snapshot.successRate = record.successCount / providerOutcomes;
  }
  return snapshot;
}

function medianOf(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function parseRecord(raw: unknown): RouteRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.routeId !== "string" || !value.routeId) return null;

  const ring = Array.isArray(value.ring)
    ? value.ring.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry) && entry >= 0)
    : [];
  const latencyEma = finite(value.latencyEma);
  const ttftEma = finite(value.ttftEma);
  const lastFailureKind = typeof value.lastFailureKind === "string" ? (value.lastFailureKind as FailureKind) : undefined;

  return {
    routeId: value.routeId,
    samples: counter(value.samples),
    successCount: counter(value.successCount),
    failureCount: counter(value.failureCount),
    callerFaultCount: counter(value.callerFaultCount),
    ...(latencyEma !== undefined ? { latencyEma } : {}),
    ...(ttftEma !== undefined ? { ttftEma } : {}),
    ring: ring.slice(-ROUTE_RING_SIZE),
    updatedAt: counter(value.updatedAt),
    ...(lastFailureKind ? { lastFailureKind } : {}),
  };
}

function counter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Process-wide canonical route performance tracker. */
export const routePerformance = new RoutePerformanceTracker();
