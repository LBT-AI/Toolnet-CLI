/**
 * — CredentialResolver precedence + AuthProfileRegistry.
 *
 * Every test uses a temp config dir, a temp credential store and an injected
 * environment, so nothing touches the real user's credentials.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetAppConfigCache } from "../../../lib/appConfig";
import { CredentialStore } from "../credentialStore";
import { AuthProfileRegistry } from "../registry";
import { CredentialResolver } from "../resolver";
import { AuthProfileNotFoundError, AuthProfileValidationError, CredentialUnavailableError } from "../errors";
import { statusKindFor } from "../operations";
import { clearSessionAuthOverrides, pinSessionAuthProfile, resetSessionAuthBridge } from "../context";

let dir: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tn-auth-resolver-"));
  previousConfigDir = process.env.TOOLNETCLI_CONFIG_DIR;
  process.env.TOOLNETCLI_CONFIG_DIR = dir;
  resetAppConfigCache();
  clearSessionAuthOverrides();
  resetSessionAuthBridge();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (previousConfigDir === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR;
  else process.env.TOOLNETCLI_CONFIG_DIR = previousConfigDir;
  resetAppConfigCache();
  clearSessionAuthOverrides();
  resetSessionAuthBridge();
});

function harness() {
  const store = new CredentialStore({ filePath: path.join(dir, "creds.json"), onWarn: () => {} });
  const profiles = new AuthProfileRegistry({ store });
  return { store, profiles };
}

describe("AuthProfileRegistry — identity and active pointers", () => {
  test("validates profile ids and refuses path traversal", () => {
    const { profiles } = harness();
    expect(() => profiles.register({ providerId: "../evil", name: "x", type: "env" })).toThrow(
      AuthProfileValidationError,
    );
    expect(() => profiles.register({ providerId: "openrouter", name: "../x", type: "env" })).toThrow(
      AuthProfileValidationError,
    );
    expect(() => profiles.register({ providerId: "openrouter", name: "a/b", type: "env" })).toThrow(
      AuthProfileValidationError,
    );
    expect(() => profiles.register({ providerId: "openrouter", name: "with\nnewline", type: "env" })).toThrow(
      AuthProfileValidationError,
    );
    expect(() =>
      profiles.register({ providerId: "openrouter", name: "x".repeat(80), type: "env" }),
    ).toThrow(AuthProfileValidationError);
  });

  test("registers an env profile without storing any secret, and lists it", () => {
    const { profiles, store } = harness();
    const profile = profiles.register({ providerId: "openrouter", name: "fromenv", type: "env" });
    expect(profile.id).toBe("openrouter/fromenv");
    expect(store.profileIds()).toEqual([]);
    expect(profiles.list("openrouter").map((p) => p.id)).toEqual(["openrouter/fromenv"]);
  });

  test("refuses to register a secret-bearing profile with no stored credential", () => {
    const { profiles } = harness();
    expect(() =>
      profiles.register({ providerId: "openrouter", name: "work", type: "api_key" }),
    ).toThrow(AuthProfileValidationError);
  });

  test("switching the active profile never deletes another credential", async () => {
    const { profiles, store } = harness();
    await store.set("openrouter/work", { type: "api_key", secret: "wwwwwwwwwwwwwwww" });
    await store.set("openrouter/personal", { type: "api_key", secret: "pppppppppppppppp" });
    profiles.register({ providerId: "openrouter", name: "work", type: "api_key" });
    profiles.register({ providerId: "openrouter", name: "personal", type: "api_key" });
    profiles.setActive("openrouter", "openrouter/work");
    expect(profiles.getActive("openrouter")?.id).toBe("openrouter/work");
    profiles.setActive("openrouter", "openrouter/personal");
    expect(profiles.getActive("openrouter")?.id).toBe("openrouter/personal");
    expect(store.has("openrouter/work")).toBe(true);
    expect(store.has("openrouter/personal")).toBe(true);
  });

  test("removing the ACTIVE profile clears the stale pointer", async () => {
    const { profiles, store } = harness();
    await store.set("openrouter/work", { type: "api_key", secret: "wwwwwwwwwwwwwwww" });
    profiles.register({ providerId: "openrouter", name: "work", type: "api_key" });
    profiles.setActive("openrouter", "openrouter/work");
    await profiles.remove("openrouter/work", { removeCredential: true });
    expect(profiles.getActive("openrouter")).toBeUndefined();
    expect(store.has("openrouter/work")).toBe(false);
  });

  test("rejects setActive for a profile belonging to another provider", async () => {
    const { profiles, store } = harness();
    await store.set("openrouter/work", { type: "api_key", secret: "wwwwwwwwwwwwwwww" });
    profiles.register({ providerId: "openrouter", name: "work", type: "api_key" });
    expect(() => profiles.setActive("toolnet", "openrouter/work")).toThrow(AuthProfileValidationError);
  });
});

describe("CredentialResolver — deterministic precedence", () => {
  test("explicit profile wins over active profile and environment", async () => {
    const { profiles, store } = harness();
    await store.set("openrouter/explicit", { type: "api_key", secret: "explicit-secret-000001" });
    await store.set("openrouter/active", { type: "api_key", secret: "active-secret-0000002" });
    profiles.register({ providerId: "openrouter", name: "explicit", type: "api_key" });
    profiles.register({ providerId: "openrouter", name: "active", type: "api_key" });
    profiles.setActive("openrouter", "openrouter/active");

    const resolver = new CredentialResolver({ store, profiles, env: { OPENROUTER_API_KEY: "env-secret-000000000" } });
    const resolved = resolver.resolve({ providerId: "openrouter", explicitProfile: "openrouter/explicit" });
    expect(resolved.secret).toBe("explicit-secret-000001");
    expect(resolved.source).toBe("explicit_profile");
    expect(resolved.profileId).toBe("openrouter/explicit");
  });

  test("active profile wins over environment", async () => {
    const { profiles, store } = harness();
    await store.set("openrouter/active", { type: "api_key", secret: "active-secret-0000002" });
    profiles.register({ providerId: "openrouter", name: "active", type: "api_key" });
    profiles.setActive("openrouter", "openrouter/active");
    const resolver = new CredentialResolver({ store, profiles, env: { OPENROUTER_API_KEY: "env-secret-000000000" } });
    expect(resolver.resolve({ providerId: "openrouter" }).secret).toBe("active-secret-0000002");
    expect(resolver.resolve({ providerId: "openrouter" }).source).toBe("active_profile");
  });

  test("environment is used when no profile is configured (backward compatible)", () => {
    const { profiles, store } = harness();
    const resolver = new CredentialResolver({ store, profiles, env: { OPENROUTER_API_KEY: "env-secret-000000000" } });
    const resolved = resolver.resolve({ providerId: "openrouter" });
    expect(resolved.source).toBe("environment");
    expect(resolved.secret).toBe("env-secret-000000000");
    expect(resolved.envName).toBe("OPENROUTER_API_KEY");
  });

  test("an explicitly requested profile that has no credential is TERMINAL (no env fallback)", async () => {
    const { profiles, store } = harness();
    await store.set("openrouter/work", { type: "api_key", secret: "wwwwwwwwwwwwwwww" });
    profiles.register({ providerId: "openrouter", name: "work", type: "api_key" });
    const resolver = new CredentialResolver({ store, profiles, env: { OPENROUTER_API_KEY: "env-secret-000000000" } });
    expect(() =>
      resolver.resolve({ providerId: "openrouter", explicitProfile: "openrouter/missing" }),
    ).toThrow(AuthProfileNotFoundError);
  });

  test("an explicitly requested profile with no stored secret is TERMINAL", () => {
    const { profiles, store } = harness();
    profiles.register({ providerId: "openrouter", name: "env-only", type: "env" });
    const resolver = new CredentialResolver({ store, profiles, env: {} });
    // Env profile whose variable is unset: it exists, but is unusable — and we
    // must NOT silently spend from a different source.
    const result = resolver.lookup({ providerId: "openrouter", explicitProfile: "openrouter/env-only" });
    expect(result.credential).toBeUndefined();
    expect(result.error).toBeInstanceOf(CredentialUnavailableError);
  });

  test("an explicit profile for the wrong provider is rejected", () => {
    const { profiles, store } = harness();
    const resolver = new CredentialResolver({ store, profiles, env: {} });
    const result = resolver.lookup({ providerId: "openrouter", explicitProfile: "toolnet/default" });
    expect(result.credential).toBeUndefined();
    expect(result.error?.message).toContain("toolnet");
  });

  test("an env-backed profile reads the variable at call time", async () => {
    const { profiles, store } = harness();
    await store.set("openrouter/fromenv", { type: "env", envName: "MY_ROUTER_KEY" });
    profiles.register({ providerId: "openrouter", name: "fromenv", type: "env" });
    profiles.setActive("openrouter", "openrouter/fromenv");
    const env: NodeJS.ProcessEnv = { MY_ROUTER_KEY: "env-profile-secret-001" };
    const resolver = new CredentialResolver({ store, profiles, env });
    const resolved = resolver.resolve({ providerId: "openrouter" });
    expect(resolved.secret).toBe("env-profile-secret-001");
    expect(resolved.type).toBe("env");
    // Rotating the variable immediately changes the credential — nothing cached.
    env.MY_ROUTER_KEY = "env-profile-secret-002";
    expect(resolver.resolve({ providerId: "openrouter" }).secret).toBe("env-profile-secret-002");
  });

  test("legacy inline config and legacy key store remain usable", async () => {
    const { profiles, store } = harness();
    const resolver = new CredentialResolver({ store, profiles, env: {} });
    const inline = resolver.resolve({ providerId: "openrouter", legacyApiKey: "inline-legacy-key-01" });
    expect(inline.source).toBe("config");
    expect(inline.secret).toBe("inline-legacy-key-01");
  });

  test("session pin is honored and outranks the active profile", async () => {
    const { profiles, store } = harness();
    await store.set("openrouter/work", { type: "api_key", secret: "work-secret-000000001" });
    await store.set("openrouter/personal", { type: "api_key", secret: "personal-secret-00002" });
    profiles.register({ providerId: "openrouter", name: "work", type: "api_key" });
    profiles.register({ providerId: "openrouter", name: "personal", type: "api_key" });
    profiles.setActive("openrouter", "openrouter/work");

    const resolver = new CredentialResolver({ store, profiles, env: {} });
    expect(resolver.resolve({ providerId: "openrouter" }).secret).toBe("work-secret-000000001");

 // — the request's session identity pins the account.
    const pinned = resolver.resolve({ providerId: "openrouter", sessionProfile: "openrouter/personal" });
    expect(pinned.secret).toBe("personal-secret-00002");
    expect(pinned.source).toBe("session_profile");
  });

  test("describe() reports source and env presence without any secret", async () => {
    const { profiles, store } = harness();
    await store.set("openrouter/work", { type: "api_key", secret: "super-secret-value-001" });
    profiles.register({ providerId: "openrouter", name: "work", type: "api_key" });
    profiles.setActive("openrouter", "openrouter/work");
    const resolver = new CredentialResolver({
      store,
      profiles,
      env: { OPENROUTER_API_KEY: "env-secret-000000000" },
    });
    const info = resolver.describe("openrouter");
    expect(info.configured).toBe(true);
    expect(info.source).toBe("active_profile");
    expect(info.activeProfileId).toBe("openrouter/work");
    expect(info.envPresent).toBe(true);
    expect(JSON.stringify(info)).not.toContain("super-secret-value-001");
    expect(JSON.stringify(info)).not.toContain("env-secret");
  });

  test("a provider id outside the profile charset degrades to unavailable, never throws", () => {
    const { profiles, store } = harness();
    const resolver = new CredentialResolver({ store, profiles, env: {} });
    expect(() => resolver.resolve({ providerId: "Weird Provider!", envName: null })).toThrow(
      CredentialUnavailableError,
    );
  });
});

describe("AuthOperations — status vocabulary", () => {
  test("status is never 'valid' merely because a string exists", () => {
    expect(statusKindFor({ configured: false, source: "unavailable", envPresent: false })).toBe("needs_auth");
    expect(statusKindFor({ configured: false, source: "unavailable", envPresent: true })).toBe("environment");
    expect(statusKindFor({ configured: true, source: "environment", envPresent: true })).toBe("environment");
    expect(statusKindFor({ configured: true, source: "active_profile", envPresent: false })).toBe("configured");
  });

  test("removing a profile requires re-authentication on the next resolve", async () => {
    const { profiles, store } = harness();
    await store.set("openrouter/work", { type: "api_key", secret: "work-secret-000000001" });
    profiles.register({ providerId: "openrouter", name: "work", type: "api_key" });
    profiles.setActive("openrouter", "openrouter/work");
    await profiles.remove("openrouter/work", { removeCredential: true });
    const resolver = new CredentialResolver({ store, profiles, env: {} });
    expect(resolver.lookup({ providerId: "openrouter" }).credential).toBeUndefined();
    expect(profiles.getActive("openrouter")).toBeUndefined();
  });

  test("session pin via context is consulted by the resolver", async () => {
    const { profiles, store } = harness();
    await store.set("openrouter/pinned", { type: "api_key", secret: "pinned-secret-0000001" });
    profiles.register({ providerId: "openrouter", name: "pinned", type: "api_key" });
    pinSessionAuthProfile("openrouter", "openrouter/pinned");
    const resolver = new CredentialResolver({ store, profiles, env: {} });
    expect(resolver.resolve({ providerId: "openrouter" }).source).toBe("session_profile");
    expect(resolver.resolve({ providerId: "openrouter" }).secret).toBe("pinned-secret-0000001");
  });
});
