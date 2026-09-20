/**
 * Real-PTY acceptance for fragmented escape sequences against the model
 * picker (mobile-SSH geometry). A Down arrow delivered as ESC | [ | B across
 * separate stdin events — slower than the ESC disambiguation window — must
 * decode as exactly one Down: the picker stays open, the selection moves, and
 * no fragment byte reaches the search field or composer.
 *
 * The driver runs under node (node-pty needs a node parent); assertions
 * replay the captured ANSI stream onto a grid via ./screen.
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

/** The model id currently highlighted by the picker, from the raw SGR stream. */
function lastHighlighted(output: string): string | null {
  const re = /\x1b\[1m● \x1b\[0m\x1b\[48;2;30;34;44m\x1b\[38;2;226;232;240m\x1b\[1m([^\x1b]*)/g;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(output)) !== null) last = m[1].trim();
  return last;
}

describe(`PTY model picker — fragmented Down (${COLS}x${ROWS} mobile SSH)${skipNote}`, () => {
  cond(
    "Down as ESC|[|[B keeps the picker open, moves selection, leaks nothing",
    () => {
      const { output } = runDriver([
        ["WAIT:> ", ""], // readiness — stdin listener attached
        [0, "/model\r"],
        ["WAIT:Select model", ""],
        [1200, ""], // allow the async model list to load
        [60, "\u001b"],
        [60, "["],
        [60, "B"],
        [200, ""],
        [60, "\u001b"],
        [60, "["],
        [60, "B"],
        [600, ""],
      ]);

      const grid = paint(output, COLS, ROWS).map((cells: string[]) =>
        cells.join("").trimEnd(),
      );

      // Picker still open in the final frame.
      expect(grid.some((row: string) => row.includes("Select model"))).toBe(true);

      // No fragment byte ever reached the search field.
      const searchRow = grid.find((row: string) => row.includes("Search")) ?? "";
      expect(searchRow).not.toContain("[B");
      expect(searchRow).not.toContain("B\u001b");

      // Composer untouched.
      expect(grid[ROWS - 2].startsWith("> ")).toBe(true);

      // Navigation happened without the picker closing: the highlighted row
      // resolved to a real model id (not the loading placeholder).
      const highlighted = lastHighlighted(output);
      expect(highlighted).not.toBeNull();
      expect(highlighted).not.toBe("No models availa…");
      expect(highlighted).not.toContain("[");
    },
    60_000,
  );
});
