/**
 * Worker Execution Result model — Layer 4 Phase 2 (Scheduler Correctness)
 *
 * Failure is a first-class value: providers/gateway/network/auth errors are
 * typed results, NEVER stringly-typed "success". A string return value alone
 * can never mark a node COMPLETED.
 */

import type { AgentRole, TaskNode } from "./types";

/** Structured result every scheduler worker must produce. */
export interface WorkerExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  /** Stable machine-readable failure code (e.g. AUTH_REQUIRED, PROVIDER_NETWORK). */
  errorCode?: string;
  /** Whether the failure may be retried (transient network/timeout/429/5xx). */
  retryable?: boolean;
  tokensUsed?: number;
}

/** Typed worker failure thrown by executors that prefer exceptions. */
export class WorkerExecutionError extends Error {
  public readonly errorCode: string;
  public readonly retryable: boolean;
  public readonly tokensUsed?: number;

  constructor(
    message: string,
    opts: { errorCode?: string; retryable?: boolean; tokensUsed?: number } = {}
  ) {
    super(message);
    this.name = "WorkerExecutionError";
    this.errorCode = opts.errorCode || "WORKER_ERROR";
    this.retryable = opts.retryable ?? true;
    this.tokensUsed = opts.tokensUsed;
  }
}

/**
 * Classifies a worker error into (code, retryable).
 *
 * RETRYABLE: transient network, timeout, 429 rate-limit, 5xx provider errors.
 * NON_RETRYABLE: 401/403 auth, model_not_found / invalid model, policy denied,
 * invalid task, malformed request — retrying is meaningless and wasteful.
 */
export function classifyWorkerError(err: unknown): {
  code: string;
  retryable: boolean;
  message: string;
} {
  if (err instanceof WorkerExecutionError) {
    return { code: err.errorCode, retryable: err.retryable, message: err.message };
  }

  const message = err instanceof Error ? err.message : String(err ?? "unknown error");
  const lower = message.toLowerCase();

  // Explicit typed classification from a WorkerExecutionError-like shape.
  // (falls through to string heuristics below otherwise)

  // NON-RETRYABLE: auth
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("invalid api key") ||
    lower.includes("invalid_api_key") ||
    lower.includes("authentication") ||
    lower.includes("no active credentials") ||
    lower.includes("no active ai provider")
  ) {
    return { code: "AUTH_REQUIRED", retryable: false, message };
  }

  // NON-RETRYABLE: model problems
  if (
    lower.includes("model_not_found") ||
    lower.includes("model not found") ||
    lower.includes("invalid model") ||
    lower.includes("does not exist or you do not have access")
  ) {
    return { code: "MODEL_NOT_FOUND", retryable: false, message };
  }

  // NON-RETRYABLE: policy/task shape
  if (
    lower.includes("permission denied") ||
    lower.includes("blocked by sandbox policy") ||
    lower.includes("policy") && lower.includes("denied") ||
    lower.includes("approval required") ||
    lower.includes("invalid task") ||
    lower.includes("malformed request")
  ) {
    return { code: "POLICY_DENIED", retryable: false, message };
  }

  // NON-RETRYABLE: malformed response from provider (deterministic, not transient)
  if (lower.includes("malformed") || lower.includes("invalid json response")) {
    return { code: "MALFORMED_RESPONSE", retryable: false, message };
  }

  // RETRYABLE: HTTP-level
  if (/\b429\b/.test(lower) || lower.includes("rate limit") || lower.includes("too many requests")) {
    return { code: "RATE_LIMITED", retryable: true, message };
  }
  if (/\b5\d\d\b/.test(message) || lower.includes("server error") || lower.includes("bad gateway") || lower.includes("service unavailable")) {
    return { code: "PROVIDER_SERVER_ERROR", retryable: true, message };
  }

  // RETRYABLE: transport-level
  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("etimedout") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("econnaborted") ||
    lower.includes("enotfound") ||
    lower.includes("ehostunreach") ||
    lower.includes("enetunreach") ||
    lower.includes("connection refused") ||
    lower.includes("network") ||
    lower.includes("fetch failed") ||
    lower.includes("socket")
  ) {
    return { code: "PROVIDER_NETWORK", retryable: true, message };
  }

  // Default: unknown → non-retryable (fail fast, deterministic).
  return { code: "UNKNOWN", retryable: false, message };
}

/**
 * Normalizes any executor return value into a WorkerExecutionResult.
 *
 * Contract:
 *  - WorkerExecutionResult input: returned as-is.
 *  - string input: legacy adapter → treated as SUCCESS ONLY if non-empty.
 *  - undefined/null/empty-string: FAILURE (an executor returning nothing is not success).
 *  - throw inside here is impossible; classifyWorkerError is used by the scheduler.
 */
export function normalizeWorkerResult(value: unknown): WorkerExecutionResult {
  if (value && typeof value === "object" && typeof (value as any).success === "boolean") {
    const r = value as WorkerExecutionResult;
    return {
      success: r.success,
      output: r.output,
      error: r.error,
      errorCode: r.errorCode,
      retryable: r.retryable,
      tokensUsed: r.tokensUsed,
    };
  }

  // Legacy string adapter: non-empty string = explicit success.
  if (typeof value === "string") {
    if (value.length > 0) {
      return { success: true, output: value };
    }
    return { success: false, error: "Executor returned an empty string result.", errorCode: "EMPTY_RESULT" };
  }

  return { success: false, error: "Executor returned no result.", errorCode: "EMPTY_RESULT" };
}

/** Builds a structured failure result from a thrown error. */
export function workerResultFromError(err: unknown, tokensUsed?: number): WorkerExecutionResult {
  const c = classifyWorkerError(err);
  // Preserve token accounting from typed WorkerExecutionError (budget gate C
  // must see tokens burned by the failed attempt — no double-count, no loss).
  const typedTokens = err instanceof WorkerExecutionError ? err.tokensUsed : undefined;
  return {
    success: false,
    error: c.message,
    errorCode: c.code,
    retryable: c.retryable,
    tokensUsed: tokensUsed ?? typedTokens,
  };
}

/** Extracts token usage from a result (0 when absent/unknown). */
export function tokensOf(result: WorkerExecutionResult | undefined | null): number {
  if (!result || typeof result.tokensUsed !== "number" || !Number.isFinite(result.tokensUsed)) return 0;
  return Math.max(0, Math.floor(result.tokensUsed));
}

export interface WorkerAttemptContext {
  node: TaskNode;
  role: AgentRole;
  prompt: string;
}
