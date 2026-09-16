/**
 * — Failure classification for health and route performance.
 *
 * The single rule this module enforces: a failure that is the CALLER's fault
 * must never mark a provider unhealthy. A permission denial, a user
 * cancellation, a malformed request and an invalid tool schema say nothing
 * about the provider, so they are recorded as observations but excluded from
 * health and reliability scoring.
 *
 * Retryability is a separate axis from health impact:
 *
 *   kind              retryable  affectsHealth
 *   rate-limit        yes        yes
 *   timeout           yes        yes
 *   network           yes        yes
 *   server            yes        yes     (5xx)
 *   auth              no         yes     (the provider rejected our credentials)
 *   unavailable       yes        yes
 *   stream-incomplete yes        yes     (silent EOF: truncated stream)
 *   quota             no         no      (our account is out of quota)
 *   bad-request       no         no
 *   permission        no         no
 *   cancelled         no         no
 *   schema            no         no
 *   unknown           no         no
 */

import { ProviderError } from "./errors";

export type FailureKind =
  | "rate-limit"
  | "timeout"
  | "network"
  | "server"
  | "auth"
  | "unavailable"
  | "stream-incomplete"
  | "quota"
  | "bad-request"
  | "permission"
  | "cancelled"
  | "schema"
  | "unknown";

export interface FailureClassification {
  kind: FailureKind;
  /** May a different route be tried? */
  retryable: boolean;
  /** Does this outcome count against the provider's health/reliability? */
  affectsHealth: boolean;
  /** Human-readable, already redacted by the caller. */
  detail?: string;
}

const TABLE: Record<FailureKind, { retryable: boolean; affectsHealth: boolean }> = {
  "rate-limit": { retryable: true, affectsHealth: true },
  timeout: { retryable: true, affectsHealth: true },
  network: { retryable: true, affectsHealth: true },
  server: { retryable: true, affectsHealth: true },
  auth: { retryable: false, affectsHealth: true },
  unavailable: { retryable: true, affectsHealth: true },
  "stream-incomplete": { retryable: true, affectsHealth: true },
  quota: { retryable: false, affectsHealth: false },
  "bad-request": { retryable: false, affectsHealth: false },
  permission: { retryable: false, affectsHealth: false },
  cancelled: { retryable: false, affectsHealth: false },
  schema: { retryable: false, affectsHealth: false },
  unknown: { retryable: false, affectsHealth: false },
};

export function failureProfile(kind: FailureKind): FailureClassification {
  return { kind, ...TABLE[kind] };
}

/**
 * Classify a thrown error. Structured `ProviderError`s win (they carry an
 * explicit `retryable` flag and a code); message matching is only the fallback
 * for third-party/transport errors.
 */
export function classifyProviderFailure(error: unknown): FailureClassification {
  if (error instanceof ProviderError) {
    const kind = kindFromCode(error.code, error.message);
    const profile = failureProfile(kind);
    return { ...profile, detail: error.message };
  }

  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);

  // Structural classification first: a truncated stream and an exhausted quota
  // are decisions the producer already made, so they must not depend on message
  // wording the way transport errors do.
  const failureKind = (error as { failureKind?: unknown } | null)?.failureKind;
  if (failureKind === "STREAM_INCOMPLETE" || name === "StreamIncompleteError") {
    return { ...failureProfile("stream-incomplete"), detail: message };
  }

  if (name === "AbortError" || name === "TimeoutError") {
    return { ...failureProfile(name === "AbortError" ? "cancelled" : "timeout"), detail: message };
  }
  if (/abort|cancel/i.test(message)) {
    // A caller-supplied timeout abort still reads as a timeout, not a cancel.
    if (/timeout|timed out/i.test(message)) return { ...failureProfile("timeout"), detail: message };
    return { ...failureProfile("cancelled"), detail: message };
  }
  if (isQuotaExhaustedMessage(message)) {
    return { ...failureProfile("quota"), detail: message };
  }
  // An explicit transport status is the strongest evidence available from a
  // string message, so it outranks word matching: "HTTP 403: forbidden" is an
  // auth failure, not a local permission denial.
  const status = /HTTP\s+(\d{3})/.exec(message)?.[1];
  if (status) {
    return { ...failureProfile(kindFromStatus(Number(status))), detail: message };
  }
  if (/permission|denied|not allowed|forbidden|sandbox/i.test(message)) {
    return { ...failureProfile("permission"), detail: message };
  }
  if (/invalid (request|tool|schema|argument|parameter)|malformed|unexpected token/i.test(message)) {
    return { ...failureProfile("bad-request"), detail: message };
  }
  if (/authenticat|unauthoriz|invalid api key|401|403/i.test(message)) {
    return { ...failureProfile("auth"), detail: message };
  }

  if (isRetryableTransportError(error)) {
    return { ...failureProfile("network"), detail: message };
  }
  if (/rate.?limit|too many requests|429/i.test(message)) {
    return { ...failureProfile("rate-limit"), detail: message };
  }
  if (/timeout|ETIMEDOUT|timed out/i.test(message)) return { ...failureProfile("timeout"), detail: message };
  if (/overloaded|temporarily unavailable|service unavailable|503/i.test(message)) {
    return { ...failureProfile("unavailable"), detail: message };
  }
  if (/schema/i.test(message)) return { ...failureProfile("schema"), detail: message };

  return { ...failureProfile("unknown"), detail: message };
}

/**
 * Transport error codes that mean "the connection, not the request, failed".
 * A reset or a refused connect says nothing about whether the request was
 * valid, so it is retryable regardless of message wording.
 */
const TRANSIENT_TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Best-effort transport code lookup; fetch buries it on `cause`. */
export function transportErrorCode(error: unknown): string | undefined {
  const candidates = [
    (error as { code?: unknown } | null)?.code,
    (error as { cause?: { code?: unknown } } | null)?.cause?.code,
    (error as { errno?: unknown } | null)?.errno,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * Whether an error is a transient transport failure. Covers both classified
 * transport codes and the wording undici/libuv use when they do not set one.
 */
export function isRetryableTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (
    /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|socket connection was closed|connection (was )?(reset|closed)|fetch failed|network|dns|HTTP\s+5\d\d/i.test(
      message,
    )
  ) {
    return true;
  }
  const code = transportErrorCode(error);
  return code !== undefined && TRANSIENT_TRANSPORT_CODES.has(code);
}

/**
 * Quote/credit exhaustion wears the same 429 as a transient rate limit, so the
 * body has to be read to tell them apart. Retrying a quota 429 burns time and
 * retries remain permanently outside the retry matrix; only evidence in the
 * text promotes it, never the bare status.
 */
export function isQuotaExhaustedMessage(message: string): boolean {
  return /(insufficient[_ ]quota|exceeded your current quota|quota exceeded|out of credits|insufficient credits|billing (hard )?limit|payment required|no credit balance|credit balance is too low)/i.test(
    message,
  );
}

function kindFromStatus(status: number): FailureKind {
  if (status === 429) return "rate-limit";
  if (status === 408 || status === 504) return "timeout";
  if (status === 401 || status === 403) return "auth";
  if (status === 400 || status === 404 || status === 405 || status === 409 || status === 422) return "bad-request";
  if (status === 500 || status === 502 || status === 503) return "unavailable";
  if (status >= 500) return "server";
  return "unknown";
}

function kindFromCode(code: ProviderError["code"], message: string): FailureKind {
  switch (code) {
    case "PROVIDER_RATE_LIMIT":
      return "rate-limit";
    case "PROVIDER_AUTH":
      return "auth";
    case "PROVIDER_UNAVAILABLE":
      return "unavailable";
    case "MODEL_CAPABILITY":
    case "INVALID_MODEL_REFERENCE":
      return "bad-request";
    case "MODEL_NOT_FOUND":
    case "PROVIDER_NOT_FOUND":
      return "bad-request";
    case "DUPLICATE_PROVIDER":
      return "bad-request";
    case "MODEL_ROUTING":
      // A routing failure is a caller/configuration problem, not an outage.
      return /unavailable|disabled/i.test(message) ? "unavailable" : "bad-request";
    default:
      return "unknown";
  }
}

/** Whether a failure may fall through to another route. */
export function isRetryableKind(kind: FailureKind): boolean {
  return TABLE[kind].retryable;
}

/** Whether an outcome should count against provider health. */
export function affectsProviderHealth(kind: FailureKind): boolean {
  return TABLE[kind].affectsHealth;
}
