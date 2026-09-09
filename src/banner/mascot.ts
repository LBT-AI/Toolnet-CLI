import { isNoColor } from "../term";
import { padVisible, visibleWidth } from "../tui/layout";
import { MASCOT_SOURCE_HEIGHT, MASCOT_SOURCE_ROWS, MASCOT_SOURCE_WIDTH, type MascotPixel } from "./mascotAsset";
import { buildPalette, mix } from "./renderer";
import type { BannerStep } from "./types";

export type MascotPhase = "materialize" | "blink" | "gesture" | "pulse" | "sparkle" | "idle";

export interface MascotPlayContext {
  cols: number;
  rows: number;
  getSize?: () => { cols: number; rows: number };
  write: (value: string, flush?: boolean) => void;
}

export interface MascotPlayOptions {
  noColor?: boolean;
  animate?: boolean;
  inPlace?: boolean;
  signal?: AbortSignal;
  now?: () => number;
  frameMs?: number;
}

export const MASCOT_TIMELINE = {
  materialize: 260,
  blink: 460,
  gesture: 650,
  pulse: 820,
  sparkle: 1040,
  final: 1200,
} as const;

export const MASCOT_COLORS = {
  b: "#38BDF8",
  s: "#1E3A5F",
  f: "#E2E8F0",
  d: "#071A2F",
  k: "#A78BFA",
  h: "#7DD3FC",
  y: "#FDE047",
} as const;

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";
const cursorAt = (row: number, col = 1): string => `\x1b[${Math.max(1, row)};${Math.max(1, col)}H`;
const BRAND = "#071A2F";
const DARK = "#061326";

/** Replace selected source pixels without changing the raster dimensions. */
function replacePixels(rows: readonly string[], predicate: (pixel: MascotPixel, row: number, column: number) => MascotPixel): string[] {
  return rows.map((line, row) => Array.from(line, (pixel, column) => predicate(pixel as MascotPixel, row, column)).join(""));
}

const MASCOT_BLINK_SOURCE = replacePixels(MASCOT_SOURCE_ROWS, (pixel) => pixel === "d" ? "f" : pixel);
const MASCOT_GESTURE_SOURCE = replacePixels(MASCOT_SOURCE_ROWS, (pixel, row, column) => {
  if (row === 19 && (column === 0 || column === MASCOT_SOURCE_WIDTH - 1)) return "h";
  return pixel;
});
const MASCOT_SPARKLE_LEFT_SOURCE = replacePixels(MASCOT_SOURCE_ROWS, (pixel, row, column) => {
  if (row === 3 && column === 1) return "y";
  if (row === 8 && column === 0) return "y";
  return pixel;
});
const MASCOT_SPARKLE_RIGHT_SOURCE = replacePixels(MASCOT_SOURCE_ROWS, (pixel, row, column) => {
  if (row === 3 && column === MASCOT_SOURCE_WIDTH - 2) return "y";
  if (row === 8 && column === MASCOT_SOURCE_WIDTH - 1) return "y";
  return pixel;
});

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function progressOf(elapsed: number, start: number, end: number): number {
  return clamp01((elapsed - start) / Math.max(1, end - start));
}

function easeOutCubic(value: number): number {
  return 1 - Math.pow(1 - clamp01(value), 3);
}

function phaseAt(elapsed: number): MascotPhase {
  if (elapsed < MASCOT_TIMELINE.materialize) return "materialize";
  if (elapsed < MASCOT_TIMELINE.blink) return "blink";
  if (elapsed < MASCOT_TIMELINE.gesture) return "gesture";
  if (elapsed < MASCOT_TIMELINE.pulse) return "pulse";
  if (elapsed < MASCOT_TIMELINE.sparkle) return "sparkle";
  return "idle";
}

/** Resize the raster by nearest-neighbor while preserving its aspect ratio. */
function resizeRows(rows: readonly string[], width: number): string[] {
  const targetWidth = Math.max(1, Math.min(width, MASCOT_SOURCE_WIDTH));
  const targetHeight = Math.max(1, Math.round(MASCOT_SOURCE_HEIGHT * targetWidth / MASCOT_SOURCE_WIDTH));
  return Array.from({ length: targetHeight }, (_, targetRow) => {
    const sourceRow = Math.min(rows.length - 1, Math.floor(targetRow * rows.length / targetHeight));
    return Array.from({ length: targetWidth }, (_, targetColumn) => {
      const sourceColumn = Math.min(MASCOT_SOURCE_WIDTH - 1, Math.floor(targetColumn * MASCOT_SOURCE_WIDTH / targetWidth));
      return rows[sourceRow]?.[sourceColumn] ?? ".";
    }).join("");
  });
}

function revealFromCenter(rows: readonly string[], progress: number): string[] {
  const radius = Math.ceil((rows[0]?.length ?? 0) * easeOutCubic(progress) / 2);
  const center = Math.floor((rows[0]?.length ?? 0) / 2);
  return rows.map((row) => Array.from(row, (pixel, column) => {
    if (pixel === ".") return ".";
    return Math.abs(column - center) <= radius ? pixel : ".";
  }).join(""));
}

function sourceForPhase(phase: MascotPhase): readonly string[] {
  if (phase === "blink") return MASCOT_BLINK_SOURCE;
  if (phase === "gesture") return MASCOT_GESTURE_SOURCE;
  if (phase === "sparkle") return MASCOT_SPARKLE_LEFT_SOURCE;
  return MASCOT_SOURCE_ROWS;
}

function spriteRows(width: number, elapsed: number): string[] {
  const phase = phaseAt(elapsed);
  const resized = resizeRows(sourceForPhase(phase), width);
  if (phase === "materialize") return revealFromCenter(resized, progressOf(elapsed, 0, MASCOT_TIMELINE.materialize));
  if (phase === "sparkle" && progressOf(elapsed, MASCOT_TIMELINE.pulse, MASCOT_TIMELINE.sparkle) >= 0.55) {
    return resizeRows(MASCOT_SPARKLE_RIGHT_SOURCE, width);
  }
  return resized;
}

export function mascotTargetWidth(cols: number): number {
  if (cols >= 80) return 28;
  if (cols >= 60) return 24;
  if (cols >= 50) return 22;
  return 20;
}

function mascotStep(cols: number, elapsed: number): BannerStep {
  const phase = phaseAt(elapsed);
  const width = mascotTargetWidth(cols);
  const pulse = phase === "pulse";
  const opacity = phase === "materialize"
    ? 0.65 + easeOutCubic(progressOf(elapsed, 0, MASCOT_TIMELINE.materialize)) * 0.35
    : 1;
  const sparkleOpacity = phase === "sparkle"
    ? 1 - progressOf(elapsed, MASCOT_TIMELINE.pulse, MASCOT_TIMELINE.sparkle) * 0.7
    : 1;
  const rows = spriteRows(width, Math.max(0, elapsed));
  if (rows.length % 2 !== 0) rows.push(".".repeat(width));
  return {
    rows,
    durationMs: 33,
    opacity: pulse ? 1 : opacity,
    shade: pulse ? 0 : 0.05,
    sparkleOpacity,
    columnFades: null,
  };
}

function centerLine(value: string, cols: number): string {
  return " ".repeat(Math.max(0, Math.floor((cols - visibleWidth(value)) / 2))) + value;
}

interface SpriteCell {
  glyph: string;
  tone: keyof typeof MASCOT_COLORS | null;
}

function spriteCells(rows: string[]): SpriteCell[][] {
  const output: SpriteCell[][] = [];
  for (let pair = 0; pair < rows.length; pair += 2) {
    const top = rows[pair] ?? "";
    const bottom = rows[pair + 1] ?? "";
    const line: SpriteCell[] = [];
    for (let column = 0; column < Math.max(top.length, bottom.length); column++) {
      const cells = [top[column], bottom[column]];
      const pixel = cells.includes("d") ? "d"
        : cells.includes("k") ? "k"
        : cells.includes("y") ? "y"
        : cells.includes("h") ? "h"
        : cells.includes("f") ? "f"
        : cells.includes("s") ? "s"
        : cells.includes("b") ? "b"
        : ".";
      if (pixel === ".") line.push({ glyph: " ", tone: null });
      else if (pixel === "d") line.push({ glyph: "@", tone: "d" });
      else if (pixel === "k") line.push({ glyph: "+", tone: "k" });
      else if (pixel === "y") line.push({ glyph: "*", tone: "y" });
      else if (pixel === "h") line.push({ glyph: "=", tone: "h" });
      else if (pixel === "f") line.push({ glyph: "o", tone: "f" });
      else if (pixel === "s") line.push({ glyph: ":", tone: "s" });
      else line.push({ glyph: "#", tone: "b" });
    }
    output.push(line);
  }
  return output;
}

function plainSpriteLines(rows: string[]): string[] {
  return spriteCells(rows).map((line) => line.map((cell) => cell.glyph).join(""));
}

function colorSpriteLines(rows: string[], palette: Record<string, string>): string[] {
  return spriteCells(rows).map((line) => line.map((cell) => {
    if (!cell.tone) return " ";
    const color = palette[cell.tone];
    return `\x1b[38;2;${hexRgb(color)}m${cell.glyph}\x1b[0m`;
  }).join(""));
}

function hexRgb(hex: string): string {
  const value = hex.replace("#", "");
  return `${parseInt(value.slice(0, 2), 16)};${parseInt(value.slice(2, 4), 16)};${parseInt(value.slice(4, 6), 16)}`;
}

function renderMascotLines(cols: number, elapsed: number, noColor: boolean): string[] {
  const safeCols = Math.max(1, cols);
  const step = mascotStep(safeCols, Math.max(0, elapsed));
  const shadedPalette = Object.fromEntries(Object.entries(MASCOT_COLORS).map(([key, value]) => [
    key,
    step.shade > 0 ? mix(value, DARK, step.shade) : value,
  ]));
  const palette = Object.fromEntries(Object.entries(shadedPalette).map(([key, value]) => [
    key,
    mix(BRAND, value, key === "y" ? step.opacity * step.sparkleOpacity : step.opacity),
  ]));
  const sprite = noColor ? plainSpriteLines(step.rows) : colorSpriteLines(step.rows, palette);
  const width = mascotTargetWidth(safeCols);
  const centered = sprite.map((line) => centerLine(padVisible(line, width), safeCols));
  const phase = phaseAt(Math.max(0, elapsed));
  const showText = phase === "idle" || elapsed >= MASCOT_TIMELINE.sparkle;
  const title = showText ? "TOOLNET" : "       ";
  const subtitle = showText ? "AI CODING CLI" : "            ";
  const titleLine = noColor ? title : `\x1b[1m\x1b[38;2;56;189;248m${title}\x1b[0m`;
  const subtitleLine = noColor ? subtitle : `\x1b[38;2;148;163;184m${subtitle}\x1b[0m`;
  centered.push(centerLine(titleLine, safeCols));
  centered.push(centerLine(subtitleLine, safeCols));
  return centered;
}

export function renderMascotBanner(cols: number, elapsed: number = MASCOT_TIMELINE.final, noColor = isNoColor()): string[] {
  return renderMascotLines(Math.max(1, cols), Math.max(0, elapsed), noColor);
}

export function mascotBannerMetrics(cols: number): { width: number; height: number } {
  const lines = renderMascotBanner(cols, MASCOT_TIMELINE.final, true);
  return { width: lines.reduce((max, line) => Math.max(max, visibleWidth(line.trimEnd())), 0), height: lines.length };
}

function drawFrame(ctx: MascotPlayContext, topRow: number, elapsed: number, noColor: boolean, inPlace: boolean): void {
  const lines = renderMascotBanner(ctx.cols, elapsed, noColor);
  if (!inPlace) {
    ctx.write(lines.join("\n") + "\n", true);
    return;
  }
  ctx.write(lines.map((line, index) => cursorAt(topRow + index) + CLEAR_LINE + line).join(""), true);
}

export function canRenderMascot(cols: number, rows: number): boolean {
  return cols >= 40 && rows >= 12;
}

export async function playMascotBanner(ctx: MascotPlayContext, options: MascotPlayOptions = {}): Promise<void> {
  if (ctx.cols <= 0 || ctx.rows <= 0) return;
  const noColor = options.noColor ?? isNoColor();
  const animate = options.animate ?? process.env.TOOLNETCLI_ANIMATIONS !== "0";
  const inPlace = options.inPlace ?? true;
  const now = options.now ?? (() => performance.now());
  const size = () => {
    const current = ctx.getSize?.() ?? { cols: ctx.cols, rows: ctx.rows };
    return { cols: Math.max(1, current.cols), rows: Math.max(1, current.rows) };
  };
  const topRow = (height: number, rows: number) => Math.max(1, Math.floor((rows - height) / 2) + 1);

  if (!animate) {
    const current = size();
    const finalLines = renderMascotBanner(current.cols, MASCOT_TIMELINE.final, noColor);
    drawFrame({ ...ctx, cols: current.cols }, topRow(finalLines.length, current.rows), MASCOT_TIMELINE.final, noColor, inPlace);
    return;
  }

  ctx.write(HIDE_CURSOR, true);
  try {
    const startedAt = now();
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setInterval> | null = null;
      const cleanup = (error?: unknown) => {
        if (timer !== null) clearInterval(timer);
        timer = null;
        options.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => cleanup(new Error("Mascot animation aborted"));
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const tick = () => {
        const elapsed = now() - startedAt;
        const current = size();
        const lines = renderMascotBanner(current.cols, elapsed, noColor);
        drawFrame({ ...ctx, cols: current.cols }, topRow(lines.length, current.rows), elapsed, noColor, inPlace);
        if (elapsed >= MASCOT_TIMELINE.final) cleanup();
      };
      timer = setInterval(tick, options.frameMs ?? 33);
      tick();
    });
  } finally {
    const current = size();
    const lines = renderMascotBanner(current.cols, MASCOT_TIMELINE.final, noColor);
    ctx.write(SHOW_CURSOR + cursorAt(topRow(lines.length, current.rows) + lines.length), true);
  }
}

export function mascotLineWidths(cols: number, elapsed: number = MASCOT_TIMELINE.final, noColor = true): number[] {
  return renderMascotBanner(cols, elapsed, noColor).map(visibleWidth);
}

export function printMascotBanner(): Promise<void> {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  return playMascotBanner({
    cols,
    rows,
    getSize: () => ({ cols: process.stdout.columns ?? cols, rows: process.stdout.rows ?? rows }),
    write: (value) => process.stdout.write(value),
  }, {
    animate: process.stdout.isTTY === true && process.env.TOOLNETCLI_ANIMATIONS !== "0",
    inPlace: process.stdout.isTTY === true,
    noColor: isNoColor(),
  });
}

export const mascotBase = MASCOT_SOURCE_ROWS;
