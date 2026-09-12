import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetAppConfigCache } from "../../lib/appConfig";
import { getRoutingConfig, resetRoutingConfig } from "../../core/models/router";
import { runModelsCli } from "../modelsCli";

const ORIGINAL_DIR = process.env.TOOLNETCLI_CONFIG_DIR;
let dir: string;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "phase80-routingcli-"));
  process.env.TOOLNETCLI_CONFIG_DIR = dir;
  resetAppConfigCache();
  resetRoutingConfig();
});

afterEach(() => {
  resetRoutingConfig();
  resetAppConfigCache();
  if (ORIGINAL_DIR === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR;
  else process.env.TOOLNETCLI_CONFIG_DIR = ORIGINAL_DIR;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("Phase 80 — `toolnet routing`", () => {
  it("shows the active profile and policy", async () => {
    const { io, stdout } = capture();
    const code = await runModelsCli(["routing", "show"], { io });
    expect(code).toBe(0);
    expect(stdout()).toContain("Routing profile:    auto");
    expect(stdout()).toContain("Routing policy:     priority");
    expect(stdout()).toContain("Profiles:");
  });

  it("lists every profile with its weights", async () => {
    const { io, stdout } = capture();
    expect(await runModelsCli(["routing", "profiles"], { io })).toBe(0);
    expect(stdout()).toContain("coding:");
    expect(stdout()).toContain("ranking=score");
    expect(stdout()).toContain("cheap:");
  });

  it("persists a profile change and applies it to the router", async () => {
    const { io, stdout } = capture();
    expect(await runModelsCli(["routing", "profile", "coding"], { io })).toBe(0);
    expect(stdout()).toContain("coding");
    expect(getRoutingConfig().profile).toBe("coding");

    const raw = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(raw.routing.profile).toBe("coding");
  });

  it("rejects an unknown profile without writing it", async () => {
    const { io, stderr } = capture();
    const code = await runModelsCli(["routing", "profile", "magic"], { io });
    expect(code).toBe(1);
    expect(stderr()).toContain("Unknown routing profile");
    expect(getRoutingConfig().profile).toBe("auto");
  });

  it("routes a default model through the canonical resolver before persisting", async () => {
    const { io, stderr } = capture();
    const code = await runModelsCli(["routing", "model", "ghost/nope"], { io });
    expect(code).toBe(1);
    expect(stderr()).toContain("Could not resolve");
  });

  it("adds and removes fallbacks", async () => {
    const added = capture();
    expect(await runModelsCli(["routing", "fallback", "add", "openrouter/a"], { io: added.io })).toBe(0);

    const shown = capture();
    await runModelsCli(["routing", "show"], { io: shown.io });
    expect(shown.stdout()).toContain("openrouter/a");

    const removed = capture();
    expect(await runModelsCli(["routing", "fallback", "remove", "openrouter/a"], { io: removed.io })).toBe(0);
    expect(getRoutingConfig().fallback).toEqual([]);
  });

  it("reports usage for a malformed fallback subcommand", async () => {
    const { io, stderr } = capture();
    expect(await runModelsCli(["routing", "fallback", "add"], { io })).toBe(1);
    expect(stderr()).toContain("Usage:");
  });

  it("resets routing settings back to defaults", async () => {
    const set = capture();
    await runModelsCli(["routing", "profile", "quality"], { io: set.io });
    expect(getRoutingConfig().profile).toBe("quality");

    const reset = capture();
    expect(await runModelsCli(["routing", "reset"], { io: reset.io })).toBe(0);
    expect(getRoutingConfig().profile).toBe("auto");
  });

  it("emits JSON when asked", async () => {
    const { io, stdout } = capture();
    await runModelsCli(["routing", "show", "--json"], { io });
    const parsed = JSON.parse(stdout());
    expect(parsed.profile).toBe("auto");
    expect(parsed.policy).toBe("priority");
  });
});
