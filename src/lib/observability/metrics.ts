/**
 * Local metrics — bounded counters/histograms keyed by sanitized labels.
 *
 * Metrics observe; they never gate control flow and never throw into callers.
 * Labels are sanitized to bounded cardinality (no sessionId, path, raw error text).
 */
import type { CorrelationContext } from "./correlation";

const MAX_SERIES = 500;
const MAX_LABEL_VALUE_LEN = 64;

function sanitizeLabelValue(v: string): string {
  let s = String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").slice(0, MAX_LABEL_VALUE_LEN);
  s = s.replace(/^_+|_+$/g, "");
  return s || "unknown";
}

export const ALLOWED_LABEL_KEYS = new Set([
  "provider", "model_family", "model", "tool", "outcome", "error_class", "harness", "operation", "status",
]);

export function sanitizeLabels(input?: Record<string, string>): Record<string, string> | undefined {
  if (!input) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!ALLOWED_LABEL_KEYS.has(k)) continue;
    if (typeof v !== "string" || v.length === 0) continue;
    out[k] = sanitizeLabelValue(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function metricKey(name: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`);
  return `${name}{${parts.join(",")}}`;
}

export interface MetricSample {
  name: string;
  labels?: Record<string, string>;
  count: number;
  sumMs: number; // for duration metrics (0 when count-only)
  lastAt: number;
  // bounded last error class for count metrics
  lastErrorClass?: string;
}

export class MetricsRegistry {
  private series = new Map<string, MetricSample>();
  private order: string[] = []; // insertion order for bounded eviction

  increment(name: string, opts: { labels?: Record<string, string>; correlation?: CorrelationContext; valueMs?: number; errorClass?: string } = {}): void {
    try {
      const labels = sanitizeLabels(opts.labels);
      const key = metricKey(name, labels);
      let sample = this.series.get(key);
      if (!sample) {
        if (this.series.size >= MAX_SERIES) {
          const oldest = this.order.shift();
          if (oldest) this.series.delete(oldest);
        }
        sample = { name, ...(labels ? { labels } : {}), count: 0, sumMs: 0, lastAt: 0 };
        this.series.set(key, sample);
        this.order.push(key);
      }
      sample.count += 1;
      if (typeof opts.valueMs === "number" && Number.isFinite(opts.valueMs)) sample.sumMs += opts.valueMs;
      sample.lastAt = Date.now();
      if (opts.errorClass) sample.lastErrorClass = sanitizeLabelValue(opts.errorClass);
    } catch {}
  }

  /** Convenience for duration metrics. */
  observeDuration(name: string, durationMs: number, labels?: Record<string, string>): void {
    this.increment(name, { labels, valueMs: durationMs });
  }

  snapshot(): MetricSample[] {
    return [...this.series.values()].map((s) => ({ ...s, ...(s.labels ? { labels: { ...s.labels } } : {}) }));
  }

  reset(): void { this.series.clear(); this.order = []; }

  // Canonical metric names (kept small, per spec).
  static NAMES = {
    modelRequestCount: "model.request.count",
    modelRequestDuration: "model.request.duration",
    modelRequestError: "model.request.error",
    providerAttemptCount: "provider.attempt.count",
    providerAttemptDuration: "provider.attempt.duration",
    providerFallbackCount: "provider.fallback.count",
    toolCallCount: "tool.call.count",
    toolCallDuration: "tool.call.duration",
    toolCallError: "tool.call.error",
    sessionTurnCount: "session.turn.count",
    sessionTurnDuration: "session.turn.duration",
    contextCompactionCount: "context.compaction.count",
    contextCompactionDuration: "context.compaction.duration",
    repoVerifyCount: "repo.verify.count",
    repoRepairCount: "repo.repair.count",
    mcpCallCount: "mcp.call.count",
    mcpCallDuration: "mcp.call.duration",
    externalHarnessRunCount: "external_harness.run.count",
    externalHarnessRunDuration: "external_harness.run.duration",
  } as const;
}

export const metrics = new MetricsRegistry();

export function boundedModelLabel(modelId?: string): string {
  if (!modelId) return "unknown";
  // model_family when possible (before '/'), else truncated id.
  const base = modelId.includes("/") ? modelId.split("/").slice(-1)[0] : modelId;
  return sanitizeLabelValue(base.split(":")[0].split("-").slice(0, 2).join("-"));
}
