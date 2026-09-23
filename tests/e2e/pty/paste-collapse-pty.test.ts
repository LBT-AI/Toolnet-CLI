/**
 * Real-PTY acceptance for collapsed paste at mobile-SSH geometry (52x20).
 *
 * A 365-line bracketed paste must become ONE short token in the composer: the
 * frame must not grow by hundreds of rows, the footer must stay on the final
 * grid row, and nothing from the pasted body may leak into the transcript.
 *
 * The driver runs under node (node-pty needs a node parent); assertions replay
 * the captured ANSI stream onto a grid via ./screen.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { paint } from "./screen";

const ROOT = process.cwd();
const ENTRY = join(ROOT, "dist", "node", "index.js");
const DRIVER = join(ROOT, "tests", "e2e", "pty", "driver.cjs");
const COLS = 52;
const ROWS = 20;

// eslint-disable-next-line @typescript-eslint/no-var-requires
let nodePty: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  nodePty = require("node-pty");
} catch {
  nodePty = null;
}
const hasEntry = existsSync(ENTRY);
const cond = nodePty && hasEntry ? it : it.skip;
const skipNote = !nodePty
  ? " (skipped: node-pty unavailable)"
  : !hasEntry
    ? " (skipped: run bun run build first)"
    : "";

function runDriver(script: Array<[number | string, string]>): { output: string; exitCode: number } {
  const res = spawnSync(
    "node",
    [
      DRIVER,
      "--cols", String(COLS),
      "--rows", String(ROWS),
      "--entry", ENTRY,
      "--script", JSON.stringify(script),
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000 },
  );
  if (res.status !== 0) throw new Error(`driver failed: ${res.stderr || res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  if (!parsed.available) throw new Error("node-pty unavailable inside driver");
  return parsed;
}

/** A real bracketed paste: ESC[200~ <body> ESC[201~. */
function bracketedPaste(body: string): string {
  return `\u001b[200~${body}\u001b[201~`;
}

function bodyLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `pasted row ${i + 1}`).join("\n");
}

describe(`PTY collapsed paste (${COLS}x${ROWS} mobile SSH)${skipNote}`, () => {
  cond(
    "a 365-line paste occupies one composer token and never floods the frame",
    () => {
      const { output } = runDriver([
        ["WAIT:> ", ""], // readiness — stdin listener attached
        [0, bracketedPaste(bodyLines(365))],
        ["WAIT:[365 lines pasted #1]", ""], // token actually rendered
        [400, ""],
        [600, "\u0004"], // no-op control byte; driver safety net then ends the run
        [3000, ""],
      ]);

      const grid = paint(output, COLS, ROWS).map((cells: string[]) => cells.join("").trimEnd());
      const frame = grid.join("\n");

      // The composer shows exactly one short token…
      expect(frame).toContain("[365 lines pasted #1]");
      expect(frame.match(/\[365 lines pasted #1\]/g)?.length).toBe(1);

      // …and no line of the pasted body was ever drawn.
      expect(frame).not.toContain("pasted row 1\n");
      expect(frame).not.toContain("pasted row 300");
      expect(frame).not.toContain("pasted row 365");

      // Chrome geometry is untouched: footer owns the final row, and the
      // composer did not consume the transcript.
      expect(grid[ROWS - 1]).toContain("ToolNet Gateway");
      const tokenRow = grid.findIndex((row) => row.includes("[365 lines pasted #1]"));
      expect(tokenRow).toBeGreaterThanOrEqual(0);
      // The token sits in the bottom chrome region (composer), never mid-frame.
      expect(tokenRow).toBeGreaterThanOrEqual(ROWS - 3);
      expect(tokenRow).toBeLessThan(ROWS - 1);
    },
    60_000,
  );

  cond(
    "typed text + paste + one Backspace removes the token atomically",
    () => {
      const { output } = runDriver([
        ["WAIT:> ", ""],
        [0, "Fix: "],
        ["WAIT:Fix: ", ""],
        [0, bracketedPaste(bodyLines(20))],
        ["WAIT:[20 lines pasted #1]", ""],
        [400, ""],
        [0, "\u007f"], // Backspace right after the token
        [500, ""],
        [600, "\u0004"],
        [3000, ""],
      ]);

      const frame = paint(output, COLS, ROWS)
        .map((cells: string[]) => cells.join("").trimEnd())
        .join("\n");

      // The block was shown, then removed in one keystroke — typed text stays.
      // (The grid trims trailing cells, so assert the text without the pad.)
      expect(frame).toContain("> Fix:");
      expect(frame).not.toContain("[20 lines pasted #1]");
      expect(frame).not.toContain("pasted row 20");
    },
    60_000,
  );

  cond(
    "two pastes in one draft render two distinct tokens",
    () => {
      const { output } = runDriver([
        ["WAIT:> ", ""],
        [0, bracketedPaste(bodyLines(100))],
        [400, " and "],
        [0, bracketedPaste(bodyLines(150))],
        ["WAIT:[150 lines pasted #2]", ""],
        [400, ""],
        [600, "\u0004"],
        [3000, ""],
      ]);

      const frame = paint(output, COLS, ROWS)
        .map((cells: string[]) => cells.join("").trimEnd())
        .join("\n");

      expect(frame).toContain("[100 lines pasted #1]");
      expect(frame).toContain("[150 lines pasted #2]");
      expect(frame).not.toContain("pasted row 100");
      expect(frame).not.toContain("pasted row 150");
    },
    60_000,
  );
});
