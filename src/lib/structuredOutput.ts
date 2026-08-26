/**
 * Structured output types for ToolNet CLI headless mode.
 *
 * Supports --format text|markdown|json|jsonl
 * Backward compatible with --json (maps to format=json).
 *
 * JSONL events flow to stdout; human-readable logs go to stderr.
 */

/* ------------------------------------------------------------------ */
/*  Output format                                                     */
/* ------------------------------------------------------------------ */

export type OutputFormat = "text" | "markdown" | "json" | "jsonl";

export function parseFormat(raw: string | undefined): OutputFormat {
  if (!raw) return "text";
  const lower = raw.toLowerCase();
  if (lower === "json" || lower === "jsonl" || lower === "markdown" || lower === "text") {
    return lower;
  }
  return "text";
}

/* ------------------------------------------------------------------ */
/*  JSON final response schema                                        */
/* ------------------------------------------------------------------ */

export interface StructuredResponse {
  ok: boolean;
  response: string;
  sessionId?: string;
  model?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number | null;
    estimated?: boolean;
  };
  durationMs: number;
  error?: string;
}

/* ------------------------------------------------------------------ */
/*  JSONL event types                                                 */
/* ------------------------------------------------------------------ */

export type JsonlEvent =
  | SessionStartEvent
  | AssistantDeltaEvent
  | ToolStartEvent
  | ToolResultEvent
  | UsageEvent
  | FinalEvent
  | ErrorEvent;

export interface SessionStartEvent {
  type: "session_start";
  sessionId: string;
  model: string;
  timestamp: number;
}

export interface AssistantDeltaEvent {
  type: "assistant_delta";
  text: string;
  index?: number;
}

export interface ToolStartEvent {
  type: "tool_start";
  toolCallId: string;
  tool: string;
  args: Record<string, unknown>; // secrets redacted
}

export interface ToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  tool: string;
  exitCode: number;
  cached: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface UsageEvent {
  type: "usage";
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  estimated?: boolean;
}

export interface FinalEvent {
  type: "final";
  response: string;
  sessionId?: string;
  model?: string;
  durationMs: number;
}

export interface ErrorEvent {
  type: "error";
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

/* ------------------------------------------------------------------ */
/*  Error codes                                                       */
/* ------------------------------------------------------------------ */

export type ErrorCode =
  | "CONFIG_ERROR"
  | "AUTH_ERROR"
  | "GATEWAY_TIMEOUT"
  | "RATE_LIMIT"
  | "MODEL_ERROR"
  | "TOOL_ERROR"
  | "PERMISSION_DENIED"
  | "APPROVAL_REQUIRED"
  | "INTERNAL_ERROR";

export function classifyError(err: unknown): { code: ErrorCode; message: string; retryable: boolean } {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  if (lower.includes("timeout") || lower.includes("etimedout")) {
    return { code: "GATEWAY_TIMEOUT", message: msg, retryable: true };
  }
  if (lower.includes("rate limit") || lower.includes("429")) {
    return { code: "RATE_LIMIT", message: msg, retryable: true };
  }
  if (lower.includes("auth") || lower.includes("401") || lower.includes("403") || lower.includes("api key")) {
    return { code: "AUTH_ERROR", message: msg, retryable: false };
  }
  if (lower.includes("model") || lower.includes("500") || lower.includes("502") || lower.includes("503")) {
    return { code: "MODEL_ERROR", message: msg, retryable: true };
  }
  if (lower.includes("permission") || lower.includes("denied")) {
    return { code: "PERMISSION_DENIED", message: msg, retryable: false };
  }
  if (lower.includes("approval")) {
    return { code: "APPROVAL_REQUIRED", message: msg, retryable: false };
  }
  if (lower.includes("tool") || lower.includes("exec")) {
    return { code: "TOOL_ERROR", message: msg, retryable: false };
  }
  if (lower.includes("config")) {
    return { code: "CONFIG_ERROR", message: msg, retryable: false };
  }
  return { code: "INTERNAL_ERROR", message: msg, retryable: false };
}

/* ------------------------------------------------------------------ */
/*  Secret redaction for tool args                                    */
/* ------------------------------------------------------------------ */

const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
  /authorization/i,
];

export function redactSecretArgs(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const isSecret = SECRET_PATTERNS.some((p) => p.test(key));
    if (isSecret && typeof value === "string") {
      result[key] = value.slice(0, 4) + "•••" + value.slice(-4);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  JSONL writer                                                      */
/* ------------------------------------------------------------------ */

export class JsonlWriter {
  private buffer: string[] = [];

  write(event: JsonlEvent): void {
    this.buffer.push(JSON.stringify(event));
  }

  flush(): void {
    for (const line of this.buffer) {
      process.stdout.write(line + "\n");
    }
    this.buffer = [];
  }

  flushSync(): void {
    this.flush();
  }
}
