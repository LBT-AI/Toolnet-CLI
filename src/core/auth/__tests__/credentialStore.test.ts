/**
 * — CredentialStore hardening tests.
 *
 * These run against the REAL filesystem in a temp directory: permissions are
 * asserted with `stat`, concurrency is exercised with genuinely overlapping
 * async mutations, and corruption is produced by writing garbage to disk.
 */

import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "../credentialStore";
import { CredentialStoreError } from "../errors";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tn-cred-store-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function storeAt(name = "auth-credentials.json") {
  return new CredentialStore({ filePath: path.join(dir, name), onWarn: () => {} });
}

describe("CredentialStore — persistence and permissions", () => {
  test("creates the file with mode 0600 and no world/group access", async () => {
    const store = storeAt();
    await store.set("openrouter/work", { type: "api_key", secret: "sk-test-abcdefghijklmnop" });
    const file = store.getPath();
    expect(fs.existsSync(file)).toBe(true);
    if (process.platform !== "win32") {
      const mode = fs.statSync(file).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    expect(store.checkPermissions()).toBe("ok");
  });

  test("re-asserts 0600 on every write and repairs a broadened file", async () => {
    const store = storeAt();
    await store.set("openrouter/a", { type: "api_key", secret: "secret-value-1234567890" });
    if (process.platform !== "win32") fs.chmodSync(store.getPath(), 0o644);
    await store.set("openrouter/b", { type: "api_key", secret: "secret-value-0987654321" });
    if (process.platform !== "win32") {
      expect(fs.statSync(store.getPath()).mode & 0o777).toBe(0o600);
    }
  });

  test("reads back typed credentials and reports types without secrets", async () => {
    const store = storeAt();
    await store.set("openrouter/work", { type: "api_key", secret: "sk-live-1234567890abcdef" });
    await store.set("toolnet/default", { type: "env", envName: "TOOLNET_API_KEY" });
    expect(store.get("openrouter/work")).toEqual({ type: "api_key", secret: "sk-live-1234567890abcdef" });
    expect(store.describe("openrouter/work")).toEqual({ type: "api_key" });
    expect(store.describe("toolnet/default")).toEqual({ type: "env" });
    expect(JSON.stringify(store.describe("openrouter/work"))).not.toContain("sk-live");
    expect(store.profileIds().sort()).toEqual(["openrouter/work", "toolnet/default"]);
  });

  test("updates and removes entries without touching siblings", async () => {
    const store = storeAt();
    await store.set("openrouter/a", { type: "api_key", secret: "aaaaaaaaaaaaaaaa" });
    await store.set("openrouter/b", { type: "api_key", secret: "bbbbbbbbbbbbbbbb" });
    await store.set("openrouter/a", { type: "api_key", secret: "aaaaaaaaaaaaaaa2" });
    expect(store.get("openrouter/a")).toEqual({ type: "api_key", secret: "aaaaaaaaaaaaaaa2" });
    expect(await store.remove("openrouter/a")).toBe(true);
    expect(await store.remove("openrouter/a")).toBe(false);
    expect(store.has("openrouter/b")).toBe(true);
  });

  test("leaves no temp files behind (atomic rename)", async () => {
    const store = storeAt();
    await store.set("openrouter/a", { type: "api_key", secret: "aaaaaaaaaaaaaaaa" });
    const leftovers = fs.readdirSync(dir).filter((entry) => entry.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  test("refuses to write through a symlink planted on the store path", async () => {
    if (process.platform === "win32") return;
    const target = path.join(dir, "real.json");
    fs.writeFileSync(target, JSON.stringify({ version: 1, credentials: {} }));
    const link = path.join(dir, "auth-credentials.json");
    fs.symlinkSync(target, link);
    const store = new CredentialStore({ filePath: link, onWarn: () => {} });
    await expect(store.set("openrouter/a", { type: "api_key", secret: "aaaaaaaaaaaaaaaa" })).rejects.toBeInstanceOf(
      CredentialStoreError,
    );
  });
});

describe("CredentialStore — concurrency", () => {
  test("two simultaneous writes both survive (no lost update)", async () => {
    const store = storeAt();
    await Promise.all([
      store.set("openrouter/a", { type: "api_key", secret: "aaaaaaaaaaaaaaaa" }),
      store.set("openrouter/b", { type: "api_key", secret: "bbbbbbbbbbbbbbbb" }),
    ]);
    expect(store.has("openrouter/a")).toBe(true);
    expect(store.has("openrouter/b")).toBe(true);
    // Reload from disk to prove persistence, not just in-memory state.
    const reloaded = storeAt();
    expect(reloaded.profileIds().sort()).toEqual(["openrouter/a", "openrouter/b"]);
  });

  test("interleaved multi-operation transactions do not lose updates", async () => {
    const store = storeAt();
    const operations = Array.from({ length: 24 }, (_, index) =>
      store.mutateAsync((credentials) => {
        credentials[`openrouter/p${index}`] = { type: "api_key", secret: `secret-${index}-padded-value` };
        // Yield inside the locked section to force interleaving attempts.
        return Promise.resolve().then(() => index);
      }),
    );
    await Promise.all(operations);
    const reloaded = storeAt();
    expect(reloaded.profileIds().length).toBe(24);
  });

  test("login + logout race leaves a consistent store", async () => {
    const store = storeAt();
    await Promise.all([
      store.set("openrouter/work", { type: "api_key", secret: "cccccccccccccccc" }),
      store.set("openrouter/personal", { type: "api_key", secret: "dddddddddddddddd" }),
      store.remove("openrouter/work"),
    ]);
    const reloaded = storeAt();
    expect(reloaded.profileIds()).toEqual(["openrouter/personal"]);
  });
});

describe("CredentialStore — corruption", () => {
  test("quarantines an unparseable file without crashing and starts empty", async () => {
    const file = path.join(dir, "auth-credentials.json");
    fs.writeFileSync(file, "{ this is not json ");
    const warnings: string[] = [];
    const store = new CredentialStore({ filePath: file, onWarn: (message) => warnings.push(message) });
    expect(store.profileIds()).toEqual([]);
    const quarantine = store.getQuarantine();
    expect(quarantine).not.toBeNull();
    expect(quarantine!.quarantinedPath).toContain(".corrupt-");
    expect(fs.existsSync(quarantine!.quarantinedPath)).toBe(true);
    expect(warnings.some((message) => message.includes("corrupt"))).toBe(true);
    // The warning must not contain file contents.
    expect(warnings.join(" ")).not.toContain("this is not json");
  });

  test("treats an unknown entry shape as corruption rather than data", async () => {
    const file = path.join(dir, "auth-credentials.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, credentials: { "openrouter/x": { type: "mystery" } } }),
    );
    const store = new CredentialStore({ filePath: file, onWarn: () => {} });
    expect(store.profileIds()).toEqual([]);
    expect(store.getQuarantine()).not.toBeNull();
  });

  test("treats a future/unknown version as corruption", async () => {
    const file = path.join(dir, "auth-credentials.json");
    fs.writeFileSync(file, JSON.stringify({ version: 99, credentials: {} }));
    const store = new CredentialStore({ filePath: file, onWarn: () => {} });
    // The first access loads (and therefore validates) the file.
    expect(store.profileIds()).toEqual([]);
    expect(store.getQuarantine()).not.toBeNull();
  });

  test("a missing file is normal, not corruption", () => {
    const store = storeAt("does-not-exist.json");
    expect(store.profileIds()).toEqual([]);
    expect(store.getQuarantine()).toBeNull();
  });

  test("repairs a corrupt store on the next write", async () => {
    const file = path.join(dir, "auth-credentials.json");
    fs.writeFileSync(file, "not json at all");
    const store = new CredentialStore({ filePath: file, onWarn: () => {} });
    await store.set("openrouter/a", { type: "api_key", secret: "eeeeeeeeeeeeeeee" });
    const reparsed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(reparsed.credentials["openrouter/a"].secret).toBe("eeeeeeeeeeeeeeee");
  });
});
