/**
 * Phase 81 §5 — the single HarnessRegistry.
 *
 * Exactly one registry exists in the process (`harnessRegistry`). It owns the
 * set of known harness profiles and is the only place a profile is looked up.
 * It holds no provider, no model and no loop.
 *
 * Validation is structural: registering a profile that is missing a policy
 * module, has an empty id, or duplicates an existing id fails deterministically
 * rather than producing a half-configured behavioural contract.
 */

import {
  harnessProfileDuplicate,
  harnessProfileInvalid,
} from "./errors";
import {
  BUILTIN_HARNESS_PROFILES,
  DEFAULT_HARNESS_PROFILE_ID,
} from "./profiles";
import {
  HARNESS_POLICY_NAMES,
  type HarnessProfile,
} from "./types";

function isValidProfile(profile: HarnessProfile): string | null {
  if (!profile || typeof profile !== "object") return "not an object";
  if (!profile.id || typeof profile.id !== "string") return "missing id";
  if (!profile.version || typeof profile.version !== "string") return "missing version";
  for (const policy of HARNESS_POLICY_NAMES) {
    const value = (profile as unknown as Record<string, unknown>)[policy];
    if (!value || typeof value !== "object") return `missing ${policy}`;
  }
  const continuation = profile.continuationPolicy;
  if (typeof continuation.maxRepeatedToolCalls !== "number") {
    return "continuationPolicy.maxRepeatedToolCalls must be a number";
  }
  if (typeof continuation.maxConsecutiveNoProgressTurns !== "number") {
    return "continuationPolicy.maxConsecutiveNoProgressTurns must be a number";
  }
  return null;
}

export class HarnessRegistry {
  private readonly profiles = new Map<string, HarnessProfile>();

  register(profile: HarnessProfile): boolean {
    const invalid = isValidProfile(profile);
    if (invalid) throw harnessProfileInvalid(profile?.id ?? "<unknown>", invalid);
    if (this.profiles.has(profile.id)) throw harnessProfileDuplicate(profile.id);
    this.profiles.set(profile.id, profile);
    return true;
  }

  /** Replace-or-add, for callers that own a profile's lifecycle (tests, plugins). */
  upsert(profile: HarnessProfile): void {
    const invalid = isValidProfile(profile);
    if (invalid) throw harnessProfileInvalid(profile?.id ?? "<unknown>", invalid);
    this.profiles.set(profile.id, profile);
  }

  unregister(id: string): boolean {
    return this.profiles.delete(id);
  }

  get(id: string): HarnessProfile | undefined {
    return this.profiles.get(id);
  }

  has(id: string): boolean {
    return this.profiles.has(id);
  }

  /** Registration order — deterministic for CLI/TUI listing. */
  list(): HarnessProfile[] {
    return [...this.profiles.values()];
  }

  ids(): string[] {
    return this.list().map((profile) => profile.id);
  }

  get defaultProfile(): HarnessProfile {
    return (
      this.profiles.get(DEFAULT_HARNESS_PROFILE_ID) ?? {
        ...BUILTIN_HARNESS_PROFILES[0],
      }
    );
  }
}

/** The one registry. Import this; do not construct a second one. */
export const harnessRegistry = new HarnessRegistry();
for (const profile of BUILTIN_HARNESS_PROFILES) {
  harnessRegistry.register(profile);
}
