/**
 * Phase 81 §19 — the TUI is a CONSUMER of the canonical harness registry.
 *
 * `/harness use` and `/harness profile` must go through the same config API the
 * CLI uses, and the panel section must read the registry rather than keeping its
 * own copy of the profile list. The TUI implements no policy.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetAppConfigCache } from "../../lib/appConfig";
import { currentHarnessSettings, harnessRegistry } from "../../core/harness";
import { harnessCommand } from "../../commands/harness";
import { getHarnessSections, getHarnessSectionDetail } from "../../lib/harnessCatalog";

const ORIGINAL_DIR = process.env.TOOLNETCLI_CONFIG_DIR;
let tempDir: string;

function ctx() {
  const messages: string[] = [];
  return {
    messages,
    context: {
      addMessage: (_role: string, content: string) => messages.push(content),
      setModel: () => {},
      setStatusMsg: () => {},
      exit: () => {},
      currentModel: () => "test-model",
    },
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase81-tui-"));
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

describe("Phase 81 §19 — TUI harness profile section", () => {
  it("exposes a Profile section in the harness panel", () => {
    const ids = getHarnessSections().map((section) => section.id);
    expect(ids).toContain("profile");
  });

  it("lists every registered profile and the active one", () => {
    const detail = getHarnessSectionDetail("profile");
    expect(detail).not.toBeNull();
    expect(detail!.title).toContain("Profile");
    const rows = detail!.rows.map((row) => `${row.label}: ${row.value}`).join("\n");
    expect(rows).toContain("Configured: default");
    for (const id of harnessRegistry.ids()) expect(rows).toContain(id);
  });

  it("reflects a selection made elsewhere", async () => {
    const c = ctx();
    await harnessCommand.handler(["use", "coding"], c.context as never);
    const detail = getHarnessSectionDetail("profile");
    const rows = detail!.rows.map((row) => `${row.label}: ${row.value}`).join("\n");
    expect(rows).toContain("Configured: coding");
  });

  it("still reports the canonical tool registry (no second source)", () => {
    // The tools section is what the existing architecture guard keys on.
    const detail = getHarnessSectionDetail("tools");
    expect(detail).not.toBeNull();
    expect(detail!.rows.some((row) => row.label === "Registered Tools")).toBe(true);
  });
});

describe("Phase 81 §19 — /harness selector", () => {
  it("persists a profile through the same API as the CLI", async () => {
    const c = ctx();
    await harnessCommand.handler(["use", "reasoning"], c.context as never);
    expect(currentHarnessSettings().profile).toBe("reasoning");
    expect(c.messages.join("\n")).toContain("Harness profile set to 'reasoning'");
  });

  it("rejects an unknown profile loudly and leaves the config alone", async () => {
    const c = ctx();
    await harnessCommand.handler(["use", "coding"], c.context as never);
    c.messages.length = 0;
    await harnessCommand.handler(["use", "codign"], c.context as never);
    expect(c.messages.join("\n")).toContain("Unknown harness profile");
    expect(currentHarnessSettings().profile).toBe("coding");
  });

  it("requires an id", async () => {
    const c = ctx();
    await harnessCommand.handler(["use"], c.context as never);
    expect(c.messages.join("\n")).toContain("Usage: /harness use <profile>");
  });

  it("/harness profile describes the active policy without a secret", async () => {
    const c = ctx();
    await harnessCommand.handler(["profile"], c.context as never);
    const text = c.messages.join("\n");
    expect(text).toContain("Harness profile: default");
    expect(text).toContain("Tools");
    expect(text.toLowerCase()).not.toContain("api_key");
  });

  it("help documents the selector and the policy boundary", async () => {
    const c = ctx();
    await harnessCommand.handler(["help"], c.context as never);
    const text = c.messages.join("\n");
    expect(text).toContain("/harness use <profile>");
    expect(text).toContain("Profile");
  });

  it("opens the overlay for a plain section argument (existing behaviour)", async () => {
    const opened: string[] = [];
    await harnessCommand.handler(["security"], {
      ...ctx().context,
      openHarnessPanel: async (section?: string) => {
        opened.push(section ?? "");
      },
    } as never);
    expect(opened).toEqual(["security"]);
  });
});
