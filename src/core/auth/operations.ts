/**
 * Phase 84 §14/§20/§22 — shared auth operations.
 *
 * CLI and TUI both call these; neither reaches into the store or the registry
 * directly (§31 architecture guard). Every function returns secret-free data —
 * status objects carry `source`, `configured` and ids, never key material.
 */

import { credentialStore, type CredentialStore } from "./credentialStore";
import { authProfileRegistry, type AuthProfileRegistry } from "./registry";
import { credentialResolver, type CredentialResolver } from "./resolver";
import { AuthProfileValidationError, makeProfileId, parseProfileId } from "./errors";
import { providerCredentialEnv, type AuthProfile, type AuthStatusKind } from "./types";

/** §22 — status is derived, never asserted from the mere existence of a value. */
export function statusKindFor(input: {
  configured: boolean;
  source: string;
  envPresent: boolean;
}): AuthStatusKind {
  if (input.configured) {
    return input.source === "environment" ? "environment" : "configured";
  }
  return input.envPresent ? "environment" : "needs_auth";
}

export interface AuthProviderView {
  providerId: string;
  status: AuthStatusKind;
  source: string;
  configured: boolean;
  activeProfileId?: string;
  profileCount: number;
  envName?: string;
  envPresent: boolean;
  profiles: AuthProfile[];
}

export interface AuthOperationsOptions {
  store?: CredentialStore;
  profiles?: AuthProfileRegistry;
  resolver?: CredentialResolver;
  env?: NodeJS.ProcessEnv;
}

export class AuthOperations {
  private readonly store: CredentialStore;
  private readonly profiles: AuthProfileRegistry;
  private readonly resolver: CredentialResolver;

  constructor(options: AuthOperationsOptions = {}) {
    this.store = options.store ?? credentialStore;
    this.profiles = options.profiles ?? authProfileRegistry;
    this.resolver = options.resolver ?? credentialResolver;
  }

  /** §14/§20 — list every configured provider with its profiles. */
  list(providerIds?: string[]): AuthProviderView[] {
    const ids = providerIds && providerIds.length > 0 ? providerIds : this.discoverProviders();
    return ids
      .map((providerId) => this.view(providerId))
      .sort((a, b) => a.providerId.localeCompare(b.providerId));
  }

  /** One provider's auth view. */
  view(providerId: string): AuthProviderView {
    const info = this.resolver.describe(providerId);
    return {
      providerId: info.providerId,
      status: statusKindFor({
        configured: info.configured,
        source: info.source,
        envPresent: info.envPresent,
      }),
      source: info.source,
      configured: info.configured,
      ...(info.activeProfileId ? { activeProfileId: info.activeProfileId } : {}),
      profileCount: info.profileCount,
      ...(info.envName ? { envName: info.envName } : {}),
      envPresent: info.envPresent,
      profiles: safeProfiles(this.profiles, info.providerId),
    };
  }

  /**
   * §13 — add a manually entered API key. The secret never appears in argv;
   * callers prompt for it off-TTY.
   */
  async addApiKey(input: { providerId: string; name: string; secret: string; activate?: boolean }): Promise<AuthProfile> {
    const id = makeProfileId(input.providerId, input.name);
    const secret = input.secret.trim();
    if (!secret) throw new AuthProfileValidationError("API key must not be empty", id);
    await this.store.set(id, { type: "api_key", secret });
    const profile = this.profiles.register({
      providerId: input.providerId,
      name: input.name,
      displayName: input.name,
      type: "api_key",
      metadata: { source: "manual" },
    });
    if (input.activate !== false) this.profiles.setActive(profile.providerId, profile.id);
    return profile;
  }

  /**
   * Register an environment-backed profile. No secret is stored: the profile
   * simply names the variable to read, so `OPENROUTER_API_KEY` keeps working
   * without being copied into any file (§10/§27).
   */
  addEnv(input: { providerId: string; name: string; envName?: string; activate?: boolean }): AuthProfile {
    const id = makeProfileId(input.providerId, input.name);
    const envName = input.envName?.trim() || providerCredentialEnv(input.providerId);
    if (!envName) {
      throw new AuthProfileValidationError(
        `no environment variable declared for provider '${input.providerId}' — pass one explicitly`,
        id,
      );
    }
    // Metadata only; the resolver reads the variable at call time.
    const profile = this.profiles.register({
      providerId: input.providerId,
      name: input.name,
      displayName: input.name,
      type: "env",
      metadata: { envName },
    });
    if (input.activate !== false) this.profiles.setActive(profile.providerId, profile.id);
    return profile;
  }

  /** §14 — switch the active profile. Never touches another credential. */
  use(profileId: string): AuthProfile {
    const { providerId } = parseProfileId(profileId);
    const profile = this.profiles.get(profileId);
    // A profile must be usable before it becomes the active identity.
    this.resolver.lookup({ providerId, explicitProfile: profile.id });
    this.profiles.setActive(providerId, profile.id);
    return profile;
  }

  /**
   * §16 — log out: clear the active pointer but retain the credential so the
   * user can switch back without re-authenticating.
   */
  logout(profileId: string): { profileId: string; activeCleared: boolean } {
    const profile = this.profiles.get(profileId);
    const activeCleared = this.profiles.clearActive(profile.providerId);
    return { profileId: profile.id, activeCleared };
  }

  /** §16 — remove: delete metadata AND credential; requires auth next time. */
  async remove(profileId: string): Promise<{ profileId: string; credentialDeleted: boolean }> {
    const profile = this.profiles.get(profileId);
    const credentialDeleted = await this.store.remove(profile.id);
    await this.profiles.remove(profile.id);
    return { profileId: profile.id, credentialDeleted };
  }

  /** §20 — doctor: filesystem/permission/config checks, no billing, no secrets. */
  doctor(): {
    storePath: string;
    permissions: "ok" | "repaired" | "missing";
    quarantined: { quarantinedPath: string; reason: string; at: number } | null;
    providers: AuthProviderView[];
    envOnly: { providerId: string; envName: string }[];
  } {
    const quarantine = this.store.getQuarantine();
    const providers = this.list();
    return {
      storePath: this.store.getPath(),
      permissions: this.store.checkPermissions(),
      quarantined: quarantine
        ? { quarantinedPath: quarantine.quarantinedPath, reason: quarantine.reason, at: quarantine.at }
        : null,
      providers,
      envOnly: providers
        .filter((view) => view.source === "environment" && view.profileCount === 0)
        .map((view) => ({ providerId: view.providerId, envName: view.envName ?? "" }))
        .filter((entry) => entry.envName),
    };
  }

  /** Providers that already have profiles (plus openrouter as the default). */
  private discoverProviders(): string[] {
    const ids = new Set<string>(["openrouter"]);
    for (const profile of this.profiles.list()) ids.add(profile.providerId);
    for (const profileId of this.store.profileIds()) {
      try {
        ids.add(parseProfileId(profileId).providerId);
      } catch {
        /* ignore malformed ids left by an older version */
      }
    }
    return [...ids];
  }
}

/** Provider ids outside our profile charset simply have no profiles. */
function safeProfiles(profiles: AuthProfileRegistry, providerId: string): AuthProfile[] {
  try {
    return profiles.list(providerId);
  } catch {
    return [];
  }
}

/** Process-wide canonical operations facade. */
export const authOperations = new AuthOperations();
