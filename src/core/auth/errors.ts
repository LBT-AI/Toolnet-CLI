/**
 * — Profile-id validation + structured auth errors.
 *
 * Profile ids are USER INPUT that becomes part of an on-disk map key, so they
 * are validated before anything touches the store: `provider/name`, name
 * bounded and restricted to safe characters — no path traversal, no control
 * characters, no leading/trailing separators.
 */

import { redactSecret } from "../models/errors";

/** Validate one profile NAME segment (`<name>` inside `provider/name`). */
export function validateProfileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new AuthProfileValidationError("profile name is required");
  if (trimmed.length > 64) {
    throw new AuthProfileValidationError("profile name must be at most 64 characters");
  }
  if (/[\\/\0]/.test(trimmed) || /[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new AuthProfileValidationError("profile name contains forbidden characters");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(trimmed)) {
    throw new AuthProfileValidationError(
      "profile name must start with a letter or digit and use only letters, digits, '.', '_', '-'",
    );
  }
  return trimmed;
}

/** Validate a PROVIDER segment (same charset as profile names). */
export function validateProviderSegment(providerId: string): string {
  const trimmed = providerId.trim().toLowerCase();
  if (!trimmed) throw new AuthProfileValidationError("provider id is required");
  if (trimmed.length > 64) {
    throw new AuthProfileValidationError("provider id must be at most 64 characters");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(trimmed)) {
    throw new AuthProfileValidationError("provider id contains forbidden characters");
  }
  return trimmed;
}

/** Compose and validate a canonical profile id `provider/name`. */
export function makeProfileId(providerId: string, name: string): string {
  const provider = validateProviderSegment(providerId);
  const profile = validateProfileName(name);
  return `${provider}/${profile}`;
}

/** Split `provider/name`; throws on malformed input. */
export function parseProfileId(profileId: string): { providerId: string; name: string } {
  const trimmed = profileId.trim();
  const idx = trimmed.indexOf("/");
  if (idx <= 0 || idx === trimmed.length - 1) {
    throw new AuthProfileValidationError(
      "profile id must be '<provider>/<name>' (e.g. openrouter/work)",
    );
  }
  return {
    providerId: validateProviderSegment(trimmed.slice(0, idx)),
    name: validateProfileName(trimmed.slice(idx + 1)),
  };
}

/** — base for all structured auth errors. */
export class AuthError extends Error {
  readonly code: string;
  readonly providerId?: string;
  readonly profileId?: string;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(init: {
    code: string;
    message: string;
    providerId?: string;
    profileId?: string;
    retryable?: boolean;
    cause?: unknown;
  }) {
    // Messages are built from ids and fixed strings, but redact anyway —
    // a cause chain must never smuggle a secret into .message.
    super(redactSecret(init.message));
    this.name = new.target.name;
    this.code = init.code;
    if (init.providerId !== undefined) this.providerId = init.providerId;
    if (init.profileId !== undefined) this.profileId = init.profileId;
    this.retryable = init.retryable ?? false;
    if (init.cause !== undefined) this.cause = init.cause;
  }
}

export class AuthProfileValidationError extends AuthError {
  constructor(message: string, profileId?: string) {
    super({ code: "AUTH_PROFILE_INVALID", message, ...(profileId ? { profileId } : {}), retryable: false });
  }
}

export class AuthProfileNotFoundError extends AuthError {
  constructor(profileId: string) {
    super({
      code: "AUTH_PROFILE_NOT_FOUND",
      message: `auth profile '${profileId}' does not exist`,
      profileId,
      retryable: false,
    });
  }
}

export class AuthProviderUnsupportedError extends AuthError {
  constructor(providerId: string) {
    super({
      code: "AUTH_PROVIDER_UNSUPPORTED",
      message: `provider '${providerId}' has no canonical credential configuration`,
      providerId,
      retryable: false,
    });
  }
}

export class CredentialUnavailableError extends AuthError {
  constructor(providerId: string, reason: string, profileId?: string) {
    super({
      code: "CREDENTIAL_UNAVAILABLE",
      message: `no credential available for provider '${providerId}'${profileId ? ` (profile '${profileId}')` : ""}: ${reason}`,
      providerId,
      ...(profileId ? { profileId } : {}),
      retryable: false,
    });
  }
}

export class CredentialStoreError extends AuthError {
  constructor(message: string, cause?: unknown) {
    super({ code: "CREDENTIAL_STORE_ERROR", message, retryable: true, cause });
  }
}

export class CredentialStoreCorruptError extends AuthError {
  readonly quarantinedPath: string;
  constructor(quarantinedPath: string, cause?: unknown) {
    super({
      code: "CREDENTIAL_STORE_CORRUPT",
      message: "credential store is corrupt and was quarantined — contents not logged; re-authenticate to rebuild",
      retryable: false,
      cause,
    });
    this.quarantinedPath = quarantinedPath;
  }
}

export class CredentialPermissionError extends AuthError {
  constructor(path: string, cause?: unknown) {
    super({
      code: "CREDENTIAL_PERMISSION",
      message: `credential store at '${path}' has unsafe filesystem permissions`,
      retryable: false,
      cause,
    });
  }
}

export class OAuthStateMismatchError extends AuthError {
  constructor() {
    super({
      code: "OAUTH_STATE_MISMATCH",
      message: "OAuth state validation failed — flow rejected, nothing stored",
      retryable: false,
    });
  }
}

export class OAuthExchangeError extends AuthError {
  constructor(status: number, safeDetail: string) {
    super({
      code: "OAUTH_EXCHANGE_FAILED",
      message: `OpenRouter code exchange failed (HTTP ${status}): ${safeDetail}`,
      retryable: status >= 500 || status === 429,
      cause: undefined,
    });
  }
}

export class OAuthCallbackTimeoutError extends AuthError {
  constructor(timeoutMs: number) {
    super({
      code: "OAUTH_CALLBACK_TIMEOUT",
      message: `OAuth callback was not received within ${Math.round(timeoutMs / 1000)}s — nothing stored`,
      retryable: false,
    });
  }
}
