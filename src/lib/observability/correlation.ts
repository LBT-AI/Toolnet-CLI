/**
 * Correlation model — propagated identity for observability.
 *
 * Every structured log, metric and span carries a subset of these fields so
 * a single session/turn can be traced without joining disconnected random ids.
 * No caller is required to fill every field; hubs propagate what exists.
 */
export interface CorrelationContext {
  sessionId?: string;
  turnId?: string;
  runId?: string;
  modelRequestId?: string;
  providerAttemptId?: string;
  toolCallId?: string;
  backgroundJobId?: string;
  subagentId?: string;
  teamworkNodeId?: string;
  externalHarnessRunId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
}

let seq = 0;

function nextId(prefix: string): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function newTraceId(): string {
  return nextId("tr");
}

export function newSpanId(): string {
  return nextId("sp");
}

export function newTurnId(): string {
  return nextId("turn");
}

export function correlationFrom(corr?: CorrelationContext): CorrelationContext {
  if (!corr) return {};
  const out: CorrelationContext = {};
  for (const [k, v] of Object.entries(corr)) {
    if (typeof v === "string" && v.length > 0) (out as any)[k] = v;
  }
  return out;
}

export function childCorrelation(parent: CorrelationContext, extra?: Partial<CorrelationContext>): CorrelationContext {
  return { ...correlationFrom(parent), ...correlationFrom(extra as CorrelationContext) };
}
