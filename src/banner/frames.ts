import type { BannerFrame, BannerStep } from "./types";

export const WIDTH = 80;
export const SPRITE_ROWS = 20;
export const OUTPUT_ROWS = SPRITE_ROWS / 2;

/** Original ToolNet cat mascot palette (no Copilot/GitHub colors). */
export const PALETTE = {
  b: "#2DD4BF",
  s: "#0F766E",
  f: "#F0FDFA",
  d: "#042F2E",
  k: "#F9A8D4",
  h: "#99F6E4",
  y: "#FDE047",
};

export const ELEMENT: Record<string, keyof typeof PALETTE> = {
  b: "b",
  s: "s",
  f: "f",
  d: "d",
  k: "k",
  h: "h",
  y: "y",
};

const ROWS = [
  "....................bbbbb...............................bbbbb...................",
  "................bbbbbbbbbbbbb...........s...........bbbbbbbbbbbbb...............",
  "...............bbbbbkkkkkbbbbsssssssssssssssssssssssbbbbkkkkkbbbbb..............",
  "..............bbbbkkkkssssssssssssssssssbsssssssssssssssssskkkkbbbb.............",
  "..............bbbkssssssssbbbbbbbbbbbbbbbbbbbbbbbbbbbbbsssssssskbbb.............",
  ".............sbsssssbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbsssssbs............",
  "...........sssssbbbbbbbbddddybbbbbbbbbbbbbbbbbbbbbbbddddybbbbbbbbsssss..........",
  "..........ssssbbbbbbbbdddddyyydbbbbbbbbbbbbbbbbbbbdddddyyydbbbbbbbbssss.........",
  ".........sssbbbbbbbbbbddddddyddbbbbbbbbbbbbbbbbbbbddddddyddbbbbbbbbbbsss........",
  ".........ssbbbbbbbbbbbdddddddddbbbbbbbbbbbbbbbbbbbdddddddddbbbbbbbbbbbss........",
  ".....ssssssbbbbbbbbbbbdddddddddbbbbbbbbbbbbbbbbbbbdddddddddbbbbbbbbbbbsssss.....",
  ".....sssssssssssbbbkkkkkdddddbbbbbbbbbbbbbbbbbbbbbbbdddddkkkkkbbsssssssssss.....",
  ".........ssbbbbbbbkkkkkkkbbbbbbbbbbbbbdddddbbbbbbbbbbbbbkkkkkkkbbbbbbbss........",
  "..........bsbbbbbbbbbbbbbbbbbbbbbbbbsbdddddbsbbbbbbbbbbbbbbbbbbbbbbbbsb.........",
  "...........bssbbbbbbbbbbbbbbbbbbbbbbsbssssbbsbbbbbbbbbbbbbbbbbbbbbbssb..........",
  ".............bbsbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbsbb............",
  "................bbssbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbssbb...............",
  "....................bbssssbbbbbbbbbbbbbbbbbbbbbbbbbbbbbssssbb...................",
  ".........................bbbbbssssssssssbssssssssssbbbbb........................",
  "........................................b.......................................",
];

export const BASE = ROWS.map((r) => r.padEnd(WIDTH, ".").slice(0, WIDTH));

function eyeCells(): Array<[number, number, string]> {
  const cells: Array<[number, number, string]> = [];
  for (let r = 6; r <= 11; r++) {
    for (let c = 0; c < WIDTH; c++) {
      const ch = BASE[r][c];
      if ((ch === "d" || ch === "y") && (c < 31 || c > 48 || (c >= 36 && c <= 44 && r > 8))) {
        cells.push([r, c, "b"]);
      }
    }
  }
  return cells;
}

function blushCells(): Array<[number, number, string]> {
  const cells: Array<[number, number, string]> = [];
  for (let r = 0; r < SPRITE_ROWS; r++) {
    for (let c = 0; c < WIDTH; c++) {
      if (BASE[r][c] === "k") cells.push([r, c, "h"]);
    }
  }
  return cells;
}

function sparkleCells(...points: Array<[number, number]>): Array<[number, number, string]> {
  return points.map(([r, c]) => [r, c, "y"] as [number, number, string]);
}

export const FRAMES: BannerFrame[] = [
  { title: "open", edits: [] },
  { title: "open", edits: [] },
  { title: "ear", edits: [...blushCells().slice(0, 40)] },
  { title: "open", edits: [] },
  { title: "blink", edits: eyeCells() },
  { title: "open", edits: [] },
  { title: "sparkle-l", edits: sparkleCells([0, 12], [0, 66], [19, 40]) },
  { title: "sparkle-r", edits: sparkleCells([0, 8], [0, 70], [18, 30], [18, 50]) },
  { title: "sparkle-l", edits: sparkleCells([19, 14], [1, 74], [0, 22]) },
  { title: "open", edits: [] },
];

export const SPRITE_DURATIONS = [140, 140, 140, 140, 160, 160, 170, 180, 180, 200];

export function frameAt(edits: Array<[number, number, string]>): string[] {
  if (edits.length === 0) return BASE.map((r) => r.slice());
  const grid = BASE.map((r) => r.split(""));
  for (const [r, c, ch] of edits) {
    if (r >= 0 && r < SPRITE_ROWS && c >= 0 && c < WIDTH) grid[r][c] = ch;
  }
  return grid.map((r) => r.join(""));
}

const CONTENT_LEFT = 6;
const CONTENT_RIGHT = 75;
const CONTENT_MID = (CONTENT_LEFT + CONTENT_RIGHT) / 2;
const CONTENT_HALF = (CONTENT_RIGHT - CONTENT_LEFT) / 2 + 1;

export function slideFromLeft(rows: string[], amount: number): string[] {
  return rows.map((r) => r.slice(Math.round(amount)).padEnd(WIDTH, ".").slice(0, WIDTH));
}

export function columnFades(progress: number): number[] {
  const t = Math.max(0, Math.min(1, progress));
  const fades: number[] = new Array(WIDTH);
  for (let c = 0; c < WIDTH; c++) {
    fades[c] = 1 - (1 - t) * Math.min(1, Math.abs(c - CONTENT_MID) / CONTENT_HALF);
  }
  return fades;
}

const RISE = [
  { progress: 0, opacity: 0.45, shade: 0.55, durationMs: 40 },
  { progress: 0.35, opacity: 0.62, shade: 0.4, durationMs: 40 },
  { progress: 0.62, opacity: 0.78, shade: 0.26, durationMs: 42 },
  { progress: 0.83, opacity: 0.9, shade: 0.14, durationMs: 45 },
  { progress: 0.95, opacity: 0.97, shade: 0.05, durationMs: 45 },
];

const SPARKLE = [
  { sparkleOpacity: 0.62, durationMs: 72 },
  { sparkleOpacity: 0.34, durationMs: 78 },
  { sparkleOpacity: 0.12, durationMs: 83 },
];

const IDLE_MS = 220;

const FADE = [
  { opacity: 0.72, durationMs: 42 },
  { opacity: 0.48, durationMs: 45 },
  { opacity: 0.26, durationMs: 48 },
  { opacity: 0.09, durationMs: 50 },
];

export function buildSteps(): { steps: BannerStep[]; starts: number[]; totalMs: number } {
  const frames = FRAMES.map((f) => frameAt(f.edits));
  const last = frames[frames.length - 1];
  const steps: BannerStep[] = [];

  for (const p of RISE) {
    const rows = slideFromLeft(frames[0], (CONTENT_RIGHT - CONTENT_LEFT) * (1 - p.progress));
    steps.push({ rows, durationMs: p.durationMs, opacity: p.opacity, shade: p.shade, sparkleOpacity: 1, columnFades: columnFades(p.progress) });
  }

  frames.forEach((rows, i) => {
    steps.push({ rows, durationMs: SPRITE_DURATIONS[i] ?? 160, opacity: 1, shade: 0, sparkleOpacity: 1, columnFades: null });
  });

  for (const s of SPARKLE) {
    steps.push({ ...s, rows: last, opacity: 1, shade: 0, columnFades: null });
  }

  steps.push({ rows: last, durationMs: IDLE_MS, opacity: 1, shade: 0, sparkleOpacity: 0.12, columnFades: null });

  for (const f of FADE) {
    steps.push({ ...f, rows: last, shade: 0, sparkleOpacity: 0, columnFades: null });
  }

  const starts: number[] = [];
  let totalMs = 0;
  for (const s of steps) {
    starts.push(totalMs);
    totalMs += s.durationMs;
  }
  return { steps, starts, totalMs };
}