/**
 * Phase 81 §5 — structured harness errors.
 *
 * A mistyped profile id must fail loudly: silently running a different
 * behavioural contract than the user asked for would make every eval and every
 * CLI invocation untrustworthy.
 */

export type HarnessErrorCode =
  | "HARNESS_PROFILE_NOT_FOUND"
  | "HARNESS_PROFILE_INVALID"
  | "HARNESS_PROFILE_DUPLICATE";

export class HarnessError extends Error {
  readonly code: HarnessErrorCode;
  readonly profileId?: string;
  readonly known?: string[];

  constructor(
    code: HarnessErrorCode,
    message: string,
    details: { profileId?: string; known?: string[] } = {},
  ) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
    this.profileId = details.profileId;
    this.known = details.known;
  }
}

export function harnessProfileNotFound(id: string, known: string[]): HarnessError {
  return new HarnessError(
    "HARNESS_PROFILE_NOT_FOUND",
    `Unknown harness profile '${id}'. Known profiles: ${known.join(", ")}.`,
    { profileId: id, known },
  );
}

export function harnessProfileInvalid(id: string, reason: string): HarnessError {
  return new HarnessError(
    "HARNESS_PROFILE_INVALID",
    `Invalid harness profile '${id}': ${reason}`,
    { profileId: id },
  );
}

export function harnessProfileDuplicate(id: string): HarnessError {
  return new HarnessError(
    "HARNESS_PROFILE_DUPLICATE",
    `Harness profile '${id}' is already registered. A profile is registered once.`,
    { profileId: id },
  );
}
