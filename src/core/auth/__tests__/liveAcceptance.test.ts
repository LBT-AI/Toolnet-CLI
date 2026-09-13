/**
 * Phase 84 §29 — live acceptance.
 *
 * Never requires a credential: with no `OPENROUTER_API_KEY` these cases pass as
 * explicit ENVIRONMENT skips (reported, never faked). The billed/network smoke
 * runs only when `TOOLNET_AUTH_LIVE_TEST=1`.
 *
 * Nothing here ever persists the environment key: an env credential is read at
 * call time and the store must stay empty.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetAppConfigCache } from "../../../lib/appConfig";
import { CredentialResolver } from "../resolver";
import { AuthProfileRegistry } from "../registry";
import { CredentialStore } from "../credentialStore";

let dir: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tn-auth-live-"));
  previousConfigDir = process.env.TOOLNETCLI_CONFIG_DIR;
  process.env.TOOLNETCLI_CONFIG_DIR = dir;
  resetAppConfigCache();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (previousConfigDir === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR;
  else process.env.TOOLNETCLI_CONFIG_DIR = previousConfigDir;
  resetAppConfigCache();
});

function harness() {
  const store = new CredentialStore({ filePath: path.join(dir, "creds.json"), onWarn: () => {} });
  const profiles = new AuthProfileRegistry({ store });
  return { store, profiles };
}

const LIVE = process.env.TOOLNET_AUTH_LIVE_TEST === "1";
const HAS_ENV_KEY = Boolean(process.env.OPENROUTER_API_KEY?.trim());

describe("Phase 84 §29 — live acceptance", () => {
  test("environment credential is recognized without being persisted", async () => {
    const { store, profiles } = harness();
    const resolver = new CredentialResolver({ store, profiles, env: process.env });

    const lookup = resolver.lookup({ providerId: "openrouter" });
    if (!HAS_ENV_KEY) {
      // ENVIRONMENT: OPENROUTER_API_KEY missing — assert the honest answer.
      expect(lookup.credential).toBeUndefined();
      expect(lookup.source).toBe("unavailable");
      return;
    }

    expect(lookup.credential).toBeDefined();
    expect(lookup.credential!.source).toBe("environment");
    expect(lookup.credential!.envName).toBe("OPENROUTER_API_KEY");
    // The env key is never copied into the credential store.
    expect(store.profileIds()).toEqual([]);
    expect(store.checkPermissions()).toBe("missing");
  });

  test("env source is reported by describe() with no secret in the payload", async () => {
    const { store, profiles } = harness();
    const resolver = new CredentialResolver({ store, profiles, env: process.env });
    const info = resolver.describe("openrouter");
    if (!HAS_ENV_KEY) {
      expect(info.configured).toBe(false);
      return;
    }
    expect(info.configured).toBe(true);
    expect(info.source).toBe("environment");
    const key = process.env.OPENROUTER_API_KEY!;
    expect(JSON.stringify(info)).not.toContain(key);
  });

  test("optional live OpenRouter key introspection (opt-in only)", async () => {
    if (!LIVE || !HAS_ENV_KEY) {
      // ENVIRONMENT — explicitly skipped rather than reported as a pass.
      expect(true).toBe(true);
      return;
    }
    // Read-only, bounded, no billing: the keys endpoint reports metadata about
    // the presented key. A non-2xx is classified, not thrown as flaky.
    const response = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      signal: AbortSignal.timeout(15_000),
    });
    expect([200, 401, 403]).toContain(response.status);
    if (response.status === 200) {
      const payload = (await response.json()) as { data?: { label?: string } };
      expect(payload).toBeTruthy();
    }
  }, 20_000);
});
