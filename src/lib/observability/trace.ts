/**
 * Local trace/span model — in-memory, bounded, no external collector required.
 *
 * Spans cover: agent turn, model request, provider attempt, tool call,
 * verification, compaction, external harness, MCP call. Parents use correlation
 * (traceId/parentSpanId). No span per token. Local inspection only.
 */
import { newSpanId, newTraceId, type CorrelationContext } from "./correlation";

export type SpanKind =
  | "agent_turn"
  | "model_request"
  | "provider_attempt"
  | "tool_call"
  | "verification"
  | "test"
  | "compaction"
  | "external_harness"
  | "mcp_call";

export type SpanStatus = "ok" | "error" | "cancelled";

export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: SpanKind;
  name: string;
  startMs: number;
  endMs?: number;
  durationMs?: number;
  status?: SpanStatus;
  errorCode?: string;
  correlation: CorrelationContext;
  attributes?: Record<string, string>;
}

const MAX_SPANS = 500;
const MAX_ATTR_LEN = 128;

function boundAttr(v: string): string {
  return String(v).slice(0, MAX_ATTR_LEN);
}

export class TraceStore {
  private spans: SpanData[] = [];
  private active = new Map<string, SpanData>();

  start(kind: SpanKind, name: string, correlation: CorrelationContext, extra?: { parentSpanId?: string; traceId?: string; attributes?: Record<string, string> }): SpanData {
    const traceId = extra?.traceId ?? correlation.traceId ?? newTraceId();
    const spanId = newSpanId();
    const parentSpanId = extra?.parentSpanId ?? correlation.parentSpanId;
    const span: SpanData = {
      traceId,
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      kind,
      name: boundAttr(name),
      startMs: Date.now(),
      correlation: { ...correlation, traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}) },
      ...(extra?.attributes ? { attributes: Object.fromEntries(Object.entries(extra.attributes).map(([k, v]) => [k, boundAttr(v)])) } : {}),
    };
    this.active.set(spanId, span);
    return span;
  }

  end(spanId: string, status: SpanStatus = "ok", errorCode?: string): SpanData | null {
    const s = this.active.get(spanId);
    if (!s) return null;
    this.active.delete(spanId);
    s.endMs = Date.now();
    s.durationMs = s.endMs - s.startMs;
    s.status = status;
    if (errorCode) s.errorCode = boundAttr(errorCode);
    this.spans.push(s);
    if (this.spans.length > MAX_SPANS) this.spans.shift();
    return s;
  }

  /** Convenience: run fn inside a span, always ending it (error vs ok). */
  async withSpan<T>(kind: SpanKind, name: string, correlation: CorrelationContext, fn: (span: SpanData) => Promise<T>): Promise<T> {
    const span = this.start(kind, name, correlation);
    try {
      const res = await fn(span);
      this.end(span.spanId, "ok");
      return res;
    } catch (err: any) {
      this.end(span.spanId, "error", err?.code ?? err?.name ?? "error");
      throw err;
    }
  }

  /** Bounded snapshot for local inspection (toolnet trace). */
  snapshot(opts: { traceId?: string; limit?: number } = {}): SpanData[] {
    let arr = [...this.spans, ...this.active.values()];
    if (opts.traceId) arr = arr.filter((s) => s.traceId === opts.traceId);
    arr.sort((a, b) => a.startMs - b.startMs);
    if (opts.limit) arr = arr.slice(-opts.limit);
    return arr;
  }

  forTrace(traceId: string): SpanData[] { return this.snapshot({ traceId }); }

  clear(): void { this.spans = []; this.active.clear(); }
}

export const traceStore = new TraceStore();
