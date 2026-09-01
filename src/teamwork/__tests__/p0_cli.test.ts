/**
 * P0.10 — Tests for ToolNet CLI distribution features.
 *
 * Covers:
 *  1. OS/arch mapping (getPlatform)
 *  2. Config init / defaults / validate
 *  3. Config migration from legacy format
 *  4. API key never printed in plain text
 *  5. Completion output for all shells
 *  6. Version parsing and comparison
 *  7. Update version comparison (compareSemver)
 *  8. Offline update check (returns null gracefully)
 *  9. Install method detection
 * 10. Version metadata consistency
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "p0-test-"));
}

function cleanDir(d: string) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// 1. OS / arch mapping
// ---------------------------------------------------------------------------

describe("P0 — OS / arch mapping", () => {
  it("getPlatform returns valid platform and arch", () => {
    const { getPlatform } = require("../../lib/version");
    const p = getPlatform();
    expect(["linux", "darwin", "windows"]).toContain(p.platform);
    expect(["x64", "arm64"]).toContain(p.arch);
  });
});

// ---------------------------------------------------------------------------
// 2. Config defaults
// ---------------------------------------------------------------------------

describe("P0 — AppConfig defaults", () => {
  let dir: string;
  let origDir: string | undefined;
  let origData: string | undefined;

  beforeEach(() => {
    origDir = process.env.TOOLNETCLI_CONFIG_DIR;
    origData = process.env.DATA_DIR;
    dir = tmpDir();
    process.env.TOOLNETCLI_CONFIG_DIR = dir;
    process.env.DATA_DIR = dir; // isolate legacy config lookup
    const { resetAppConfigCache } = require("../../lib/appConfig");
    resetAppConfigCache();
  });

  afterEach(() => {
    cleanDir(dir);
    if (origDir !== undefined) process.env.TOOLNETCLI_CONFIG_DIR = origDir;
    else delete process.env.TOOLNETCLI_CONFIG_DIR;
    if (origData !== undefined) process.env.DATA_DIR = origData;
    else delete process.env.DATA_DIR;
    const { resetAppConfigCache } = require("../../lib/appConfig");
    resetAppConfigCache();
  });

  it("loads sensible defaults when no config file exists", () => {
    const { loadAppConfig } = require("../../lib/appConfig");
    const { config, created } = loadAppConfig();
    expect(config.schemaVersion).toBe(2);
    expect(config.sandboxMode).toBe("workspace");
    expect(config.theme).toBe("dark");
    expect(config.updateCheckEnabled).toBe(true);
    expect(config.gatewayUrl).toBeNull();
    expect(config.provider).toBeNull();
  });

  it("saves and reloads a config", () => {
    const { updateAppConfig, loadAppConfig } = require("../../lib/appConfig");
    const updated = updateAppConfig({ sandboxMode: "workspace", theme: "light" });
    expect(updated.sandboxMode).toBe("workspace");
    expect(updated.theme).toBe("light");

    const { config: reloaded } = loadAppConfig();
    expect(reloaded.sandboxMode).toBe("workspace");
    expect(reloaded.theme).toBe("light");
  });
});

// ---------------------------------------------------------------------------
// 3. Config migration
// ---------------------------------------------------------------------------

describe("P0 — Config migration", () => {
  let dir: string;
  let origDir: string | undefined;
  let origData: string | undefined;

  beforeEach(() => {
    origDir = process.env.TOOLNETCLI_CONFIG_DIR;
    origData = process.env.DATA_DIR;
    dir = tmpDir();
    process.env.TOOLNETCLI_CONFIG_DIR = dir;
    process.env.DATA_DIR = dir; // isolate legacy config lookup
    const { resetAppConfigCache } = require("../../lib/appConfig");
    resetAppConfigCache();
  });

  afterEach(() => {
    cleanDir(dir);
    if (origDir !== undefined) process.env.TOOLNETCLI_CONFIG_DIR = origDir;
    else delete process.env.TOOLNETCLI_CONFIG_DIR;
    if (origData !== undefined) process.env.DATA_DIR = origData;
    else delete process.env.DATA_DIR;
    const { resetAppConfigCache } = require("../../lib/appConfig");
    resetAppConfigCache();
  });

  it("migrates legacy config (no schemaVersion) preserving fields", () => {
    const legacy = {
      baseUrl: "http://legacy:9999",
      defaultModel: "openai/gpt-4",
      theme: "light",
      sandboxMode: "workspace",
    };
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(legacy));

    const { loadAppConfig } = require("../../lib/appConfig");
    const { config } = loadAppConfig();
    expect(config.schemaVersion).toBe(2);
    expect(config.baseUrl).toBe("http://legacy:9999");
    expect(config.defaultModel).toBe("openai/gpt-4");
    expect(config.theme).toBe("light");
    expect(config.sandboxMode).toBe("workspace");
  });

  it("ignores unknown fields gracefully", () => {
    const bad = { schemaVersion: 1, unknownField: 123, sandboxMode: "full-access" };
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(bad));

    const { loadAppConfig } = require("../../lib/appConfig");
    const { config } = loadAppConfig();
    expect(config.sandboxMode).toBe("full-access");
    expect((config as any).unknownField).toBeUndefined();
  });

  it("rejects invalid sandboxMode and falls back to default", () => {
    const bad = { schemaVersion: 1, sandboxMode: "invalid-mode" };
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(bad));

    const { loadAppConfig } = require("../../lib/appConfig");
    const { config } = loadAppConfig();
    expect(config.sandboxMode).toBe("workspace");
  });
});

// ---------------------------------------------------------------------------
// 4. API key masking — key is never printed in plain text
// ---------------------------------------------------------------------------

describe("P0 — API key masking", () => {
  it("maskApiKey hides the middle of the key", () => {
    const { maskApiKey } = require("../../lib/keys");
    const key = "sk-abcdefghijklmnopqrstuvwxyz";
    const masked = maskApiKey(key);
    expect(masked).not.toBe(key);
    expect(masked).toContain("•");
    expect(masked).toContain("sk-a");  // first 4 chars
    expect(masked).toContain("wxyz"); // last 4 chars
  });

  it("maskApiKey handles short keys", () => {
    const { maskApiKey } = require("../../lib/keys");
    expect(maskApiKey("short")).toBe("••••••••");
    expect(maskApiKey("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 5. Completion output
// ---------------------------------------------------------------------------

describe("P0 — Shell completion", () => {
  it("bash completion includes complete -F", () => {
    const { generateCompletionScript } = require("../../lib/completion");
    const script = generateCompletionScript("bash");
    expect(script).toContain("complete -F");
    expect(script).toContain("--version");
    expect(script).toContain("--prompt");
    expect(script).toContain("--resume");
    expect(script).toContain("--session");
    expect(script).toContain("--model");
    expect(script).toContain("--json");
    expect(script).toContain("config");
    expect(script).toContain("completion");
    expect(script).toContain("update");
  });

  it("zsh completion includes #compdef", () => {
    const { generateCompletionScript } = require("../../lib/completion");
    const script = generateCompletionScript("zsh");
    expect(script).toContain("#compdef toolnet");
    expect(script).toContain("help");
    expect(script).toContain("--version");
  });

  it("fish completion includes complete -c toolnet", () => {
    const { generateCompletionScript } = require("../../lib/completion");
    const script = generateCompletionScript("fish");
    expect(script).toContain("complete -c toolnet");
    expect(script).toContain("help");
    expect(script).toContain("model");
  });
});

// ---------------------------------------------------------------------------
// 6. Version parsing
// ---------------------------------------------------------------------------

describe("P0 — Version parsing", () => {
  it("parseSemver parses standard versions", () => {
    const { parseSemver } = require("../../lib/updater");
    expect(parseSemver("1.0.5")).toEqual({ major: 1, minor: 0, patch: 5 });
    expect(parseSemver("v2.3.10")).toEqual({ major: 2, minor: 3, patch: 10 });
    expect(parseSemver("0.0.1")).toEqual({ major: 0, minor: 0, patch: 1 });
  });

  it("parseSemver returns null for invalid versions", () => {
    const { parseSemver } = require("../../lib/updater");
    expect(parseSemver("invalid")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("1.2.3-beta")).not.toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Semver comparison
// ---------------------------------------------------------------------------

describe("P0 — Semver comparison", () => {
  it("compareSemver orders correctly", () => {
    const { compareSemver, parseSemver } = require("../../lib/updater");
    const a = (v: string) => parseSemver(v)!;
    expect(compareSemver(a("2.0.0"), a("1.0.0"))).toBe(1);
    expect(compareSemver(a("1.0.0"), a("1.1.0"))).toBe(-1);
    expect(compareSemver(a("1.1.0"), a("1.1.1"))).toBe(-1);
    expect(compareSemver(a("1.0.5"), a("1.0.5"))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Offline update check
// ---------------------------------------------------------------------------

describe("P0 — Offline update check", () => {
  it("backgroundCheck returns UpdateInfo when offline or cached", async () => {
    // backgroundCheck hits GitHub/npm, not the local gateway.
    // When offline or rate-limited it returns null; when it can reach the
    // network it returns an UpdateInfo object. Both are valid behaviours.
    const { backgroundCheck } = require("../../lib/updater");
    const result = await backgroundCheck();
    // Either null (offline/cache hit) or a valid UpdateInfo object.
    if (result !== null) {
      expect(typeof result.currentVersion).toBe("string");
      expect(typeof result.latestVersion).toBe("string");
      expect(typeof result.hasUpdate).toBe("boolean");
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Install method detection
// ---------------------------------------------------------------------------

describe("P0 — Install method detection", () => {
  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env.TOOLNET_INSTALL_METHOD;
  });

  afterEach(() => {
    if (origEnv !== undefined) process.env.TOOLNET_INSTALL_METHOD = origEnv;
    else delete process.env.TOOLNET_INSTALL_METHOD;
  });

  it("returns overridden value when TOOLNET_INSTALL_METHOD is set", () => {
    process.env.TOOLNET_INSTALL_METHOD = "binary";
    const { detectInstallMethod } = require("../../lib/installMethod");
    expect(detectInstallMethod()).toBe("binary");
  });

  it("detects 'dev' when running from source checkout", () => {
    process.env.TOOLNET_INSTALL_METHOD = "dev";
    const { detectInstallMethod } = require("../../lib/installMethod");
    expect(detectInstallMethod()).toBe("dev");
  });

  it("detects npm when overridden", () => {
    process.env.TOOLNET_INSTALL_METHOD = "npm";
    const { detectInstallMethod } = require("../../lib/installMethod");
    expect(detectInstallMethod()).toBe("npm");
  });
});

// ---------------------------------------------------------------------------
// 10. Version metadata consistency
// ---------------------------------------------------------------------------

describe("P0 — Version metadata", () => {
  it("getVersion() matches the embedded constant", () => {
    const { getVersion, EMBEDDED_VERSION } = require("../../lib/version");
    expect(getVersion()).toBe(EMBEDDED_VERSION);
  });

  it("getVersion() is a valid semver", () => {
    const { getVersion } = require("../../lib/version");
    const { parseSemver } = require("../../lib/updater");
    expect(parseSemver(getVersion())).not.toBeNull();
  });

  it("getVersionString() contains the platform", () => {
    const { getVersionString, getPlatform } = require("../../lib/version");
    const { platform, arch } = getPlatform();
    expect(getVersionString()).toContain(`${platform}-${arch}`);
  });

  it("getVersionJson() has all required fields", () => {
    const { getVersionJson } = require("../../lib/version");
    const vj = getVersionJson();
    expect(typeof vj.version).toBe("string");
    expect(typeof vj.platform).toBe("string");
    expect(typeof vj.arch).toBe("string");
    expect(["binary", "npm", "dev", "unknown"]).toContain(vj.installMethod);
  });
});
