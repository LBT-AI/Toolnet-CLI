/**
 * — THE AuthProfileRegistry.
 *
 * Exactly one. Owns profile METADATA (identity, type, timestamps) and the
 * per-provider ACTIVE profile pointer. It never returns a secret: credential
 * payloads live in the CredentialStore, and secret access goes exclusively
 * through the CredentialResolver.
 *
 * Persistence rides on the canonical AppConfig ( separation): profiles and
 * active pointers are config, not secrets. Backward compatible — an absent
 * `auth` section behaves as "no profiles yet".
 *
 * Invariants enforced here:
 *  - profile ids are validated (`provider/name`, safe charset);
 *  - a profile references a credential that exists in the store at write time
 *    (env profiles are the exception — they reference the environment);
 *  - removing a profile clears the active pointer if it pointed at it, so no
 * stale pointer survives a logout ( defect: "logout active profile
 *    leaves stale pointer");
 * - switching the active profile never deletes another credential ().
 */

import { getAppConfig, updateAppConfig, type AppAuthSettings, type AppConfig } from "../../lib/appConfig";
import { credentialStore, type CredentialStore } from "./credentialStore";
import {
  AuthProfileNotFoundError,
  AuthProfileValidationError,
  makeProfileId,
  parseProfileId,
  validateProviderSegment,
} from "./errors";
import type { AuthProfile, CredentialType } from "./types";

export const DEFAULT_AUTH_SETTINGS: AppAuthSettings = {
  profiles: {},
  active: {},
};

export interface AuthProfileRegistryOptions {
  /** Store override (tests). Defaults to the canonical singleton. */
  store?: CredentialStore;
}

export class AuthProfileRegistry {
  private readonly store: CredentialStore;

  constructor(options: AuthProfileRegistryOptions = {}) {
    this.store = options.store ?? credentialStore;
  }

  private settings(): AppAuthSettings {
    const config = getAppConfig();
    return config.auth ?? { profiles: {}, active: {} };
  }

  /** List profiles, optionally filtered by provider. Secret-free. */
  list(providerId?: string): AuthProfile[] {
    const { profiles } = this.settings();
    const all = Object.values(profiles);
    const filtered = providerId
      ? all.filter((profile) => profile.providerId === providerId.trim().toLowerCase())
      : all;
    return filtered
      .map((profile) => ({ ...profile, metadata: profile.metadata ? { ...profile.metadata } : undefined }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Get one profile's metadata. Secret-free. Throws when unknown. */
  get(profileId: string): AuthProfile {
    const { profiles } = this.settings();
    const profile = profiles[profileId.trim()];
    if (!profile) throw new AuthProfileNotFoundError(profileId.trim());
    return { ...profile, metadata: profile.metadata ? { ...profile.metadata } : undefined };
  }

  has(profileId: string): boolean {
    try {
      const { providerId, name } = parseProfileId(profileId);
      return Boolean(this.settings().profiles[`${providerId}/${name}`]);
    } catch {
      return false;
    }
  }

  /**
   * Register a profile. `type` must match the credential that will exist in
   * the store (or `"env"` for environment-backed profiles). Idempotent on
   * re-add with the same type; conflicting types are rejected loudly.
   */
  register(input: {
    providerId: string;
    name: string;
    displayName?: string;
    type: CredentialType;
    metadata?: Record<string, string>;
  }): AuthProfile {
    const id = makeProfileId(input.providerId, input.name);
    const providerId = validateProviderSegment(input.providerId);
    const now = Date.now();
    const existing = this.settings().profiles[id];
    if (existing && existing.type !== input.type) {
      throw new AuthProfileValidationError(
        `profile '${id}' already exists with type '${existing.type}' — cannot re-register as '${input.type}'`,
        id,
      );
    }
    const profile: AuthProfile = {
      id,
      providerId,
      displayName: input.displayName?.trim() || input.name,
      type: input.type,
      ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    // Env profiles need no store entry; secret-bearing types must exist there.
    if (input.type !== "env" && !this.store.has(id)) {
      throw new AuthProfileValidationError(
        `cannot register profile '${id}': no credential stored for it yet (store the credential first)`,
        id,
      );
    }

    const current = this.settings();
    updateAppConfig({
      auth: {
        profiles: { ...current.profiles, [id]: profile },
        active: current.active,
      },
    });
    return { ...profile };
  }

 /** — switching profiles never deletes other credentials. */
  setActive(providerId: string, profileId: string): void {
    const id = profileId.trim();
    if (!this.has(id)) throw new AuthProfileNotFoundError(id);
    const provider = validateProviderSegment(providerId);
    if (!id.startsWith(`${provider}/`)) {
      throw new AuthProfileValidationError(
        `profile '${id}' does not belong to provider '${provider}'`,
        id,
      );
    }
    const current = this.settings();
    updateAppConfig({
      auth: {
        profiles: current.profiles,
        active: { ...current.active, [provider]: id },
      },
    });
  }

  /** Active profile for a provider, or undefined when none is set. */
  getActive(providerId: string): AuthProfile | undefined {
    const provider = validateProviderSegment(providerId);
    const id = this.settings().active[provider];
    if (!id) return undefined;
    const { profiles } = this.settings();
    const profile = profiles[id];
    if (!profile) return undefined; // stale pointer treated as absent
    return { ...profile };
  }

  /** Clear the active pointer for a provider (logout of the active profile). */
  clearActive(providerId: string): boolean {
    const provider = validateProviderSegment(providerId);
    const current = this.settings();
    if (!(provider in current.active)) return false;
    const active = { ...current.active };
    delete active[provider];
    updateAppConfig({ auth: { profiles: current.profiles, active } });
    return true;
  }

  /**
 * — remove profile metadata. `removeCredential` also deletes the stored
   * secret. Clearing the active pointer when the removed profile was active is
 * handled here so no stale pointer ever survives ().
   */
  async remove(profileId: string, options: { removeCredential?: boolean } = {}): Promise<boolean> {
    const id = profileId.trim();
    const parsed = parseProfileId(id);
    const { profiles, active } = this.settings();
    if (!profiles[id]) throw new AuthProfileNotFoundError(id);
    const nextProfiles = { ...profiles };
    delete nextProfiles[id];
    const nextActive = { ...active };
    if (nextActive[parsed.providerId] === id) delete nextActive[parsed.providerId];
    updateAppConfig({ auth: { profiles: nextProfiles, active: nextActive } } as Partial<AppConfig>);
    if (options.removeCredential) {
      await this.store.remove(id);
    }
    return true;
  }
}

/** Process-wide canonical registry. */
export const authProfileRegistry = new AuthProfileRegistry();
