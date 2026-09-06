import type { BannerStep } from "./types";

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

export function rgbToHex(rgb: { r: number; g: number; b: number }): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(rgb.r)}${h(rgb.g)}${h(rgb.b)}`;
}

export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}

export function dim(hex: string, factor: number): string {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex({ r: r * factor, g: g * factor, b: b * factor });
}

export function buildPalette(
  palette: Record<string, string>,
  brand: string,
  opacity: number,
  sparkleOpacity: number,
  shade: number,
  dark: string
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(palette)) {
    const shaded = shade > 0 ? mix(value, dark, shade) : value;
    const amount = key === "y" ? opacity * sparkleOpacity : opacity;
    out[key] = mix(shaded, brand, amount);
  }
  return out;
}

interface Run {
  glyph: string;
  fg?: string;
  bg?: string;
  length: number;
}

function mergeRows(rowA: string, rowB: string, palette: Record<string, string>, fades: number[] | null): Run[] {
  const runs: Run[] = [];
  const max = Math.max(rowA.length, rowB.length);
  for (let i = 0; i < max; i++) {
    const top = rowA[i];
    const bottom = rowB[i];
    const topKey = top !== undefined && top !== "." ? ELEMENT_OF[top] : undefined;
    const bottomKey = bottom !== undefined && bottom !== "." ? ELEMENT_OF[bottom] : undefined;
    const fade = fades ? (fades[i] ?? 1) : 1;
    let glyph = " ";
    let fg: string | undefined;
    let bg: string | undefined;
    if (topKey !== undefined && bottomKey !== undefined) {
      glyph = "▀";
      fg = dim(palette[topKey], fade);
      bg = dim(palette[bottomKey], fade);
    } else if (topKey !== undefined) {
      glyph = "▀";
      fg = dim(palette[topKey], fade);
    } else if (bottomKey !== undefined) {
      glyph = "▄";
      fg = dim(palette[bottomKey], fade);
    }
    const prev = runs[runs.length - 1];
    if (prev && prev.glyph === glyph && prev.fg === fg && prev.bg === bg) {
      prev.length++;
    } else {
      runs.push({ glyph, fg, bg, length: 1 });
    }
  }
  return runs;
}

const ELEMENT_OF: Record<string, string> = {
  b: "b",
  s: "s",
  f: "f",
  d: "d",
  k: "k",
  h: "h",
  y: "y",
};

function truecolor(code: number, hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  return `\x1b[${code};2;${r};${g};${b}m`;
}

function lineToAnsi(runs: Run[]): string {
  let out = "";
  for (const run of runs) {
    if (run.glyph === " ") {
      out += " ";
      continue;
    }
    if (run.fg) out += truecolor(38, run.fg);
    if (run.bg) out += truecolor(48, run.bg);
    out += run.glyph.repeat(run.length);
    out += "\x1b[0m";
  }
  return out;
}

export interface RenderResult {
  spriteLines: string[];
  outputRows: number;
}

export function renderStep(step: BannerStep, palette: Record<string, string>): RenderResult {
  if (step.rows.length === 0) return { spriteLines: [], outputRows: 0 };
  const spriteLines: string[] = [];
  const outputRows = step.rows.length / 2;
  for (let n = 0; n < outputRows; n++) {
    const a = step.rows[n * 2] ?? "";
    const b = step.rows[n * 2 + 1] ?? "";
    spriteLines.push(lineToAnsi(mergeRows(a, b, palette, step.columnFades)));
  }
  return { spriteLines, outputRows };
}