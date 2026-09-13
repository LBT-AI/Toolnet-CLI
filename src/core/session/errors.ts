/**
 * Structured session errors.
 *
 * Every failure a session operation can produce carries a stable `code`, the
 * session it concerns, whether retrying could help, and a message safe to show
 * a user or write to a log. None of them ever embeds file contents, transcript
 * text, or a credential.
 */

export type SessionErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_INVALID_ID"
  | "SESSION_LOCKED"
  | "SESSION_CORRUPT"
  | "SESSION_UNSUPPORTED_VERSION"
  | "SESSION_WORKSPACE_MISMATCH"
  | "SESSION_STORE_IO"
  | "SESSION_PARENT_MISSING"
  | "SESSION_DELETE_HAS_CHILDREN"
  | "SESSION_CREDENTIAL_UNAVAILABLE";

export class SessionError extends Error {
  readonly code: SessionErrorCode;
  readonly sessionId?: string;
  readonly retryable: boolean;

  constructor(
    code: SessionErrorCode,
    message: string,
    options: { sessionId?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "SessionError";
    this.code = code;
    this.sessionId = options.sessionId;
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export class SessionNotFoundError extends SessionError {
  constructor(sessionId: string) {
    super("SESSION_NOT_FOUND", `session not found: ${sessionId}`, { sessionId });
    this.name = "SessionNotFoundError";
  }
}

/**
 * A session id reaches the store from CLI arguments, so it is validated before
 * it ever becomes a path segment. An id that fails validation is a caller
 * error, never a filesystem surprise.
 */
export class SessionInvalidIdError extends SessionError {
  constructor(sessionId: string, reason: string) {
    super("SESSION_INVALID_ID", `invalid session id: ${reason}`, { sessionId });
    this.name = "SessionInvalidIdError";
  }
}

export class SessionLockedError extends SessionError {
  readonly heldByPid?: number;

  constructor(sessionId: string, heldByPid?: number) {
    super(
      "SESSION_LOCKED",
      `session is in use by another ToolNet process${heldByPid ? ` (pid ${heldByPid})` : ""}`,
      { sessionId, retryable: true },
    );
    this.name = "SessionLockedError";
    this.heldByPid = heldByPid;
  }
}

export class SessionCorruptError extends SessionError {
  readonly quarantinedPath?: string;

  constructor(sessionId: string, detail: string, quarantinedPath?: string) {
    super("SESSION_CORRUPT", `session data is unreadable: ${detail}`, { sessionId });
    this.name = "SessionCorruptError";
    this.quarantinedPath = quarantinedPath;
  }
}

export class SessionUnsupportedVersionError extends SessionError {
  constructor(sessionId: string, found: unknown, expected: number) {
    super(
      "SESSION_UNSUPPORTED_VERSION",
      `session schema version ${String(found)} is not supported (expected ${expected})`,
      { sessionId },
    );
    this.name = "SessionUnsupportedVersionError";
  }
}

export class SessionWorkspaceMismatchError extends SessionError {
  readonly storedPath: string;
  readonly currentPath: string;

  constructor(sessionId: string, storedPath: string, currentPath: string) {
    super(
      "SESSION_WORKSPACE_MISMATCH",
      "session belongs to a different project — refusing to resume it here",
      { sessionId },
    );
    this.name = "SessionWorkspaceMismatchError";
    this.storedPath = storedPath;
    this.currentPath = currentPath;
  }
}

export class SessionStoreIoError extends SessionError {
  constructor(sessionId: string, detail: string, cause?: unknown) {
    super("SESSION_STORE_IO", `session store i/o failed: ${detail}`, {
      sessionId,
      retryable: true,
      cause,
    });
    this.name = "SessionStoreIoError";
  }
}

/**
 * Raised when a fork or delete would touch sessions that still exist. Deleting a
 * parent is never a silent cascade: the caller must ask for it explicitly.
 */
export class SessionHasChildrenError extends SessionError {
  readonly children: string[];

  constructor(sessionId: string, children: string[]) {
    super(
      "SESSION_DELETE_HAS_CHILDREN",
      `session has ${children.length} forked session(s); pass cascade to delete them`,
      { sessionId },
    );
    this.name = "SessionHasChildrenError";
    this.children = children;
  }
}

/**
 * The session pinned an auth profile that no longer resolves. This is terminal
 * by design: falling back to another account would silently spend money from an
 * identity the user did not choose.
 */
export class SessionCredentialUnavailableError extends SessionError {
  readonly providerId: string;
  readonly profileId: string;

  constructor(sessionId: string, providerId: string, profileId: string, detail: string) {
    super(
      "SESSION_CREDENTIAL_UNAVAILABLE",
      `session pinned auth profile '${profileId}' for provider '${providerId}' is unavailable: ${detail}`,
      { sessionId },
    );
    this.name = "SessionCredentialUnavailableError";
    this.providerId = providerId;
    this.profileId = profileId;
  }
}
