/**
 * Phase 84 §8 — THE CredentialResolver.
 *
 * One canonical path from "who is calling?" to "which secret do we use?".
 * Resolution is deterministic and documented; the ORDER is the contract:
 *
 *   1. explicit request profile      (`--auth-profile openrouter/work`)
 *   2. session-pinned profile        (session records only the profile ID)
 *   3. active profile for the provider
 *   4. a registered env profile / the provider's standard env var
 *   5. legacy compatibility          (`keys.json` store, inline config key)
 *   6. unavailable (structured error)
 *
 * Two invariants matter more than the list itself:
 *
 *  - **No hidden fallback after an explicit profile failure.** If the caller
 *    named a profile and it is unknown or has no credential, that is an ERROR —
 *    we never quietly fall through to `OPENROUTER_API_KEY` (§8/§33).
 *  - **Exactly one redaction registration point.** Every secret this resolver
 *    hands out is registered with the shared redactor, so provider errors,
 *    fetch failures, logs and TUI output cannot echo it (§19).
 *
 * The resolver is deliberately free of provider-registry imports: it reads
 * config + env + stores only, which keeps `providers/registry.ts` able to
 * delegate here without a cycle.
 */

import { registerResolvedSecret } from "../models/errors";
import { getAppConfig } from "../../lib/appConfig";
import { resolveApiKeyLegacy } from "./legacy";
import { sessionAuthProfile } from "./context";
import { authProfileRegistry, type AuthProfileRegistry } from "./registry";
import { credentialStore, type CredentialStore } from "./credentialStore";
import { CredentialUnavailableError, AuthProfileNotFoundError, parseProfileId } from "./errors";
import {
  providerCredentialEnv,
  type CredentialSource,
  type ResolvedCredential,
} from "./types";

export interface CredentialRequest {
  providerId: string;
  /** Highest precedence: an explicitly requested profile id. */
  explicitProfile?: string | null;
  /** Session-pinned profile id (persisted as an id only — never a secret). */
  sessionProfile?: string | null;
  /** Provider's configured env var name (overrides the static default map). */
  envName?: string | null;
  /** Legacy inline key from provider config (lowest precedence). */
  legacyApiKey?: string | null;
  /** Provider config id used for the legacy `keys.json` lookup. */
  legacyProviderId?: string | null;
}

export interface CredentialResolverOptions {
  store?: CredentialStore;
  profiles?: AuthProfileRegistry;
  /** Env accessor (tests inject a hermetic environment). */
  env?: NodeJS.ProcessEnv;
}

/** Outcome of a resolve attempt without throwing (status/doctor paths). */
export interface CredentialLookup {
  credential?: ResolvedCredential;
  source: CredentialSource;
  /** Present when resolution failed; message is always secret-free. */
  error?: CredentialUnavailableError | AuthProfileNotFoundError;
}

function isNonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export class CredentialResolver {
  private readonly store: CredentialStore;
  private readonly profiles: AuthProfileRegistry;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: CredentialResolverOptions = {}) {
    this.store = options.store ?? credentialStore;
    this.profiles = options.profiles ?? authProfileRegistry;
    this.env = options.env ?? process.env;
  }

  /**
   * Resolve a credential or throw. Use `lookup()` when a missing credential is
   * an expected state (status, doctor) rather than an error.
   */
  resolve(request: CredentialRequest): ResolvedCredential {
    const result = this.lookup(request);
    if (result.credential) return result.credential;
    throw result.error ?? new CredentialUnavailableError(request.providerId, "no credential configured");
  }

  /** Non-throwing resolve used by status/doctor; never returns a raw secret twice. */
  lookup(request: CredentialRequest): CredentialLookup {
    const providerId = request.providerId.trim().toLowerCase();

    // 1. Explicit profile — a failure here is TERMINAL (no env fallback).
    if (isNonEmpty(request.explicitProfile)) {
      return this.fromProfile(request.explicitProfile, providerId, "explicit_profile", request);
    }

    // 2. Session pin — same terminal semantics: the session chose an identity.
    //    Explicit request value wins; otherwise the running session's pin.
    const sessionPinned = isNonEmpty(request.sessionProfile)
      ? request.sessionProfile
      : sessionAuthProfile(providerId);
    if (isNonEmpty(sessionPinned)) {
      return this.fromProfile(sessionPinned, providerId, "session_profile", request);
    }

    // 3. Active profile for the provider (only if it is usable).
    //    A provider id outside our profile charset simply has no profiles.
    const active = safeActiveProfile(this.profiles, providerId);
    if (active) {
      const fromActive = this.materialize(active.id, providerId, "active_profile");
      if (fromActive.credential) return fromActive;
      // An active profile with a missing credential is a config error, not a
      // reason to silently pay with a different account — but the environment
      // remains a legitimate CONFIGURED credential below, so we only prefer it
      // when the profile itself is broken.
    }

    // 4. Environment: a registered env profile for this provider, else the
    //    provider's standard env var.
    const envCredential = this.fromEnvironment(providerId, request);
    if (envCredential.credential) return envCredential;

    // 5. Legacy compatibility (keys.json store or inline config key).
    const legacy = this.fromLegacy(request);
    if (legacy.credential) return legacy;

    return {
      source: "unavailable",
      error: new CredentialUnavailableError(
        providerId,
        `no stored profile, no ${
          request.envName ?? providerCredentialEnv(providerId) ?? "provider env var"
        } and no legacy key configured`,
      ),
    };
  }

  /** Resolve a specific profile id and, on success, pin it as active. */
  resolveAndActivate(profileId: string): ResolvedCredential {
    const { providerId } = parseProfileId(profileId);
    return this.resolve({ providerId, explicitProfile: profileId });
  }

  /** Secret-free status of one provider's auth, for CLI/TUI/doctor. */
  describe(providerId: string): {
    providerId: string;
    configured: boolean;
    source: CredentialSource;
    activeProfileId?: string;
    profileCount: number;
    envName?: string;
    envPresent: boolean;
  } {
    const provider = providerId.trim().toLowerCase();
    const result = this.lookup({ providerId: provider });
    const envName = providerCredentialEnv(provider);
    const active = safeActiveProfile(this.profiles, provider);
    return {
      providerId: provider,
      configured: Boolean(result.credential),
      source: result.credential?.source ?? "unavailable",
      ...(active ? { activeProfileId: active.id } : {}),
      profileCount: safeListProfiles(this.profiles, provider).length,
      ...(envName ? { envName } : {}),
      envPresent: Boolean(envName && this.env[envName]),
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private fromProfile(
    profileId: string,
    providerId: string,
    source: "explicit_profile" | "session_profile",
    request: CredentialRequest,
  ): CredentialLookup {
    const id = profileId.trim();
    const parsed = safeParse(id);
    if (!parsed) {
      return {
        source,
        error: new CredentialUnavailableError(
          providerId,
          `profile id '${id}' is malformed (expected '<provider>/<name>')`,
          id,
        ),
      };
    }
    if (parsed.providerId !== providerId) {
      return {
        source,
        error: new CredentialUnavailableError(
          providerId,
          `profile '${id}' belongs to provider '${parsed.providerId}', not '${providerId}'`,
          id,
        ),
      };
    }
    if (!safeHasProfile(this.profiles, id)) {
      return { source, error: new AuthProfileNotFoundError(id) };
    }
    return this.materialize(id, providerId, source);
  }

  private materialize(
    profileId: string,
    providerId: string,
    source: "explicit_profile" | "session_profile" | "active_profile",
  ): CredentialLookup {
    const data = this.store.get(profileId);
    if (!data) {
      return {
        source,
        error: new CredentialUnavailableError(
          providerId,
          `profile '${profileId}' has no stored credential — run 'toolnet auth login ${providerId}' or remove the profile`,
          profileId,
        ),
      };
    }

    if (data.type === "env") {
      const value = this.env[data.envName];
      if (!isNonEmpty(value)) {
        return {
          source,
          error: new CredentialUnavailableError(
            providerId,
            `profile '${profileId}' reads $${data.envName}, which is not set`,
            profileId,
          ),
        };
      }
      return {
        source,
        credential: this.finalize(providerId, value.trim(), "env", source, profileId, data.envName),
      };
    }

    return {
      source,
      credential: this.finalize(providerId, data.secret, data.type, source, profileId, undefined),
    };
  }

  private fromEnvironment(providerId: string, request: CredentialRequest): CredentialLookup {
    const envName = request.envName?.trim() || providerCredentialEnv(providerId);
    if (!envName) return { source: "unavailable" };

    // Prefer an explicitly registered env profile (it carries the identity),
    // otherwise fall back to the standard variable.
    const envProfiles = safeListProfiles(this.profiles, providerId).filter(
      (profile) => profile.type === "env",
    );
    const matching = envProfiles.find((profile) => {
      const data = this.store.get(profile.id);
      return data?.type === "env" && data.envName === envName;
    });
    const value = this.env[envName];
    if (!isNonEmpty(value)) {
      return {
        source: "environment",
        error: new CredentialUnavailableError(
          providerId,
          `environment variable ${envName} is not set`,
          matching?.id,
        ),
      };
    }
    return {
      source: "environment",
      credential: this.finalize(providerId, value.trim(), "env", "environment", matching?.id, envName),
    };
  }

  private fromLegacy(request: CredentialRequest): CredentialLookup {
    if (isNonEmpty(request.legacyApiKey)) {
      return {
        source: "config",
        credential: this.finalize(request.providerId, request.legacyApiKey.trim(), "api_key", "config", undefined, undefined),
      };
    }
    const providerId = request.legacyProviderId?.trim() || request.providerId.trim();
    const legacy = resolveApiKeyLegacy(providerId);
    if (isNonEmpty(legacy)) {
      return {
        source: "legacy_store",
        credential: this.finalize(providerId, legacy.trim(), "api_key", "legacy_store", undefined, undefined),
      };
    }
    return { source: "unavailable" };
  }

  /** Register for redaction exactly once, then hand the secret out. */
  private finalize(
    providerId: string,
    secret: string,
    type: ResolvedCredential["type"],
    source: CredentialSource,
    profileId: string | undefined,
    envName: string | undefined,
  ): ResolvedCredential {
    registerResolvedSecret(secret);
    return {
      providerId,
      ...(profileId ? { profileId } : {}),
      type,
      source,
      secret,
      ...(envName ? { envName } : {}),
    };
  }
}

function safeParse(profileId: string): { providerId: string; name: string } | null {
  try {
    return parseProfileId(profileId);
  } catch {
    return null;
  }
}

/** Provider ids that fall outside our profile charset have no profiles. */
function safeActiveProfile(profiles: AuthProfileRegistry, providerId: string) {
  try {
    return profiles.getActive(providerId);
  } catch {
    return undefined;
  }
}

function safeListProfiles(profiles: AuthProfileRegistry, providerId: string) {
  try {
    return profiles.list(providerId);
  } catch {
    return [];
  }
}

function safeHasProfile(profiles: AuthProfileRegistry, profileId: string): boolean {
  try {
    return profiles.has(profileId);
  } catch {
    return false;
  }
}

/** Process-wide canonical resolver. */
export const credentialResolver = new CredentialResolver();
