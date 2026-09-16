/**
 * ObservabilityHub — the ONE observability owner.
 *
 * Consumes runtime events; it never controls tool execution, routing,
 * permissions or session state. Every method is best-effort and never throws
 * into callers: if logging/metrics/tracing fails, the operation continues.
 */
import { logger, type LogLevel, type LogRecord, type StructuredLogger } from "./logger";
import { metrics, type MetricsRegistry } from "./metrics";
import { traceStore, type TraceStore } from "./trace";
import { newTraceId, type CorrelationContext } from "./correlation";

export class ObservabilityHub {
  readonly logger: StructuredLogger;
  readonly metrics: MetricsRegistry;
  readonly trace: TraceStore;

  constructor(opts: { logger?: StructuredLogger; metrics?: MetricsRegistry; trace?: TraceStore } = {}) {
    this.logger = opts.logger ?? logger;
    this.metrics = opts.metrics ?? metrics;
    this.trace = opts.trace ?? traceStore;
  }

  /** Structured log — never throws. */
  log(level: LogLevel, component: string, event: string, fields: Omit<Partial<LogRecord>, "level" | "component" | "event"> = {}): void {
    try { this.logger.log({ level, component, event, ...fields }); } catch {}
  }

  info(component: string, event: string, fields: Omit<Partial<LogRecord>, "level" | "component" | "event"> = {}): void {
    this.log("info", component, event, fields);
  }
  warn(component: string, event: string, fields: Omit<Partial<LogRecord>, "level" | "component" | "event"> = {}): void {
    this.log("warn", component, event, fields);
  }
  error(component: string, event: string, fields: Omit<Partial<LogRecord>, "level" | "component" | "event"> = {}): void {
    this.log("error", component, event, fields);
  }
  debug(component: string, event: string, fields: Omit<Partial<LogRecord>, "level" | "component" | "event"> = {}): void {
    this.log("debug", component, event, fields);
  }

  /** Start a trace for a top-level operation when none exists. */
  ensureTraceId(corr: CorrelationContext): CorrelationContext {
    if (corr.traceId) return corr;
    return { ...corr, traceId: newTraceId() };
  }

  /** Bounded flush — never blocks shutdown beyond `timeoutMs`. */
  async flush(timeoutMs = 500): Promise<void> {
    // StructuredLogger is synchronous (appendFileSync); nothing to flush beyond a best-effort fsync.
    // This hook exists so shutdown can await observability without hanging on a stuck writer.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      try { (t as any).unref?.(); } catch {}
    });
  }
}

/** Process-wide canonical observability owner. */
export const observabilityHub = new ObservabilityHub();
