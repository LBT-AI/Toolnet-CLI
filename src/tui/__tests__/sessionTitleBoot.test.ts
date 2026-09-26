/**
 * Session title across the TUI's session-loading paths.
 *
 * The durable title is metadata: loading a session (boot `-s`, `resume`, a
 * crash recovery, or a `/session` switch) must surface the SAME title in the
 * footer, and an untitled target must clear the previous label rather than leak
 * it. These paths used to copy model/mode/messages but drop `title`.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionStore } from "../../core/session";
import { loadSession, sessionDisplayTitle } from "../../lib/sessionPersistence";
import { buildTuiCommandContext } from "../events/agentWiring";
import { tuiState } from "../state";

let tmpDir: string;
let previousOverride: string | undefined;

beforeEach(() => {
  previousOverride = process.env.TOOLNETCLI_SESSIONS_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-title-boot-"));
  process.env.TOOLNETCLI_SESSIONS_DIR = tmpDir;
  sessionStore.resetCache();
  tuiState.sessionTitle = undefined;
});

afterEach(() => {
  if (previousOverride === undefined) delete process.env.TOOLNETCLI_SESSIONS_DIR;
  else process.env.TOOLNETCLI_SESSIONS_DIR = previousOverride;
  sessionStore.resetCache();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe("sessionDisplayTitle — durable label, legacy fallback, never empty", () => {
  test("prefers the record title", () => {
    expect(sessionDisplayTitle({ title: "Fix TUI scroll jitter", metadata: { name: "old" } })).toBe(
      "Fix TUI scroll jitter",
    );
  });

  test("falls back to a legacy metadata.name", () => {
    expect(sessionDisplayTitle({ metadata: { name: "Legacy name" } })).toBe("Legacy name");
  });

  test("an untitled session yields undefined (no empty separator)", () => {
    expect(sessionDisplayTitle({ metadata: {} })).toBeUndefined();
    expect(sessionDisplayTitle(null)).toBeUndefined();
    expect(sessionDisplayTitle(undefined)).toBeUndefined();
  });
});

describe("resume / restart shows the same title", () => {
  test("a persisted auto title survives a fresh load through the legacy facade", () => {
    const record = sessionStore.create({ workspace: undefined as any });
    sessionStore.setAutoTitle(record.id, "Build Mercedes-AMG WordPress page");

    // This is exactly the read path app.ts uses on boot/resume.
    const loaded = loadSession(record.id);
    expect(loaded).not.toBeNull();
    expect(sessionDisplayTitle(loaded)).toBe("Build Mercedes-AMG WordPress page");
  });

  test("a manual rename beats the auto title on reload", () => {
    const record = sessionStore.create({ workspace: undefined as any });
    sessionStore.setAutoTitle(record.id, "Auto label");
    sessionStore.rename(record.id, "Manual label");

    expect(sessionDisplayTitle(loadSession(record.id))).toBe("Manual label");
  });
});

describe("TUI session switch refreshes the footer label", () => {
  test("switching to a titled session sets sessionTitle; an untitled one clears it", () => {
    const titled = sessionStore.create({ workspace: undefined as any });
    sessionStore.setAutoTitle(titled.id, "Audit session persistence");
    const untitled = sessionStore.create({ workspace: undefined as any });

    const ctx = buildTuiCommandContext();

    ctx.switchSession(titled.id);
    expect(tuiState.sessionTitle).toBe("Audit session persistence");

    ctx.switchSession(untitled.id);
    expect(tuiState.sessionTitle).toBeUndefined();
  });
});
