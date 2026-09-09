import { isNoColor } from "../term";
import { padVisible, visibleWidth } from "../tui/layout";
import { getVersion } from "../lib/version";

export type BannerPhase = "core" | "portal" | "connections" | "pulse" | "wordmark" | "final";

export interface BannerAnimation {
  startedAt: number;
  phase: BannerPhase;
}

export interface BannerPlayContext {
  cols: number;
  rows: number;
  getSize?: () => { cols: number; rows: number };
  write: (value: string, flush?: boolean) => void;
}

export interface BannerPlayOptions {
  noColor?: boolean;
  animate?: boolean;
  inPlace?: boolean;
  signal?: AbortSignal;
  now?: () => number;
  frameMs?: number;
}

export const B2_TIMELINE: Record<BannerPhase, number> = {
  core: 180,
  portal: 400,
  connections: 600,
  pulse: 760,
  wordmark: 1050,
  final: 1200,
};

export const B2_COLORS = {
  cyan: "\x1b[38;2;56;189;248m",
  blue: "\x1b[38;2;96;165;250m",
  violet: "\x1b[38;2;167;139;250m",
  muted: "\x1b[38;2;148;163;184m",
  white: "\x1b[38;2;226;232;240m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
} as const;

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";
const cursorAt = (row: number, col = 1): string => `\x1b[${Math.max(1, row)};${Math.max(1, col)}H`;

const FULL_SYMBOL = [
  "╭──╮       ╭──╮",
  "│  ╰──┐ ┌──╯  │",
  "│     │ │     │",
  "│     ╰◇╯     │",
  "│      │      │",
  "╰──┐   │   ┌──╯",
  "  ╰───┴───╯   ",
].map((line) => padVisible(line, 15));

const COMPACT_SYMBOL = [
  "╭─╮ ╭─╮",
  "│ ╰◇╯ │",
  "╰─┬─┬─╯",
].map((line) => padVisible(line, 9));

const LETTERS: Record<string, string[]> = {
  T: ["┬─┬", " │ ", " │ ", " ╵ "],
  O: ["╭─╮", "│ │", "│ │", "╰─╯"],
  L: ["╽  ", "╽  ", "╽  ", "└─╴"],
  N: ["╲ ╱", "│╳│", "│ │", "╵ ╵"],
  E: ["┌─╴", "├─╴", "│  ", "└─╴"],
};
const WORD = "TOOLNET";
const WORD_TONES = ["cyan", "cyan", "blue", "blue", "cyan", "blue", "cyan"] as const;
const WORD_GAP = " ";

function toneCode(tone: keyof typeof B2_COLORS, noColor: boolean): string {
  return noColor ? "" : B2_COLORS[tone];
}

function paint(value: string, tone: keyof typeof B2_COLORS, noColor: boolean, bold = false): string {
  if (noColor || value.length === 0) return value;
  return `${bold ? B2_COLORS.bold : ""}${B2_COLORS[tone]}${value}${B2_COLORS.reset}`;
}

function center(value: string, cols: number): string {
  return " ".repeat(Math.max(0, Math.floor((cols - visibleWidth(value)) / 2))) + value;
}

function wordRow(row: number, revealCells: number | null, noColor: boolean): string {
  let plain = "";
  let styled = "";
  let cell = 0;
  for (let index = 0; index < WORD.length; index++) {
    const glyphs = LETTERS[WORD[index]][row];
    const tone = WORD_TONES[index];
    for (const glyph of Array.from(glyphs)) {
      const shown = revealCells === null || cell < revealCells;
      plain += shown ? glyph : " ";
      styled += shown ? paint(glyph, tone, noColor, true) : " ";
      cell += 1;
    }
    if (index < WORD.length - 1) {
      const shown = revealCells === null || cell < revealCells;
      plain += shown ? WORD_GAP : " ";
      styled += shown ? paint(WORD_GAP, "muted", noColor) : " ";
      cell += 1;
    }
  }
  return padVisible(styled, 27);
}

function symbolRow(shape: string, row: number, progress: number, noColor: boolean, pulse: boolean): string {
  const chars = Array.from(shape);
  const centerCell = Math.floor(chars.length / 2);
  let radius = 0;
  if (progress > 0.15 && progress < 0.4) {
    radius = ((progress - 0.15) / 0.25) * 4;
  } else if (progress >= 0.4 && progress < 0.6) {
    radius = 4 + ((progress - 0.4) / 0.2) * 3;
  } else if (progress >= 0.6) {
    radius = centerCell;
  }

  const visible = chars.map((char, index) => {
    if (char === " ") return " ";
    if (progress <= 0.15) return char === "◇" ? char : " ";
    return Math.abs(index - centerCell) <= radius ? char : " ";
  }).join("");
  const tone = pulse && row === 3 ? "violet" : row % 2 === 0 ? "cyan" : "blue";
  return paint(visible, tone, noColor, pulse && row === 3);
}

function phaseAt(elapsed: number): BannerPhase {
  if (elapsed < B2_TIMELINE.core) return "core";
  if (elapsed < B2_TIMELINE.portal) return "portal";
  if (elapsed < B2_TIMELINE.connections) return "connections";
  if (elapsed < B2_TIMELINE.pulse) return "pulse";
  if (elapsed < B2_TIMELINE.wordmark) return "wordmark";
  return "final";
}

function phaseProgress(elapsed: number, start: number, end: number): number {
  return Math.max(0, Math.min(1, (elapsed - start) / (end - start)));
}

function symbolProgress(elapsed: number): number {
  if (elapsed < B2_TIMELINE.core) return 0;
  if (elapsed < B2_TIMELINE.portal) return 0.15 + phaseProgress(elapsed, B2_TIMELINE.core, B2_TIMELINE.portal) * 0.25;
  return Math.min(1, 0.4 + phaseProgress(elapsed, B2_TIMELINE.portal, B2_TIMELINE.connections) * 0.6);
}

function renderedLines(cols: number, elapsed: number, noColor: boolean): string[] {
  const compact = cols < 80;
  const symbol = compact ? COMPACT_SYMBOL : FULL_SYMBOL;
  const progress = Math.max(0, Math.min(1, elapsed / B2_TIMELINE.final));
  const phase = phaseAt(elapsed);
  const pulse = phase === "pulse";
  const lines: string[] = [];

  if (compact) {
    const wordReveal = phase === "final" ? null : phase === "wordmark" ? Math.floor(progress * 27) : 0;
    const symbolProgressValue = phase === "final" ? 1 : symbolProgress(elapsed);
    const lockupWidth = 9 + 2 + 27;
    const left = Math.max(0, Math.floor((cols - lockupWidth) / 2));
    for (let row = 0; row < 3; row++) {
      const leftMark = symbolRow(symbol[row], row, symbolProgressValue, noColor, pulse);
      lines.push(" ".repeat(left) + leftMark + "  " + wordRow(row, wordReveal, noColor));
    }
    const tagline = phase === "final" || elapsed >= B2_TIMELINE.wordmark ? paint("AI CLI", "muted", noColor) : "     ";
    lines.push(" ".repeat(left + 11) + tagline);
    return lines;
  }

  const wordReveal = phase === "final" ? null : phase === "wordmark" ? Math.floor(phaseProgress(elapsed, B2_TIMELINE.wordmark - 290, B2_TIMELINE.wordmark) * 27) : 0;
  const symbolProgressValue = phase === "final" ? 1 : symbolProgress(elapsed);
  const gap = "   ";
  const lockupWidth = 15 + visibleWidth(gap) + 27;
  const left = Math.max(0, Math.floor((cols - lockupWidth) / 2));
  for (let row = 0; row < FULL_SYMBOL.length; row++) {
    const mark = symbolRow(FULL_SYMBOL[row], row, symbolProgressValue, noColor, pulse);
    const right = row >= 1 && row <= 4
      ? wordRow(row - 1, wordReveal, noColor)
      : row === 5 && (phase === "final" || elapsed >= B2_TIMELINE.wordmark)
        ? paint("AI CODING CLI", "muted", noColor)
        : "";
    lines.push(" ".repeat(left) + mark + gap + right);
  }
  return lines;
}

export function renderB2Banner(cols: number, elapsed = B2_TIMELINE.final, noColor = isNoColor()): string[] {
  const safeCols = Math.max(1, cols);
  return renderedLines(safeCols, Math.max(0, elapsed), noColor);
}

export function b2BannerMetrics(cols: number): { width: number; height: number } {
  const lines = renderB2Banner(cols, B2_TIMELINE.final, true);
  return {
    width: lines.reduce((max, line) => Math.max(max, visibleWidth(line.trimEnd())), 0),
    height: lines.length,
  };
}

function drawFrame(ctx: BannerPlayContext, topRow: number, elapsed: number, noColor: boolean, inPlace: boolean): void {
  const lines = renderB2Banner(ctx.cols, elapsed, noColor);
  if (!inPlace) {
    ctx.write(lines.join("\n") + "\n", true);
    return;
  }
  const output = lines.map((line, index) => cursorAt(topRow + index) + CLEAR_LINE + line).join("");
  ctx.write(output, true);
}

export async function playB2Banner(
  ctx: BannerPlayContext,
  options: BannerPlayOptions = {},
): Promise<void> {
  if (ctx.cols <= 0 || ctx.rows <= 0) return;
  const noColor = options.noColor ?? isNoColor();
  const animate = options.animate ?? process.env.TOOLNETCLI_ANIMATIONS !== "0";
  const inPlace = options.inPlace ?? true;
  const now = options.now ?? (() => performance.now());
  const size = () => {
    const current = ctx.getSize?.() ?? { cols: ctx.cols, rows: ctx.rows };
    return { cols: Math.max(1, current.cols), rows: Math.max(1, current.rows) };
  };
  const initialSize = size();
  const topRow = (height: number, rows: number) => Math.max(1, Math.floor((rows - height) / 2) + 1);
  const finalHeight = renderB2Banner(initialSize.cols, B2_TIMELINE.final, noColor).length;

  if (!animate) {
    const current = size();
    drawFrame({ ...ctx, cols: current.cols }, topRow(finalHeight, current.rows), B2_TIMELINE.final, noColor, inPlace);
    return;
  }

  ctx.write(HIDE_CURSOR, true);
  try {
    const animation: BannerAnimation = { startedAt: now(), phase: "core" };
    const initial = size();
    drawFrame({ ...ctx, cols: initial.cols }, topRow(renderB2Banner(initial.cols, 0, noColor).length, initial.rows), 0, noColor, inPlace);
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setInterval> | null = null;
      const finish = (error?: unknown) => {
        if (timer !== null) clearInterval(timer);
        timer = null;
        options.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(new Error("Banner animation aborted"));
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const tick = () => {
        const elapsed = now() - animation.startedAt;
        animation.phase = phaseAt(elapsed);
        const current = size();
        const currentContext = { ...ctx, cols: current.cols, rows: current.rows };
        const currentTop = topRow(renderB2Banner(current.cols, elapsed, noColor).length, current.rows);
        if (elapsed >= B2_TIMELINE.final) {
          drawFrame(currentContext, currentTop, B2_TIMELINE.final, noColor, inPlace);
          finish();
          return;
        }
        drawFrame(currentContext, currentTop, elapsed, noColor, inPlace);
      };
      timer = setInterval(tick, options.frameMs ?? 33);
      tick();
    });
  } finally {
    const current = size();
    ctx.write(SHOW_CURSOR + cursorAt(topRow(renderB2Banner(current.cols, B2_TIMELINE.final, noColor).length, current.rows) + renderB2Banner(current.cols, B2_TIMELINE.final, noColor).length), true);
  }
}

export function printToolNetBanner(version = getVersion()): Promise<void> {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  return playB2Banner({ cols, rows, write: (value) => process.stdout.write(value) }, {
    animate: process.stdout.isTTY === true && process.env.TOOLNETCLI_ANIMATIONS !== "0",
    inPlace: process.stdout.isTTY === true,
    noColor: isNoColor(),
  });
}

export function bannerLineWidths(cols: number, elapsed = B2_TIMELINE.final, noColor = true): number[] {
  return renderB2Banner(cols, elapsed, noColor).map(visibleWidth);
}

export const b2BrandMark = FULL_SYMBOL;
export const b2CompactBrandMark = COMPACT_SYMBOL;
export { toneCode };
