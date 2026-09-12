/**
 * Phase 79 §20 — Structured provider/routing errors.
 *
 * Every failure the model layer raises carries the same fields so callers can
 * branch on `retryable` without string-matching a message:
 *
 *   { code, provider, model, retryable, cause }
 *
 * Nothing here ever embeds a credential. Messages are built from ids and
 * provider-supplied text only, and providers are expected to redact their own
 * key before it reaches us (the existing adapters already do).
 */

export type ProviderErrorCode =
  | "DUPLICATE_PROVIDER"
  | "PROVIDER_NOT_FOUND"
  | "MODEL_NOT_FOUND"
  | "MODEL_CAPABILITY"
  | "PROVIDER_AUTH"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_UNAVAILABLE"
  | "MODEL_ROUTING"
  | "INVALID_MODEL_REFERENCE";

export interface ProviderErrorFields {
  provider?: string;
  model?: string;
  retryable: boolean;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider?: string;
  readonly model?: string;
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(code: ProviderErrorCode, message: string, fields: ProviderErrorFields) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.provider = fields.provider;
    this.model = fields.model;
    this.retryable = fields.retryable;
    this.cause = fields.cause;
  }

  /** Serialized shape safe for logs/events — never a credential. */
  toJSON(): {
    name: string;
    code: ProviderErrorCode;
    message: string;
    provider?: string;
    model?: string;
    retryable: boolean;
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      provider: this.provider,
      model: this.model,
      retryable: this.retryable,
    };
  }
}

export class DuplicateProviderError extends ProviderError {
  constructor(provider: string) {
    super("DUPLICATE_PROVIDER", `A provider with id '${provider}' is already registered.`, {
      provider,
      retryable: false,
    });
  }
}

export class ProviderNotFoundError extends ProviderError {
  constructor(provider: string, cause?: unknown) {
    super("PROVIDER_NOT_FOUND", `No provider registered with id '${provider}'.`, {
      provider,
      retryable: false,
      cause,
    });
  }
}

export class ModelNotFoundError extends ProviderError {
  constructor(model: string, provider?: string, cause?: unknown) {
    super(
      "MODEL_NOT_FOUND",
      provider
        ? `Model '${model}' is not available from provider '${provider}'.`
        : `No model registered matching '${model}'.`,
      { provider, model, retryable: false, cause },
    );
  }
}

export class ModelCapabilityError extends ProviderError {
  constructor(model: string, missing: string[], provider?: string) {
    super(
      "MODEL_CAPABILITY",
      `Model '${model}' does not satisfy required capabilities: ${missing.join(", ")}.`,
      { provider, model, retryable: false },
    );
  }
}

export class ProviderAuthError extends ProviderError {
  constructor(provider: string, message = "Authentication failed.", cause?: unknown) {
    super("PROVIDER_AUTH", message, { provider, retryable: false, cause });
  }
}

export class ProviderRateLimitError extends ProviderError {
  constructor(provider: string, message = "Provider rate limit exceeded.", cause?: unknown) {
    super("PROVIDER_RATE_LIMIT", message, { provider, retryable: true, cause });
  }
}

export class ProviderUnavailableError extends ProviderError {
  constructor(provider: string, message = "Provider is unavailable.", cause?: unknown) {
    super("PROVIDER_UNAVAILABLE", message, { provider, retryable: true, cause });
  }
}

export class ModelRoutingError extends ProviderError {
  constructor(message: string, fields: Omit<ProviderErrorFields, "retryable"> & { retryable?: boolean } = {}) {
    super("MODEL_ROUTING", message, { ...fields, retryable: fields.retryable ?? false });
  }
}

export class InvalidModelReferenceError extends ProviderError {
  constructor(raw: string, reason: string) {
    super(
      "INVALID_MODEL_REFERENCE",
      `Invalid model reference '${raw}': ${reason}`,
      { model: raw, retryable: false },
    );
  }
}

/** Credential-looking material that must never reach a log line. */
const SECRET_PATTERNS: RegExp[] = [
  // Key prefixes; `*` masked forms (e.g. "sk-tQAfv****...ZY5s" printed by
  // provider error messages) are also credential-shaped and must be redacted.
  /\b(?:sk|pk|rk|or)-[A-Za-z0-9*_-]{8,}\b/g,
  /\b[A-Za-z0-9_-]{32,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/**
 * Redact anything credential-shaped from a message before it is surfaced in a
 * log, an event, or a status line. Provider adapters already redact their own
 * key; this is the last line of defence for provider-supplied error text.
 */
export function redactSecret(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}
