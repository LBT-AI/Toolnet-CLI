/**
 * PTY acceptance for the TUI across the four target geometries.
 *
 * The real pseudo-terminal is driven by tests/e2e/pty/driver.cjs, which runs
 * under node: node-pty's forkpty event delivery is unreliable when the parent
 * process is Bun (the child spawns but produces no output). Assertions here
 * are unchanged: alt-screen enter/leave, cursor restore, prompt visibility,
 * the double-Ctrl+C exit hint, and live-resize survival.
 *
 * Scripts use WAIT:<text> readiness markers instead of fixed cold-start
 * delays: keystrokes must never be assumed to land before the TUI has painted
 * its first frame and attached its stdin listener.
 *
 * Determinism / isolation:
 *   - ROOT is resolved from this file, never process.cwd(), so the suite runs
 *     identically from any working directory.
 *   - The PTY is a POSIX pseudo-terminal; on Windows the tests SKIP explicitly
 *     (never a silent pass) instead of depending on forkpty behaviour.
 *   - When node-pty or the built entry is missing the tests SKIP explicitly, so
 *     a green run can never hide an unexecuted acceptance.
 *   - The child env strips agent/developer shell variables (notably CLAUDECODE)
 *     so an ambient shell can never change the captured byte stream.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SIZES: Array<[number, number]> = [
  [120, 40],
  [100, 30],
  [80, 24],
  [60, 20],
];

let pty: any = null;
try {
  // eslint-disable-next-line import/no-commonjs
  pty = require("node-pty");
} catch {
  pty = null;
}

const ROOT = join(import.meta.dir, "..", "..");
const ENTRY = join(ROOT, "dist", "node", "index.js");
const DRIVER = join(ROOT, "tests", "e2e", "pty", "driver.cjs");
const hasEntry = existsSync(ENTRY);
const posix = process.platform !== "win32";
const ready = Boolean(pty) && hasEntry && posix;
const cond = ready ? it : it.skip;

const skipReason = !pty
  ? "node-pty unavailable"
  : !hasEntry
    ? "run `bun run build` first"
    : !posix
      ? "PTY acceptance is POSIX-only"
      : "";

interface PtyResult {
  output: string;
  exitCode: number;
}

/** Child env with agent/developer shell state removed. */
function isolatedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^CLAUDECODE$|^CLAUDE_CODE_/.test(key)) continue;
    env[key] = value;
  }
  return env;
}

function runDriver(cols: number, rows: number, script: Array<[string | number, string]>, timeoutMs = 40_000): PtyResult | null {
  if (!ready) return null;
  const res = spawnSync(
    "node",
    [DRIVER, "--cols", String(cols), "--rows", String(rows), "--entry", ENTRY, "--script", JSON.stringify(script)],
    { cwd: ROOT, encoding: "utf8", timeout: timeoutMs, env: isolatedEnv() },
  );
  if (res.status !== 0) throw new Error(`pty driver failed: ${res.stderr || res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  if (!parsed.available) return null;
  return { output: parsed.output, exitCode: parsed.exitCode };
}

describe(`PTY acceptance (small terminals, resize, restore)${skipReason ? ` — skipped: ${skipReason}` : ""}`, () => {
  cond("node-pty and the built entry are available", () => {
    expect(ready).toBe(true);
  });

  for (const [cols, rows] of SIZES) {
    cond(
      `launches and renders at ${cols}x${rows}, prompt visible, clean teardown`,
      () => {
        const res = runDriver(cols, rows, [
          ["WAIT:> ", ""], // readiness — first frame painted, stdin attached
          [200, "\u001b"], // Esc is inert: must not crash or submit
          [400, "\u0003"], // Ctrl+C once (idle → hint, not exit)
          [400, "\u0003"], // Ctrl+C again → exit
          [2500, ""], // let the TUI exit and tear down
        ]);
        expect(res).not.toBeNull();
        if (!res) return;

        // Alt screen was entered…
        expect(res.output).toContain("\u001b[?1049h");
        // …and left again on exit (clean teardown, no raw mode leak).
        expect(res.output).toContain("\u001b[?1049l");
        // Cursor restored.
        expect(res.output).toContain("\u001b[?25h");
        // The composer prompt rendered.
        expect(res.output).toContain(">");
        // The double-Ctrl+C exit hint appeared.
        expect(res.output).toContain("Press Ctrl+C again");
      },
      60_000,
    );
  }

  cond(
    "survives a live resize during streaming render (80x24 → 120x40 → 60x20)",
    () => {
      const res = runDriver(80, 24, [
        ["WAIT:> ", ""], // readiness
        [500, "RESIZE:120x40"],
        [400, "RESIZE:60x20"],
        [400, "\u0003"],
        [400, "\u0003"],
        [2500, ""],
      ]);
      expect(res).not.toBeNull();
      if (!res) return;

      expect(res.output).toContain("\u001b[?1049h");
      expect(res.output).toContain("\u001b[?1049l");
      // After resize down to 60 cols the composer prompt must still be painted.
      const tail = res.output.slice(-4000);
      expect(tail).toContain(">");
    },
    60_000,
  );
});
