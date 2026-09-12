/**
 * Phase 81 §18 — `toolnet harness` CLI surface.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetAppConfigCache } from "../../lib/appConfig";
import { currentHarnessSettings, harnessRegistry } from "../../core/harness";
import { runHarnessCli } from "../harnessCli";

const ORIGINAL_DIR = process.env.TOOLNETCLI_CONFIG_DIR;
let tempDir: string;

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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase81-cli-"));
  process.env.TOOLNETCLI_CONFIG_DIR = tempDir;
  resetAppConfigCache();
});

afterEach(() => {
  if (ORIGINAL_DIR === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR;
  else process.env.TOOLNETCLI_CONFIG_DIR = ORIGINAL_DIR;
  resetAppConfigCache();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

describe("Phase 81 §18 — toolnet harness", () => {
  it("lists every profile and marks the active one", async () => {
    const c = capture();
    const code = await runHarnessCli(["list"], { io: c.io });
    expect(code).toBe(0);
    for (const id of harnessRegistry.ids()) expect(c.stdout()).toContain(id);
    expect(c.stdout()).toContain("active: default");
    expect(c.stdout()).toContain("Auto-resolution table");
  });

  it("prints machine-readable JSON on request", async () => {
    const c = capture();
    await runHarnessCli(["list", "--json"], { io: c.io });
    const parsed = JSON.parse(c.stdout());
    expect(parsed.active).toBe("default");
    expect(parsed.profiles).toHaveLength(harnessRegistry.ids().length);
    expect(parsed.profiles[0].id).toBe("default");
  });

  it("shows one profile's full policy contract", async () => {
    const c = capture();
    const code = await runHarnessCli(["show", "coding"], { io: c.io });
    expect(code).toBe(0);
    const text = c.stdout();
    for (const label of ["Prompt", "Tools", "Continuation", "Context", "Completion"]) {
      expect(text).toContain(label);
    }
    // The policy-vs-permission boundary must be visible to the operator.
    expect(text).toContain("permission is unchanged");
  });

  it("fails loudly for an unknown profile on show", async () => {
    const c = capture();
    const code = await runHarnessCli(["show", "nope"], { io: c.io });
    expect(code).toBe(1);
    expect(c.stderr()).toContain("Unknown harness profile");
    expect(c.stderr()).toContain("coding");
  });

  it("requires an id for show", async () => {
    const c = capture();
    expect(await runHarnessCli(["show"], { io: c.io })).toBe(1);
    expect(c.stderr()).toContain("Usage: toolnet harness show <id>");
  });

  it("current reports the configured profile", async () => {
    const c = capture();
    expect(await runHarnessCli(["current"], { io: c.io })).toBe(0);
    expect(c.stdout()).toContain("Harness profile: default");
  });

  it("use persists a profile for future runs", async () => {
    const c = capture();
    expect(await runHarnessCli(["use", "coding"], { io: c.io })).toBe(0);
    expect(c.stdout()).toContain("Harness profile set to 'coding'");
    expect(currentHarnessSettings().profile).toBe("coding");

    const current = capture();
    await runHarnessCli(["current"], { io: current.io });
    expect(current.stdout()).toContain("coding");
  });

  it("use rejects an unknown profile and leaves the config untouched", async () => {
    await runHarnessCli(["use", "coding"], { io: capture().io });
    const c = capture();
    const code = await runHarnessCli(["use", "codign"], { io: c.io });
    expect(code).toBe(1);
    expect(c.stderr()).toContain("Known:");
    expect(currentHarnessSettings().profile).toBe("coding");
  });

  it("use requires an id", async () => {
    const c = capture();
    expect(await runHarnessCli(["use"], { io: c.io })).toBe(1);
    expect(c.stderr()).toContain("Usage: toolnet harness use <id>");
  });

  it("reset restores the default profile", async () => {
    await runHarnessCli(["use", "reasoning"], { io: capture().io });
    const c = capture();
    expect(await runHarnessCli(["reset"], { io: c.io })).toBe(0);
    expect(currentHarnessSettings().profile).toBe("default");
  });

  it("current exits non-zero when the configured id is not registered", async () => {
    // Simulate a hand-edited config carrying a stale id. The loader keeps it
    // (it must not brick the CLI) and `current` reports it loudly.
    fs.writeFileSync(
      path.join(tempDir, "config.json"),
      JSON.stringify({
        schemaVersion: 4,
        harness: { profile: "ghost" },
        routing: { profile: "auto", policy: "priority", fallback: [], maxAttempts: 3, excludedProviders: [] },
        defaultModel: "",
        sandboxMode: "workspace",
      }),
    );
    resetAppConfigCache();

    const c = capture();
    const code = await runHarnessCli(["current"], { io: c.io });
    expect(code).toBe(1);
    expect(c.stderr()).toContain("not registered");
    expect(c.stderr()).toContain("default");
  });

  it("prints usage for help and for an unknown subcommand", async () => {
    const help = capture();
    expect(await runHarnessCli(["--help"], { io: help.io })).toBe(0);
    expect(help.stdout()).toContain("toolnet harness list");

    const bad = capture();
    expect(await runHarnessCli(["frobnicate"], { io: bad.io })).toBe(1);
    expect(bad.stderr()).toContain("Unknown harness subcommand");
  });

  it("never prints a secret or a model id", async () => {
    const c = capture();
    await runHarnessCli(["list"], { io: c.io });
    const text = c.stdout().toLowerCase();
    expect(text).not.toContain("api_key");
    expect(text).not.toContain("apikey");
    expect(text).not.toContain("token");
  });
});
