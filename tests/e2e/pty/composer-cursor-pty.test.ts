/**
 * Real-PTY acceptance for composer/footer/cursor anchoring at mobile-SSH
 * geometry (52x20). The typed caret must sit INSIDE the composer right after
 * the typed text, the footer must own the final grid row, and the final cursor
 * addressing must never target a row below the composer.
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

let nodePty: any = null;
try {
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

function runDriver(script: Array<[number, string]>): { output: string; exitCode: number } {
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

describe(`PTY composer/footer/cursor anchoring (${COLS}x${ROWS} mobile SSH)${skipNote}`, () => {
  cond(
    "caret after 'xin ha', footer last, nothing below the composer",
    () => {
      const { output } = runDriver([
        ["WAIT:> ", ""], // readiness — stdin listener attached
        [0, "x"],
        [80, "i"],
        [80, "n"],
        [80, " "],
        [80, "h"],
        [80, "a"],
        [500, "\u0004"], // Ctrl+D -> clean TUI exit
        [3000, ""],
      ]);

      const grid = paint(output, COLS, ROWS).map((cells: string[]) => cells.join("").trimEnd());
      const text = (row: number) => grid[row].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

      // Composer row: typed text present, prompt prefix immediately before it.
      const composerRow = grid.findIndex((line: string) => text(grid.indexOf(line)).includes("xin ha"));
      expect(composerRow).toBeGreaterThanOrEqual(0);
      const composerPlain = text(composerRow);
      expect(composerPlain.trimStart().startsWith(">")).toBe(true);

      // Footer owns the FINAL grid row; every row between composer and footer is empty.
      expect(grid[ROWS - 1]).toContain("ToolNet Gateway");
      for (let r = composerRow + 1; r < ROWS - 1; r++) {
        expect(text(r).trim()).toBe("");
      }

      // Final cursor addressing lands right after the typed text, on the composer row.
      const cups = [...output.matchAll(/\x1b\[(\d+);(\d+)H/g)];
      expect(cups.length).toBeGreaterThan(0);
      const [r1, c1] = cups[cups.length - 1].slice(1).map(Number);
      expect(r1 - 1).toBe(composerRow);
      expect(c1 - 1).toBe(composerPlain.indexOf("xin ha") + "xin ha".length);
    },
    60_000,
  );
});
