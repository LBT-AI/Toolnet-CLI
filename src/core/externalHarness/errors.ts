/**
 * Phase 83 §22 — Structured external-harness errors.
 *
 * Every error carries `code`, `harnessId`, `retryable`, and a secret-free
 * `safeMessage` (no env values, no argv prompt content, no raw stderr dumps —
 * callers may include the bounded redacted tail via detail).
 */

export type HarnessErrorCode =
  | "HARNESS_NOT_FOUND"
  | "HARNESS_UNAVAILABLE"
  | "HARNESS_CAPABILITY"
  | "HARNESS_SPAWN"
  | "HARNESS_PROTOCOL"
  | "HARNESS_TIMEOUT"
  | "HARNESS_CANCELLED"
  | "HARNESS_EXIT";

export class HarnessError extends Error {
  readonly code: HarnessErrorCode;
  readonly harnessId?: string;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(
    code: HarnessErrorCode,
    message: string,
    options: { harnessId?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.harnessId = options.harnessId;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
  }
}

/** The harness id is not registered. */
export class HarnessNotFoundError extends HarnessError {
  constructor(harnessId: string) {
    super("HARNESS_NOT_FOUND", `Harness '${harnessId}' is not registered. Known: use 'toolnet harness external list'.`, {
      harnessId,
      retryable: false,
    });
  }
}

/** Registered but the executable is missing/broken on this machine. */
export class HarnessUnavailableError extends HarnessError {
  constructor(harnessId: string, detail?: string) {
    super("HARNESS_UNAVAILABLE", `Harness '${harnessId}' is not available on this machine.${detail ? ` ${detail}` : ""}`, {
      harnessId,
      retryable: true,
    });
  }
}

/** The harness does not support a requested feature (model override, resume, …). */
export class HarnessCapabilityError extends HarnessError {
  constructor(harnessId: string, capability: string) {
    super("HARNESS_CAPABILITY", `Harness '${harnessId}' does not support '${capability}'.`, {
      harnessId,
      retryable: false,
    });
  }
}

/** The process could not be spawned (ENOENT, EACCES, …). */
export class HarnessSpawnError extends HarnessError {
  constructor(harnessId: string, detail: string, cause?: unknown) {
    super("HARNESS_SPAWN", `Failed to spawn harness '${harnessId}': ${detail}`, {
      harnessId,
      retryable: true,
      cause,
    });
  }
}

/** Structured output was expected but was missing/malformed. */
export class HarnessProtocolError extends HarnessError {
  constructor(harnessId: string, detail: string, cause?: unknown) {
    super("HARNESS_PROTOCOL", `Harness '${harnessId}' produced invalid structured output: ${detail}`, {
      harnessId,
      retryable: false,
      cause,
    });
  }
}

/** The run exceeded its timeout and was killed. */
export class HarnessTimeoutError extends HarnessError {
  constructor(harnessId: string, timeoutMs: number) {
    super("HARNESS_TIMEOUT", `Harness '${harnessId}' timed out after ${timeoutMs}ms.`, {
      harnessId,
      retryable: true,
    });
  }
}

/** The caller aborted the run. */
export class HarnessCancelledError extends HarnessError {
  constructor(harnessId: string) {
    super("HARNESS_CANCELLED", `Harness '${harnessId}' run was cancelled.`, { harnessId, retryable: false });
  }
}

/** The process exited with a nonzero code without a structured failure. */
export class HarnessExitError extends HarnessError {
  constructor(harnessId: string, exitCode: number, detail?: string) {
    super("HARNESS_EXIT", `Harness '${harnessId}' exited with code ${exitCode}.${detail ? ` ${detail}` : ""}`, {
      harnessId,
      retryable: false,
    });
  }
}
