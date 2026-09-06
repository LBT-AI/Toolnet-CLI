#!/usr/bin/env node
/**
 * ToolNet CLI - Boot Animation & Interactive Prompt (TypeScript / Node / Bun)
 * Hiệu ứng: ASCII scan, neon corners, glitch text, gradient blocks, interactive prompt
 *
 * Usage:
 *   npx tsx boot_animation.ts
 *   bun boot_animation.ts
 */

import chalk from "chalk";
import readline from "node:readline";
import stringWidth from "string-width";

// === CONFIG & COLORS ===
export const PINK = chalk.hex("#e879f9");
export const BLUE = chalk.hex("#3b82f6");
export const CYAN = chalk.hex("#67e8f9");
export const PURPLE = chalk.hex("#a855f7");
export const MAGENTA = chalk.hex("#d946ef");
export const HIGHLIGHT = chalk.black.bgHex("#0ea5e9");
export const GREEN = chalk.hex("#22c55e");
export const GRAY = chalk.hex("#9ca3af");
export const DARK_BORDER = chalk.hex("#333333");

// TOOLNET ASCII 8x7 blocks per letter, 7 letters = 49 cols + spacing
export const ASCII_TOOLNET = [
  "  TTTTT   OOOOO   OOOOO   L       N   N   EEEEE   TTTTT  ",
  "    T    O     O O     O  L       NN  N   E         T    ",
  "    T    O     O O     O  L       N N N   EEEE      T    ",
  "    T    O     O O     O  L       N  NN   E         T    ",
  "    T    O     O O     O  L       N  NN   E         T    ",
  "    T     OOOOO   OOOOO   LLLLL   N   N   EEEEE     T    ",
];

export const GLITCH_CHARS = ["█", "▓", "▒", "░", "▚", "▞"];
export const GLITCH_BLOCKS = ["█", "▓", "▒", "▚"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Gradient across width: pink -> purple -> blue -> cyan */
export function colorForCol(colIdx: number, total: number): (s: string) => string {
  const ratio = colIdx / Math.max(total - 1, 1);
  if (ratio < 0.25) return PINK;
  if (ratio < 0.50) return PURPLE;
  if (ratio < 0.75) return BLUE;
  return CYAN;
}

/** Center text within a given visual width, accounting for ANSI codes */
export function center(text: string, width: number): string {
  const visibleLen = stringWidth(text);
  if (visibleLen >= width) return text;
  const leftPad = Math.floor((width - visibleLen) / 2);
  const rightPad = width - visibleLen - leftPad;
  return " ".repeat(leftPad) + text + " ".repeat(rightPad);
}

/** Add glitch offset characters to text */
export function glitchText(text: string, intensity = 3): string {
  let result = "";
  for (const ch of text) {
    if (ch === " ") {
      result += " ";
      continue;
    }
    if (Math.random() < 0.15 && intensity > 0) {
      const offsetCh = GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)];
      const offsetColor = Math.random() < 0.5 ? BLUE : PURPLE;
      result += offsetColor(offsetCh) + PINK.bold(ch);
    } else {
      result += PINK.bold(ch);
    }
  }
  return result;
}

/** Render ASCII art with pixel-reveal progress (0.0 -> 1.0) */
export function renderAsciiFrame(progress: number): string[] {
  const totalCols = ASCII_TOOLNET[0].length;
  const revealCol = Math.floor(totalCols * progress);
  const rows: string[] = [];

  for (const row of ASCII_TOOLNET) {
    let line = "";
    for (let colIdx = 0; colIdx < row.length; colIdx++) {
      const ch = row[colIdx];
      if (colIdx > revealCol || ch === " ") {
        line += " ";
      } else {
        const block = Math.random() < 0.08
          ? GLITCH_BLOCKS[Math.floor(Math.random() * GLITCH_BLOCKS.length)]
          : "█";
        const color = colorForCol(colIdx, totalCols);
        line += color(block);
      }
    }
    rows.push(line);
  }
  return rows;
}

/** Show the folder trust prompt like GitHub Copilot CLI */
export async function showPrompt(options: { cwd?: string; interactive?: boolean } = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY && options.interactive !== false);

  console.log();
  const pathLabel = `  ${cwd}  `;
  const pWidth = stringWidth(pathLabel);
  console.log(DARK_BORDER("┌" + "─".repeat(pWidth) + "┐"));
  console.log(DARK_BORDER("│") + GRAY(pathLabel) + DARK_BORDER("│"));
  console.log(DARK_BORDER("└" + "─".repeat(pWidth) + "┘"));
  console.log();

  console.log(
    chalk.white(
      "ToolNet can read files in this folder and, with your permission,\n" +
      "edit them or run code and shell commands. It will remember\n" +
      "your permissions for the rest of this session.\n\n" +
      "Do you trust the files in this folder?"
    )
  );
  console.log();

  const choices = [
    "1. Yes",
    "2. Yes, and remember this folder for future sessions",
    "3. No (Esc)",
  ];

  if (!isTty) {
    for (let i = 0; i < choices.length; i++) {
      if (i === 0) {
        console.log(HIGHLIGHT(`> ${choices[i]}`));
      } else {
        console.log(`  ${choices[i]}`);
      }
    }
    console.log();
    console.log(chalk.dim("↑/↓ to navigate · enter to select · esc to cancel"));
    console.log();
    await sleep(200);
    console.log(GREEN.bold("✓ Trusted. ToolNet is ready."));
    return 0;
  }

  return new Promise<number>((resolve) => {
    let selected = 0;
    const linesCount = choices.length + 2;

    function renderChoices(first = false) {
      if (!first) {
        readline.moveCursor(process.stdout, 0, -linesCount);
      }
      for (let i = 0; i < choices.length; i++) {
        readline.cursorTo(process.stdout, 0);
        process.stdout.write("\x1B[2K");
        if (i === selected) {
          process.stdout.write(HIGHLIGHT(`> ${choices[i]}`) + "\n");
        } else {
          process.stdout.write(`  ${choices[i]}\n`);
        }
      }
      readline.cursorTo(process.stdout, 0);
      process.stdout.write("\x1B[2K\n");
      readline.cursorTo(process.stdout, 0);
      process.stdout.write("\x1B[2K" + chalk.dim("↑/↓ to navigate · enter to select · esc to cancel"));
    }

    renderChoices(true);

    const rl = readline.createInterface({ input: process.stdin, escapeCodeTimeout: 50 });
    readline.emitKeypressEvents(process.stdin, rl);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    function cleanup() {
      process.stdin.removeListener("keypress", onKeypress);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      rl.close();
    }

    function onKeypress(_str: string, key: readline.Key) {
      if (key.name === "up" || key.name === "k") {
        selected = (selected - 1 + choices.length) % choices.length;
        renderChoices();
      } else if (key.name === "down" || key.name === "j") {
        selected = (selected + 1) % choices.length;
        renderChoices();
      } else if (key.name === "1") {
        selected = 0;
        renderChoices();
      } else if (key.name === "2") {
        selected = 1;
        renderChoices();
      } else if (key.name === "3") {
        selected = 2;
        renderChoices();
      } else if (key.name === "return" || key.name === "enter") {
        cleanup();
        console.log("\n");
        if (selected === 2) {
          console.log(chalk.red("Aborted."));
          process.exit(1);
        } else {
          console.log(GREEN.bold("✓ Trusted. ToolNet is ready."));
          resolve(selected);
        }
      } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup();
        console.log("\n");
        console.log(chalk.red("Aborted."));
        process.exit(1);
      }
    }

    process.stdin.on("keypress", onKeypress);
  });
}

/** Main boot animation sequence */
export async function animateBoot(options: {
  interactive?: boolean;
  cwd?: string;
  version?: string;
} = {}): Promise<void> {
  const version = options.version ?? "1.0.0";
  const frameWidth = 59;
  const cornerTop = MAGENTA("┌" + "─".repeat(frameWidth) + "┐");
  const cornerBot = MAGENTA("└" + "─".repeat(frameWidth) + "┘");
  const versionLine = PURPLE.dim(`CLI Version ${version}`);

  process.stdout.write("\x1B[?25l"); // hide cursor

  // Phase 1: Build ASCII with scan (55 frames)
  let lastLinesCount = 0;
  for (let frame = 0; frame < 55; frame++) {
    const progress = frame / 54;
    const asciiRows = renderAsciiFrame(progress);
    const welcome = glitchText("Welcome to ToolNet", 3);

    const lines: string[] = [];
    lines.push(cornerTop);
    lines.push(center(welcome, frameWidth));
    lines.push("");

    const scanIdx = Math.floor(asciiRows.length * progress);
    for (let i = 0; i < asciiRows.length; i++) {
      if (i === scanIdx) {
        lines.push(MAGENTA("─".repeat(frameWidth)));
      } else {
        lines.push(center(asciiRows[i], frameWidth));
      }
    }

    lines.push("");
    lines.push(center(versionLine, frameWidth));
    lines.push(cornerBot);

    if (frame > 0) {
      readline.moveCursor(process.stdout, 0, -lastLinesCount);
    }
    for (const line of lines) {
      readline.cursorTo(process.stdout, 0);
      process.stdout.write("\x1B[2K" + line + "\n");
    }
    lastLinesCount = lines.length;

    await sleep(40 + Math.random() * 20); // slight jitter
  }

  // Phase 2: Hold with subtle glitch flicker (20 frames)
  for (let frame = 0; frame < 20; frame++) {
    const asciiRows = renderAsciiFrame(1.0);
    const welcome = glitchText("Welcome to ToolNet", 2);

    const lines: string[] = [];
    lines.push(cornerTop);
    lines.push(center(welcome, frameWidth));
    lines.push("");
    for (const row of asciiRows) {
      lines.push(center(row, frameWidth));
    }
    lines.push("");
    lines.push(center(versionLine, frameWidth));
    lines.push(cornerBot);

    readline.moveCursor(process.stdout, 0, -lastLinesCount);
    for (const line of lines) {
      readline.cursorTo(process.stdout, 0);
      process.stdout.write("\x1B[2K" + line + "\n");
    }
    lastLinesCount = lines.length;

    await sleep(80);
  }

  process.stdout.write("\x1B[?25h"); // show cursor

  // Phase 3: Prompt
  await showPrompt({ cwd: options.cwd, interactive: options.interactive });
}

// Auto-run when executed directly via bun or node/tsx
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  (typeof (import.meta as any).main === "boolean" && (import.meta as any).main) ||
  (process.argv[1] && process.argv[1].endsWith("boot_animation.ts"));

if (isDirectRun) {
  animateBoot().catch((err) => {
    process.stdout.write("\x1B[?25h");
    console.error("\nAborted.", err);
    process.exit(1);
  });
}
