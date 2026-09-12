/**
 * Phase 82 §13 — Routing intelligence persistence.
 *
 * Only *derived numeric intelligence* is persisted: per-route counters and
 * latency aggregates. Nothing else.
 *
 *   NEVER persisted: API keys, prompt text, response text, headers, auth data.
 *
 * Rules mirror the Phase 80 model cache so there is one storage discipline:
 *  - ATOMIC write to a temp file + rename, mode 0600, cache dir 0700;
 *  - CORRUPTION-SAFE: an unparseable/invalid file is quarantined, never thrown;
 *  - STALE → decay: records older than the metric TTL are dropped on load, so a
 *    long-dormant install does not route on month-old latency;
 *  - best-effort: a persistence failure can never fail a request or a CLI read.
 */

import fs from "node:fs";
import path from "node:path";
import { ensureToolnetDir, getToolnetCacheDir } from "../../lib/toolnetHome";
import { redactSecret } from "./errors";
import {
  ROUTE_METRIC_TTL_MS,
  RoutePerformanceTracker,
  routePerformance,
  type RoutePerformanceRecord,
} from "./routePerformance";

export const ROUTING_INTELLIGENCE_SCHEMA_VERSION = 1;

export interface RoutingIntelligenceFile {
  version: number;
  generatedAt: number;
  /** Derived per-route metrics only — numbers and ids. */
  routes: RoutePerformanceRecord[];
}

export interface ReadRoutingIntelligenceResult {
  ok: boolean;
  file?: RoutingIntelligenceFile;
  quarantined?: boolean;
  error?: string;
}

export function getRoutingIntelligencePath(): string {
  return path.join(getToolnetCacheDir(), "routing-intelligence.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A route id must look like an identifier, never like credential material. */
function isSafeRouteId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 300) return false;
  if (!/^[A-Za-z0-9._:/@-]+$/.test(value)) return false;
  return redactSecret(value) === value;
}

function numbersOnly(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseFile(raw: unknown): RoutingIntelligenceFile | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== ROUTING_INTELLIGENCE_SCHEMA_VERSION) return null;
  if (!Array.isArray(raw.routes)) return null;

  const routes: RoutePerformanceRecord[] = [];
  for (const entry of raw.routes) {
    if (!isRecord(entry) || !isSafeRouteId(entry.routeId)) continue;
    const ring = Array.isArray(entry.ring)
      ? entry.ring
          .map(numbersOnly)
          .filter((value): value is number => value !== undefined)
          .slice(-100)
      : [];
    const latencyEma = numbersOnly(entry.latencyEma);
    const ttftEma = numbersOnly(entry.ttftEma);
    routes.push({
      routeId: entry.routeId,
      samples: numbersOnly(entry.samples) ?? 0,
      successCount: numbersOnly(entry.successCount) ?? 0,
      failureCount: numbersOnly(entry.failureCount) ?? 0,
      callerFaultCount: numbersOnly(entry.callerFaultCount) ?? 0,
      ...(latencyEma !== undefined ? { latencyEma } : {}),
      ...(ttftEma !== undefined ? { ttftEma } : {}),
      ring,
      updatedAt: numbersOnly(entry.updatedAt) ?? 0,
    });
  }

  return {
    version: ROUTING_INTELLIGENCE_SCHEMA_VERSION,
    generatedAt: numbersOnly(raw.generatedAt) ?? 0,
    routes,
  };
}

/** Rename a bad file aside so it cannot break the next startup. */
function quarantine(filePath: string): boolean {
  try {
    fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
    return true;
  } catch {
    try {
      fs.rmSync(filePath, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Read persisted intelligence. Never throws; a corrupt file is quarantined and
 * reported. File contents are never logged (they hold no secrets, but the
 * discipline is uniform across the model layer).
 */
export function readRoutingIntelligence(
  filePath: string = getRoutingIntelligencePath(),
): ReadRoutingIntelligenceResult {
  let text: string;
  try {
    if (!fs.existsSync(filePath)) return { ok: false };
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return { ok: false, error: redactSecret(error instanceof Error ? error.message : String(error)) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, quarantined: quarantine(filePath), error: "routing intelligence file is not valid JSON" };
  }

  const file = parseFile(parsed);
  if (!file) {
    return { ok: false, quarantined: quarantine(filePath), error: "routing intelligence failed schema validation" };
  }
  return { ok: true, file };
}

/** Atomic 0600 write. Returns false (never throws) on any failure. */
export function writeRoutingIntelligence(
  file: RoutingIntelligenceFile,
  filePath: string = getRoutingIntelligencePath(),
): boolean {
  try {
    const dir = path.dirname(filePath);
    ensureToolnetDir(dir);
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hydrate a tracker from disk, dropping stale records (decay) and pruning the
 * tracker's own TTL. Returns what happened so callers can report it.
 */
export function loadRoutingIntelligence(options: {
  tracker?: RoutePerformanceTracker;
  filePath?: string;
  now?: number;
  ttlMs?: number;
} = {}): { loaded: number; droppedStale: number; quarantined: boolean } {
  const tracker = options.tracker ?? routePerformance;
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? ROUTE_METRIC_TTL_MS;

  const read = readRoutingIntelligence(options.filePath);
  if (!read.ok || !read.file) {
    return { loaded: 0, droppedStale: 0, quarantined: Boolean(read.quarantined) };
  }

  const fresh = read.file.routes.filter((record) => now - record.updatedAt <= ttlMs);
  const loaded = tracker.load(fresh);
  tracker.prune(now, ttlMs);
  return { loaded, droppedStale: read.file.routes.length - fresh.length, quarantined: false };
}

/** Snapshot the tracker to disk. Best-effort — never fails a request. */
export function persistRoutingIntelligence(options: {
  tracker?: RoutePerformanceTracker;
  filePath?: string;
  now?: number;
} = {}): boolean {
  const tracker = options.tracker ?? routePerformance;
  const now = options.now ?? Date.now();
  try {
    tracker.prune(now);
    return writeRoutingIntelligence(
      {
        version: ROUTING_INTELLIGENCE_SCHEMA_VERSION,
        generatedAt: now,
        routes: tracker.toJSON(),
      },
      options.filePath,
    );
  } catch {
    return false;
  }
}
