/**
 * ToolNet CLI startup banner — pixel-block "build up" animation,
 * in the style of the GitHub Copilot CLI welcome screen.
 *
 * How the effect works:
 *  1. The logo text is stored as a small bitmap font (5 rows tall).
 *  2. That bitmap is rendered to a grid of "on/off" cells.
 *  3. The animation reveals the grid row-by-row (top -> bottom),
 *     redrawing in place using ANSI cursor movement (no flicker,
 *     no console.clear() scrollback spam).
 *  4. A subtitle line is typed out character-by-character underneath,
 *     and simple corner brackets frame the whole thing.
 *
 * Install: npm i chalk
 * (chalk v5 is ESM-only — make sure package.json has "type": "module",
 *  or use dynamic import() if you're on CommonJS.)
 *
 * Usage:
 *   import { printToolNetBanner } from "./toolnet-banner.js";
 *   await printToolNetBanner();
 */

import chalk from "chalk";
import readline from "node:readline";

const BLOCK = "█";

// 5-row pixel font — add more letters here as needed.
const FONT: Record<string, string[]> = {
  T: ["#####", "..#..", "..#..", "..#..", "..#.."],
  O: [".###.", "#...#", "#...#", "#...#", ".###."],
  L: ["#....", "#....", "#....", "#....", "#####"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#"],
  E: ["#####", "#....", "####.", "#....", "#####"],
};

const LETTER_SPACING = 1;

/** Build a boolean grid (rows x cols) for a word using the pixel font. */
function buildWordGrid(word: string): boolean[][] {
  const letters = word.toUpperCase().split("").map((ch) => FONT[ch]);
  const height = 5;
  const grid: boolean[][] = Array.from({ length: height }, () => []);

  letters.forEach((letterRows, i) => {
    for (let r = 0; r < height; r++) {
      for (const ch of letterRows[r]) grid[r].push(ch === "#");
      if (i < letters.length - 1) {
        for (let s = 0; s < LETTER_SPACING; s++) grid[r].push(false);
      }
    }
  });
  return grid;
}

/** Render one row of the grid up to `revealedCols` columns, colored. */
function renderRow(row: boolean[], revealedCols: number, color: (s: string) => string): string {
  let out = "";
  for (let c = 0; c < row.length; c++) {
    if (c >= revealedCols) {
      out += " ";
    } else {
      out += row[c] ? color(BLOCK) : " ";
    }
  }
  return out;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BORDER_COLOR = chalk.hex("#d946ef"); // magenta
const LOGO_COLOR = chalk.hex("#3b82f6"); // blue
const SUBTITLE_COLOR = chalk.hex("#a855f7");

export async function printToolNetBanner(word = "TOOLNET", version = "1.0.0") {
  const grid = buildWordGrid(word);
  const width = grid[0].length;
  const pad = 2;

  const topBorder = BORDER_COLOR("┌─" + " ".repeat(width + pad * 2 - 4) + "─┐");
  const bottomBorder = BORDER_COLOR("└─" + " ".repeat(width + pad * 2 - 4) + "─┘");
  const totalLines = grid.length + 4; // border + logo + subtitle lines

  process.stdout.write("\x1B[?25l"); // hide cursor

  // Scanline reveal: for each frame, show progressively more of the grid.
  const stepsPerRow = 6;
  for (let frame = 1; frame <= grid.length * stepsPerRow; frame++) {
    const rowsFullyDone = Math.floor(frame / stepsPerRow);
    const partialCols = Math.ceil(((frame % stepsPerRow) / stepsPerRow) * width) || width;

    const lines: string[] = [];
    lines.push(topBorder);
    lines.push(BORDER_COLOR("│ ") + " ".repeat(width) + BORDER_COLOR(" │"));
    for (let r = 0; r < grid.length; r++) {
      const cols = r < rowsFullyDone ? width : r === rowsFullyDone ? partialCols : 0;
      lines.push(BORDER_COLOR("│ ") + renderRow(grid[r], cols, LOGO_COLOR) + BORDER_COLOR(" │"));
    }
    lines.push(BORDER_COLOR("│ ") + " ".repeat(width) + BORDER_COLOR(" │"));
    lines.push(bottomBorder);

    readline.cursorTo(process.stdout, 0);
    process.stdout.write(lines.join("\n") + "\n");
    if (frame < grid.length * stepsPerRow) {
      readline.moveCursor(process.stdout, 0, -lines.length);
    }
    await sleep(16); // ~60fps step
  }

  // Typewriter subtitle underneath the framed logo.
  const subtitle = `CLI Version ${version}`;
  process.stdout.write("\n");
  for (let i = 0; i <= subtitle.length; i++) {
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(SUBTITLE_COLOR(subtitle.slice(0, i)));
    await sleep(20);
  }
  process.stdout.write("\n\n");

  process.stdout.write("\x1B[?25h"); // show cursor
}

// Run directly with: npx tsx toolnet-banner.ts
if (false) {
  printToolNetBanner("TOOLNET", "1.0.0");
}

export {
  animateBoot,
  showPrompt,
  colorForCol,
  glitchText,
  renderAsciiFrame,
  ASCII_TOOLNET,
} from "./boot_animation";
