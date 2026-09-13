/**
 * — session auth pinning context.
 *
 * A running session must not silently change the account it spends from just
 * because a global `toolnet auth use` happened mid-request. This module holds
 * the per-session pin (`providerId -> profileId` — ids ONLY) and lets the
 * resolver consult it as the second-highest precedence step.
 *
 * The session layer pushes updates here; this module pulls the persisted map
 * lazily through `require` so there is no static import cycle between
 * `src/core/auth` and `src/lib/session`.
 */

type SessionProfileMap = Record<string, string>;

let sessionLoader: (() => SessionProfileMap) | null = null;
let sessionPinner: ((providerId: string, profileId: string | null) => void) | null = null;
const overrides = new Map<string, string>();

/** Wire the session layer in (called once from src/lib/session). */
export function setSessionAuthBridge(bridge: {
  load: () => SessionProfileMap;
  pin: (providerId: string, profileId: string | null) => void;
}): void {
  sessionLoader = bridge.load;
  sessionPinner = bridge.pin;
}

function loadPersisted(): SessionProfileMap {
  if (sessionLoader) {
    try {
      return sessionLoader() ?? {};
    } catch {
      return {};
    }
  }
  try {
    // Lazy require keeps core/auth free of a static session dependency.
    const mod = require("../../lib/session") as {
      getSessionAuthProfiles?: () => SessionProfileMap;
    };
    return mod.getSessionAuthProfiles?.() ?? {};
  } catch {
    return {};
  }
}

/** Pin a profile for THIS session (in-memory + persisted ids only). */
export function pinSessionAuthProfile(providerId: string, profileId: string | null): void {
  const provider = providerId.trim().toLowerCase();
  if (profileId) overrides.set(provider, profileId);
  else overrides.delete(provider);
  sessionPinner?.(provider, profileId);
}

/** The session pin for a provider, or null when the session pins nothing. */
export function sessionAuthProfile(providerId: string): string | null {
  const provider = providerId.trim().toLowerCase();
  const override = overrides.get(provider);
  if (override) return override;
  const persisted = loadPersisted()[provider];
  return persisted ?? null;
}

/** Test/reset helper — clears in-memory overrides (does not touch sessions). */
export function clearSessionAuthOverrides(): void {
  overrides.clear();
}

/** Test helper — detach the session bridge. */
export function resetSessionAuthBridge(): void {
  sessionLoader = null;
  sessionPinner = null;
  overrides.clear();
}
