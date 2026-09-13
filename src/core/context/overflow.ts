/**
 * Provider context-overflow classification.
 *
 * Overflow is the one failure this layer can actually fix, and conflating it
 * with a transient error is expensive: retrying an oversized request fails
 * identically, and falling back to another provider routes the same payload to a
 * different counter. Providers disagree about wording, so the matching lives
 * here, in one place, and the harness consumes the canonical result rather than
 * carrying provider-specific patterns itself.
 *
 * A provider adapter may map its own protocol codes into `classifyContextFailure`
 * by passing `code`/`status`, which is preferred over relying on prose alone.
 */

import type { OverflowClassification, OverflowKind } from "./types";

/** Raised when a request provably exceeded the model's context window. */
export class ContextOverflowError extends Error {
  readonly code = "CONTEXT_OVERFLOW";
  readonly provider?: string;
  readonly model?: string;
  readonly matchedBy: string;

  constructor(message: string, options: { provider?: string; model?: string; matchedBy?: string; cause?: unknown } = {}) {
    super(message);
    this.name = "ContextOverflowError";
    this.provider = options.provider;
    this.model = options.model;
    this.matchedBy = options.matchedBy ?? "unspecified";
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export interface FailureInput {
  message?: string;
  /** Provider-native error code, when the adapter exposes one. */
  code?: string;
  /** HTTP status, when the adapter exposes one. */
  status?: number;
  name?: string;
}

const OVERFLOW_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "context_length_exceeded", pattern: /context[_ -]?length[_ -]?exceeded/i },
  { label: "maximum context length", pattern: /maximum context length|max(?:imum)? context (?:window|tokens?)/i },
  { label: "context window exceeded", pattern: /(exceed|over).{0,20}context window/i },
  // The same fact stated in the other order, which several providers prefer.
  { label: "context window/limit exceeded", pattern: /(context window|context length|token limit).{0,20}(exceed|over|limit)/i },
  { label: "too many tokens", pattern: /too many tokens/i },
  { label: "reduce length", pattern: /(reduce|shorten) (the )?(length|prompt|input|messages)/i },
  { label: "prompt too long", pattern: /prompt is too long|input is too long|request is too large|request too large/i },
  { label: "token limit exceeded", pattern: /exceeds? (the )?(maximum|model'?s) (number of )?tokens/i },
  { label: "token count exceeds", pattern: /token count.{0,20}(exceed|over|limit)/i },
];

const RATE_LIMIT_PATTERNS = [/rate[_ -]?limit/i, /too many requests/i, /quota exceeded/i];
const AUTH_PATTERNS = [/unauthoriz/i, /invalid api[_ -]?key/i, /authentication|permission denied|forbidden/i];
const UNAVAILABLE_PATTERNS = [/overloaded|unavailable|capacity|connection reset|econnreset|timeout|timed out/i];
const CANCELLED_PATTERNS = [/aborterror|aborted|cancelled by|canceled by/i];
const BAD_REQUEST_PATTERNS = [/invalid[_ -]?request/i, /malformed/i, /unsupported (parameter|model)/i];

function matches(patterns: RegExp[], text: string): string | null {
  for (const pattern of patterns) {
    if (pattern.test(text)) return pattern.source;
  }
  return null;
}

function matchLabelled(patterns: Array<{ label: string; pattern: RegExp }>, text: string): string | null {
  for (const candidate of patterns) {
    if (candidate.pattern.test(text)) return candidate.label;
  }
  return null;
}

export function classifyContextFailure(input: FailureInput): OverflowClassification {
  const message = input.message ?? "";
  const code = input.code ?? "";
  const name = input.name ?? "";
  const haystack = `${message}\n${code}\n${name}`;
  const status = input.status;

  const cancelledBy = matches(CANCELLED_PATTERNS, haystack);
  if (name === "AbortError" || cancelledBy) {
    return { kind: "cancelled", retryable: false, compactionMayHelp: false, matchedBy: cancelledBy ?? "AbortError" };
  }

  // Explicit status codes are the most reliable signal and are checked before
  // prose, so a 429 that happens to mention "tokens" stays a rate limit.
  if (status === 401 || status === 403) {
    return { kind: "auth", retryable: false, compactionMayHelp: false, matchedBy: `status ${status}` };
  }
  if (status === 429) {
    return { kind: "rate_limit", retryable: true, compactionMayHelp: false, matchedBy: "status 429" };
  }

  const overflowBy = matchLabelled(OVERFLOW_PATTERNS, haystack);
  if (overflowBy) {
    return { kind: "context_overflow", retryable: false, compactionMayHelp: true, matchedBy: overflowBy };
  }
  // 413 is unambiguous even without matching prose.
  if (status === 413) {
    return { kind: "context_overflow", retryable: false, compactionMayHelp: true, matchedBy: "status 413" };
  }

  const rateBy = matches(RATE_LIMIT_PATTERNS, haystack);
  if (rateBy) return { kind: "rate_limit", retryable: true, compactionMayHelp: false, matchedBy: rateBy };

  if (status !== undefined && status >= 500) {
    return { kind: "unavailable", retryable: true, compactionMayHelp: false, matchedBy: `status ${status}` };
  }
  const unavailableBy = matches(UNAVAILABLE_PATTERNS, haystack);
  if (unavailableBy) return { kind: "unavailable", retryable: true, compactionMayHelp: false, matchedBy: unavailableBy };

  const authBy = matches(AUTH_PATTERNS, haystack);
  if (authBy) return { kind: "auth", retryable: false, compactionMayHelp: false, matchedBy: authBy };

  const badBy = matches(BAD_REQUEST_PATTERNS, haystack);
  if (badBy) return { kind: "bad_request", retryable: false, compactionMayHelp: false, matchedBy: badBy };

  if (status === 400 || status === 422) {
    return { kind: "bad_request", retryable: false, compactionMayHelp: false, matchedBy: `status ${status}` };
  }

  return { kind: "unknown", retryable: false, compactionMayHelp: false, matchedBy: "no pattern matched" };
}

export function isContextOverflow(error: unknown): boolean {
  if (error instanceof ContextOverflowError) return true;
  if (!error || typeof error !== "object") return false;
  const record = error as FailureInput;
  if (record.code === "CONTEXT_OVERFLOW") return true;
  return classifyContextFailure({ message: String(record.message ?? ""), code: record.code, name: record.name }).kind ===
    "context_overflow";
}

/**
 * Turn a failing attempt into the canonical overflow error, or null when the
 * failure is something compaction cannot fix.
 */
export function asContextOverflow(
  input: FailureInput,
  context: { provider?: string; model?: string; cause?: unknown } = {},
): ContextOverflowError | null {
  const classification = classifyContextFailure(input);
  if (classification.kind !== "context_overflow") return null;
  return new ContextOverflowError(input.message || "request exceeded the model context window", {
    provider: context.provider,
    model: context.model,
    matchedBy: classification.matchedBy,
    cause: context.cause,
  });
}

/** Attempts that must not be retried against another provider. */
export function isTerminalWithoutCompaction(kind: OverflowKind): boolean {
  return kind === "context_overflow" || kind === "auth" || kind === "bad_request" || kind === "cancelled";
}
