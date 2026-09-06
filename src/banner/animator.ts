import { A } from "../term";
import { buildSteps, OUTPUT_ROWS, PALETTE } from "./frames";
import { buildPalette, renderStep } from "./renderer";
import { center, clearScreen, goto, CLEAR_LINE, HIDE_CURSOR, SHOW_CURSOR, sleep } from "./terminal";
import { getVersion } from "../lib/version";
import type { BannerStep } from "./types";

export interface PlayContext {
  cols: number;
  rows: number;
  write: (s: string, flush?: boolean) => void;
}

/** Near-black backdrop, blended against ToolNet teal accents. */
const BRAND = "#0A2430";
const DARK = "#062B2C";

function startTimes(steps: BannerStep[]): number[] {
  const starts: number[] = new Array(steps.length);
  let acc = 0;
  for (let i = 0; i < steps.length; i++) {
    starts[i] = acc;
    acc += steps[i].durationMs;
  }
  return starts;
}

async function waitUntil(targetAbs: number, stepMs = 40): Promise<void> {
  const delay = targetAbs - Date.now();
  if (delay <= 0) return;
  await sleep(Math.min(delay, stepMs));
  if (delay > stepMs) await waitUntil(targetAbs, stepMs);
}

const paletteFor = (step: BannerStep): Record<string, string> =>
  buildPalette(PALETTE, BRAND, step.opacity, step.sparkleOpacity, step.shade, DARK);

function versionLine(version: string, cols: number): string {
  const text = `${A.bold}${A.fgCyan}TOOLNET${A.reset} ${A.fgSubtext}v${version}${A.reset}`;
  return center(text, cols);
}

function drawFrame(steps: BannerStep[], i: number, topRow: number, version: string, cols: number): string {
  const step = steps[i];
  const { spriteLines, outputRows } = renderStep(step, paletteFor(step));
  const parts: string[] = [];
  for (let n = 0; n < outputRows; n++) {
    const line = spriteLines[n] ?? "";
    parts.push(goto(topRow + n, 1) + CLEAR_LINE + line + A.reset);
  }
  parts.push(goto(topRow + outputRows, 1) + CLEAR_LINE + versionLine(version, cols));
  parts.push(goto(topRow + outputRows + 1, 1) + CLEAR_LINE + center(A.fgSubtext + "AI coding agent for the terminal" + A.reset, cols));
  return parts.join("");
}

export async function playFull(ctx: PlayContext, version = getVersion()): Promise<void> {
  if (ctx.cols < 40) {
    await playText(ctx, version);
    return;
  }
  const { steps } = buildSteps();
  const starts = startTimes(steps);
  const usedRows = OUTPUT_ROWS + 2;
  const topRow = Math.max(1, Math.floor((ctx.rows - usedRows) / 2));
  const t0 = Date.now();
  ctx.write(HIDE_CURSOR);
  ctx.write(clearScreen());
  try {
    for (let i = 0; i < steps.length; i++) {
      await waitUntil(t0 + starts[i]);
      ctx.write(drawFrame(steps, i, topRow, version, ctx.cols));
    }
  } finally {
    ctx.write(SHOW_CURSOR + clearScreen());
  }
}

const SPARKLE = [
  { glyph: "●", dur: 130 },
  { glyph: "◐", dur: 120 },
  { glyph: "◑", dur: 120 },
  { glyph: "●", dur: 150 },
];

const compactLabelSafe = (version: string, glyph: string, cols: number): string => {
  const plain = `${glyph} ToolNet CLI v${version}`;
  const text = plain.length <= cols ? plain : plain.slice(0, Math.max(0, cols));
  const colored = `${A.bold}${A.fgCyan}${glyph}${A.reset} ${A.fgCyan}ToolNet CLI${A.reset} ${A.fgSubtext}v${version}${A.reset}`;
  const plainWidth = plain.length;
  return (plainWidth <= cols ? colored : text) + " ".repeat(Math.max(0, cols - plainWidth));
};

export async function playCompact(ctx: PlayContext, version = getVersion()): Promise<void> {
  const row = 1;
  ctx.write(HIDE_CURSOR);
  const t0 = Date.now();
  try {
    let acc = 0;
    for (const s of SPARKLE) {
      const target = t0 + acc;
      await waitUntil(target);
      ctx.write(goto(row, 1) + CLEAR_LINE + compactLabelSafe(version, s.glyph, ctx.cols));
      acc += s.dur;
    }
  } finally {
    ctx.write(SHOW_CURSOR + CLEAR_LINE);
  }
}

export async function playText(ctx: PlayContext, version = getVersion()): Promise<void> {
  if (ctx.cols <= 0 || ctx.rows <= 0) return;
  const label = center(`ToolNet CLI v${version}`, ctx.cols);
  ctx.write(label + "\n");
  await sleep(1);
}