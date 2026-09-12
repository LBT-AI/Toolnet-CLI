import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetAppConfigCache } from "../../../lib/appConfig";
import {
  addFallback,
  currentSettings,
  loadRoutingConfig,
  persistRoutingConfig,
  removeFallback,
  resetPersistedRouting,
  validateRoutingPatch,
} from "../routingStore";
import { getRoutingConfig, resetRoutingConfig } from "../router";

const ORIGINAL_DIR = process.env.TOOLNETCLI_CONFIG_DIR;
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase80-routing-"));
  process.env.TOOLNETCLI_CONFIG_DIR = tempDir;
  resetAppConfigCache();
  resetRoutingConfig();
});

afterEach(() => {
  resetRoutingConfig();
  resetAppConfigCache();
  if (ORIGINAL_DIR === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR;
  else process.env.TOOLNETCLI_CONFIG_DIR = ORIGINAL_DIR;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

describe("Phase 80 — routing config persistence", () => {
  it("defaults to the auto profile and priority policy", () => {
    const settings = currentSettings();
    expect(settings.profile).toBe("auto");
    expect(settings.policy).toBe("priority");
    expect(settings.fallback).toEqual([]);
    expect(settings.maxAttempts).toBe(3);
  });

  it("loads persisted settings into the router", () => {
    const result = persistRoutingConfig({ profile: "coding", policy: "cheapest", maxAttempts: 4 });
    expect(result.ok).toBe(true);

    resetRoutingConfig();
    loadRoutingConfig();
    const config = getRoutingConfig();
    expect(config.profile).toBe("coding");
    expect(config.policy).toBe("cheapest");
    expect(config.maxAttempts).toBe(4);
  });

  it("writes into the canonical config file, not a second owner", () => {
    persistRoutingConfig({ profile: "quality" });
    const raw = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf8"));
    expect(raw.routing.profile).toBe("quality");
    expect(raw.schemaVersion).toBeGreaterThanOrEqual(3);
  });

  it("rejects an unknown profile instead of writing it", () => {
    const result = persistRoutingConfig({ profile: "not-a-profile" });
    expect(result.ok).toBe(false);
    expect(currentSettings().profile).toBe("auto");
  });

  it("rejects an unknown policy and an out-of-range attempt bound", () => {
    expect(validateRoutingPatch({ policy: "magic" }).ok).toBe(false);
    expect(validateRoutingPatch({ maxAttempts: 0 }).ok).toBe(false);
    expect(validateRoutingPatch({ maxAttempts: 99 }).ok).toBe(false);
    expect(validateRoutingPatch({ maxAttempts: 5 }).ok).toBe(true);
  });

  it("rejects a malformed fallback reference", () => {
    expect(validateRoutingPatch({ fallback: ["has whitespace"] }).ok).toBe(false);
    expect(validateRoutingPatch({ fallback: ["openrouter/a"] }).ok).toBe(true);
  });

  it("adds fallbacks idempotently and preserves order", () => {
    addFallback("openrouter/a");
    addFallback("toolnet/b");
    addFallback("openrouter/a");
    expect(currentSettings().fallback).toEqual(["openrouter/a", "toolnet/b"]);
    expect(getRoutingConfig().fallback).toEqual(["openrouter/a", "toolnet/b"]);
  });

  it("removes a fallback", () => {
    addFallback("openrouter/a");
    addFallback("openrouter/b");
    removeFallback("openrouter/a");
    expect(currentSettings().fallback).toEqual(["openrouter/b"]);
  });

  it("resets everything back to defaults", () => {
    persistRoutingConfig({ profile: "coding" });
    addFallback("openrouter/a");
    const settings = resetPersistedRouting();

    expect(settings.profile).toBe("auto");
    expect(settings.fallback).toEqual([]);
    expect(getRoutingConfig().profile).toBe("auto");
  });

  it("survives a hand-edited invalid routing block", () => {
    fs.writeFileSync(
      path.join(tempDir, "config.json"),
      JSON.stringify({ schemaVersion: 3, routing: { profile: 42, fallback: "nope", maxAttempts: "lots" } }),
      "utf8",
    );
    resetAppConfigCache();

    const settings = currentSettings();
    expect(settings.profile).toBe("auto");
    expect(settings.fallback).toEqual([]);
    expect(settings.maxAttempts).toBe(3);
  });
});
