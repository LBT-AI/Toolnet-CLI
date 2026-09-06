#!/usr/bin/env node
/**
 * ToolNet CLI - Boot Animation & Interactive Prompt
 * TypeScript version with chalk + log-update + ansi-escapes
 * 
 * Setup:
 *   npm install chalk log-update ansi-escapes
 *   npx tsx toolnet-cli.ts
 * 
 * Or compile:
 *   tsc toolnet-cli.ts --esModuleInterop --module commonjs --target es2020
 *   node toolnet-cli.js
 */

import chalk from "chalk";
import logUpdate from "log-update";
import ansiEscapes from "ansi-escapes";
import * as readline from "readline";
import stringWidth from "string-width";

// === COLOR PALETTE ===
export const C = {
  pink: "#e879f9",
  blue: "#3b82f6",
  cyan: "#67e8f9",
  purple: "#a855f7",
  magenta: "#d946ef",
  gray: "#9ca3af",
  dim: "#6b7280",
  white: "#ffffff",
  black: "#000000",
  highlight: "#0ea5e9",
  border: "#333333",
} as const;

// === ASCII ART: TOOLNET ===
export const ASCII_TOOLNET: string[] = [
  "  TTTTT   OOOOO   OOOOO   L       N   N   EEEEE   TTTTT  ",
  "    T    O     O O     O  L       NN  N   E         T    ",
  "    T    O     O O     O  L       N N N   EEEE      T    ",
  "    T    O     O O     O  L       N  NN   E         T    ",
  "    T    O     O O     O  L       N  NN   E         T    ",
  "    T     OOOOO   OOOOO   LLLLL   N   N   EEEEE     T    ",
];

const FRAME_WIDTH = 58;

// === UTILS ===

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

export function colorForCol(colIdx: number, total: number): string {
  const ratio = colIdx / Math.max(total - 1, 1);
  if (ratio < 0.25) return C.pink;
  if (ratio < 0.5) return C.purple;
  if (ratio < 0.75) return C.blue;
  return C.cyan;
}

export function glitchChar(): string {
  const blocks = ["█", "▓", "▒", "░", "▚", "▞", "▙", "▛"];
  return blocks[Math.floor(Math.random() * blocks.length)];
}

export function glitchColor(): string {
  const colors = [C.blue, C.purple, C.magenta];
  return colors[Math.floor(Math.random() * colors.length)];
}

export function renderAsciiFrame(progress: number, intensity: number = 1): string {
  const totalCols = ASCII_TOOLNET[0].length;
  const revealCol = Math.floor(totalCols * progress);
  const lines: string[] = [];

  for (const row of ASCII_TOOLNET) {
    let line = "";
    for (let colIdx = 0; colIdx < row.length; colIdx++) {
      const ch = row[colIdx];
      if (colIdx > revealCol || ch === " ") {
        line += " ";
      } else {
        const color = colorForCol(colIdx, totalCols);
        if (Math.random() < 0.08 * intensity) {
          line += chalk.hex(glitchColor())(glitchChar());
        } else {
          line += chalk.hex(color).bold("█");
        }
      }
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export function glitchText(text: string, intensity: number = 3): string {
  let result = "";
  for (const ch of text) {
    if (ch === " ") {
      result += " ";
      continue;
    }
    if (Math.random() < 0.15 && intensity > 0) {
      result += chalk.hex(glitchColor())(glitchChar());
      result += chalk.hex(C.pink).bold(ch);
    } else {
      result += chalk.hex(C.pink).bold(ch);
    }
  }
  return result;
}

export function center(text: string, width: number = FRAME_WIDTH): string {
  const visibleLen = stringWidth(text);
  const pad = Math.max(0, width - visibleLen);
  const left = Math.floor(pad / 2);
  return " ".repeat(left) + text + " ".repeat(pad - left);
}

export function cornerTop(): string {
  return chalk.hex(C.magenta)("┌" + "─".repeat(FRAME_WIDTH) + "┐");
}

export function cornerBot(): string {
  return chalk.hex(C.magenta)("└" + "─".repeat(FRAME_WIDTH) + "┘");
}

// === ANIMATION ===

export async function animateBoot(options: { version?: string; cwd?: string; interactive?: boolean } = {}): Promise<void> {
  process.stdout.write(ansiEscapes.clearScreen);

  const versionText = chalk.hex(C.purple).dim(`CLI Version ${options.version ?? "1.0.0"}`);

  // Phase 1: Build ASCII with scan effect
  for (let frame = 0; frame <= 54; frame++) {
    const progress = frame / 54;
    const asciiArt = renderAsciiFrame(progress);
    const asciiLines = asciiArt.split("\n");
    const scanIdx = Math.floor(asciiLines.length * progress);

    const lines: string[] = [];
    lines.push(cornerTop());
    lines.push(center(glitchText("Welcome to ToolNet", 2)));
    lines.push("");

    for (let i = 0; i < asciiLines.length; i++) {
      if (i === scanIdx) {
        lines.push(chalk.hex(C.magenta)("─".repeat(FRAME_WIDTH)));
      } else {
        lines.push(center(asciiLines[i]));
      }
    }

    lines.push("");
    lines.push(center(versionText));
    lines.push(cornerBot());

    logUpdate(lines.join("\n"));
    await sleep(rand(30, 60));
  }

  // Phase 2: Hold with subtle glitch flicker
  for (let i = 0; i < 20; i++) {
    const asciiArt = renderAsciiFrame(1.0, 0.5);
    const lines: string[] = [];
    lines.push(cornerTop());
    lines.push(center(glitchText("Welcome to ToolNet", 1)));
    lines.push("");
    for (const aline of asciiArt.split("\n")) {
      lines.push(center(aline));
    }
    lines.push("");
    lines.push(center(versionText));
    lines.push(cornerBot());

    logUpdate(lines.join("\n"));
    await sleep(80);
  }

  logUpdate.done();

  // Phase 3: Prompt
  await showPrompt(options);
}

// === PROMPT ===

export interface PromptOption {
  label: string;
  value: string;
}

export const OPTIONS: PromptOption[] = [
  { label: "Yes", value: "yes" },
  { label: "Yes, and remember this folder for future sessions", value: "yes_remember" },
  { label: "No (Esc)", value: "no" },
];

export async function showPrompt(options: { cwd?: string; interactive?: boolean } = {}): Promise<string> {
  console.log();

  // Path box
  const cwd = options.cwd ?? process.cwd();
  const pathText = cwd.length > 30 ? cwd.slice(0, 27) + "..." : cwd;
  const pWidth = pathText.length + 2;
  const pathBox = chalk.hex(C.gray)(pathText);
  console.log(chalk.hex(C.border)("┌" + "─".repeat(pWidth) + "┐"));
  console.log(chalk.hex(C.border)("│ ") + pathBox + chalk.hex(C.border)(" │"));
  console.log(chalk.hex(C.border)("└" + "─".repeat(pWidth) + "┘"));
  console.log();

  // Description
  console.log(
    chalk.white(
      "ToolNet can read files in this folder and, with your permission,\n" +
        "edit them or run code and shell commands. It will remember\n" +
        "your permissions for the rest of this session.\n\n" +
        "Do you trust the files in this folder?"
    )
  );
  console.log();

  let activeIdx = 0;

  const renderOptions = (first = false) => {
    if (!first) {
      readline.moveCursor(process.stdout, 0, -(OPTIONS.length + 2));
      readline.clearScreenDown(process.stdout);
    }

    for (let i = 0; i < OPTIONS.length; i++) {
      const opt = OPTIONS[i];
      const num = i + 1;
      if (i === activeIdx) {
        console.log(
          chalk.bgHex(C.highlight).black(`> ${num}. ${opt.label}`)
        );
      } else {
        console.log(`  ${num}. ${opt.label}`);
      }
    }
    console.log();
    console.log(chalk.hex(C.dim)("↑/↓ to navigate · enter to select · esc to cancel"));
  };

  renderOptions(true);

  const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY && options.interactive !== false);

  if (!isTty) {
    await sleep(200);
    console.log(chalk.green("\n✓ Trusted. ToolNet is ready."));
    return OPTIONS[0].value;
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    const onKeypress = (_str: string, key: readline.Key) => {
      if (key.name === "up" || key.name === "k") {
        activeIdx = (activeIdx - 1 + OPTIONS.length) % OPTIONS.length;
        renderOptions();
      } else if (key.name === "down" || key.name === "j") {
        activeIdx = (activeIdx + 1) % OPTIONS.length;
        renderOptions();
      } else if (key.name === "1") {
        activeIdx = 0;
        renderOptions();
      } else if (key.name === "2") {
        activeIdx = 1;
        renderOptions();
      } else if (key.name === "3") {
        activeIdx = 2;
        renderOptions();
      } else if (key.name === "return" || key.name === "enter") {
        cleanup();
        const choice = OPTIONS[activeIdx].value;
        if (choice === "no") {
          console.log(chalk.red("\n✗ Cancelled."));
          process.exit(1);
        } else {
          console.log(chalk.green("\n✓ Trusted. ToolNet is ready."));
          resolve(choice);
        }
      } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup();
        console.log(chalk.red("\n✗ Cancelled."));
        process.exit(1);
      }
    };

    const cleanup = () => {
      process.stdin.removeListener("keypress", onKeypress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      rl.close();
    };

    process.stdin.on("keypress", onKeypress);
  });
}

// === MAIN ===

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  (typeof (import.meta as any).main === "boolean" && (import.meta as any).main) ||
  (process.argv[1] && process.argv[1].endsWith("toolnet-cli.ts"));

if (isDirectRun) {
  (async () => {
    try {
      await animateBoot();
      process.exit(0);
    } catch (err) {
      console.error(chalk.red("\nError:"), err);
      process.exit(1);
    }
  })();
}
