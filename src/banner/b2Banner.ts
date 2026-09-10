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
  tagline?: string;
}

export const B2_TIMELINE: Record<BannerPhase, number> = {
  core: 120,
  portal: 260,
  connections: 400,
  pulse: 540,
  wordmark: 700,
  final: 800,
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

/**
 * Minimal diamond logo (3 rows, uniform strokes, no heavy framing):
 * a ◇ core with a network-node stem below it. Used on compact terminals.
 */
const SYMBOL = [
  "╭─╮",
  "│◇│",
  "╰┬╯",
];

// The wordmark is the classic figlet "standard" TOOLNET lettering — the
// brand's familiar block glyphs — drawn only on wide terminals. No mascot.
const FIGLET: Record<string, string[]> = {
  T: [
    "████████╗",
    "╚══██╔══╝",
    "   ██║   ",
    "   ██║   ",
    "   ██║   ",
    "   ╚═╝   ",
  ],
  O: [
    "██████╗  ",
    "██╔═══██╗",
    "██║   ██║",
    "██║   ██║",
    "╚██████╔╝",
    " ╚═════╝ ",
  ],
  L: [
    "██╗      ",
    "██║      ",
    "██║      ",
    "██║      ",
    "╚██████╗ ",
    " ╚═════╝ ",
  ],
  N: [
    "███╗   ██╗",
    "████╗  ██║",
    "██╔██╗ ██║",
    "██║╚██╗██║",
    "██║ ╚████║",
    "╚═╝  ╚═══╝",
  ],
  E: [
    "███████╗ ",
    "██╔════╝ ",
    "█████╗   ",
    "██╔══╝   ",
    "███████╗ ",
    "╚══════╝ ",
  ],
};
const WORD = "TOOLNET";
const FIGLET_ROWS = 6;
const FIGLET_GAP = " ";
// Lockup width: sum of the per-letter glyph widths + one gap between letters.
const FIGLET_WIDTH = [...WORD].reduce((sum, ch) => sum + FIGLET[ch][0].length, 0) + (WORD.length - 1) * FIGLET_GAP.length;
const FIGLET_CELLS = FIGLET_WIDTH * FIGLET_ROWS;

function toneCode(_tone: keyof typeof B2_COLORS, noColor: boolean): string {
  return noColor ? "" : B2_COLORS[_tone];
}

function paint(value: string, code: string, noColor: boolean, bold = false): string {
  if (noColor || value.length === 0) return value;
  return `${bold ? B2_COLORS.bold : ""}${code}${value}${B2_COLORS.reset}`;
}

function center(value: string, cols: number): string {
  return " ".repeat(Math.max(0, Math.floor((cols - visibleWidth(value)) / 2))) + value;
}

/**
 * One figlet row of the TOOLNET wordmark. `revealTotal` is the number of
 * cells already typed across the whole lockup (left→right, top→bottom), so
 * the banner types in like a terminal typewriter — cells before it are cyan,
 * everything after stays blank.
 */
function figletRow(row: number, revealTotal: number | null, noColor: boolean): string {
  let plain = "";
  for (let i = 0; i < WORD.length; i++) {
    plain += FIGLET[WORD[i]][row];
    if (i < WORD.length - 1) plain += FIGLET_GAP;
  }
  const rowStart = row * FIGLET_WIDTH;
  const visible = revealTotal === null ? plain.length : Math.max(0, Math.min(plain.length, revealTotal - rowStart));
  const shown = plain.slice(0, visible);
  const hidden = plain.slice(visible).replace(/[^\s]/g, " ");
  return paint(shown, B2_COLORS.cyan, noColor) + hidden;
}

/** Small clean TOOLNET text (bold, brand cyan) for narrow terminals. */
function wordText(revealChars: number | null, noColor: boolean): string {
  let out = "";
  for (let i = 0; i < WORD.length; i++) {
    const shown = revealChars === null || i < revealChars;
    out += shown ? paint(WORD[i], B2_COLORS.cyan, noColor, true) : " ";
  }
  return padVisible(out, WORD.length);
}

function symbolRow(row: number, progress: number, noColor: boolean, pulse: boolean): string {
  const chars = Array.from(SYMBOL[row]);
  const centerCell = Math.floor(chars.length / 2);
  let radius = 0;
  if (progress > 0 && progress < 0.4) {
    radius = (progress / 0.4) * centerCell;
  } else if (progress >= 0.4) {
    radius = centerCell;
  }
  const visible = chars.map((char, index) => {
    if (char === " ") return " ";
    return Math.abs(index - centerCell) <= radius ? char : " ";
  }).join("");
  const tone = pulse ? B2_COLORS.violet : B2_COLORS.cyan;
  return paint(visible, tone, noColor, pulse);
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
  if (elapsed < B2_TIMELINE.portal) return phaseProgress(elapsed, B2_TIMELINE.core, B2_TIMELINE.portal);
  return 1;
}

function renderedLines(cols: number, elapsed: number, noColor: boolean, tagline = "AI CODING CLI"): string[] {
  const compact = cols < 80;
  const phase = phaseAt(elapsed);
  const pulse = phase === "pulse";
  const lines: string[] = [];
  const showTagline = phase === "final" || elapsed >= B2_TIMELINE.wordmark;
  const symbolValue = phase === "final" ? 1 : symbolProgress(elapsed);

  if (compact) {
    // Compact lockup (mobile / narrow terminals): diamond beside the wordmark.
    const wordReveal = phase === "final"
      ? null
      : phase === "wordmark"
        ? Math.floor(phaseProgress(elapsed, B2_TIMELINE.wordmark - 290, B2_TIMELINE.wordmark) * WORD.length)
        : 0;
    const lockupWidth = 3 + 1 + WORD.length;
    const left = Math.max(0, Math.floor((cols - lockupWidth) / 2));
    for (let row = 0; row < 3; row++) {
      const mark = symbolRow(row, symbolValue, noColor, pulse);
      const right = row === 0
        ? wordText(wordReveal, noColor)
        : row === 1
          ? (showTagline ? paint("AI CLI", B2_COLORS.muted, noColor) : " ".repeat(6))
          : "";
      lines.push(" ".repeat(left) + mark + (right ? " " + right : ""));
    }
    return lines;
  }

  // Full lockup (desktop): the figlet TOOLNET wordmark types in cell by cell.
  const figletReveal = phase === "final" ? null : Math.floor(phaseProgress(elapsed, 0, B2_TIMELINE.wordmark) * FIGLET_CELLS);
  for (let row = 0; row < FIGLET_ROWS; row++) {
    lines.push(center(figletRow(row, figletReveal, noColor), cols));
  }
  lines.push(center(paint(showTagline ? tagline : "", B2_COLORS.muted, noColor), cols));
  return lines;
}

export function renderB2Banner(
  cols: number,
  elapsed = B2_TIMELINE.final,
  noColor = isNoColor(),
  tagline = "AI CODING CLI",
): string[] {
  const safeCols = Math.max(1, cols);
  return renderedLines(safeCols, Math.max(0, elapsed), noColor, tagline);
}

export function b2BannerMetrics(cols: number): { width: number; height: number } {
  const lines = renderB2Banner(cols, B2_TIMELINE.final, true);
  return {
    width: lines.reduce((max, line) => Math.max(max, visibleWidth(line.trimEnd())), 0),
    height: lines.length,
  };
}

function drawFrame(ctx: BannerPlayContext, topRow: number, elapsed: number, noColor: boolean, inPlace: boolean, tagline?: string): void {
  const lines = renderB2Banner(ctx.cols, elapsed, noColor, tagline);
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
  const tagline = options.tagline ?? "AI CODING CLI";
  const now = options.now ?? (() => performance.now());
  const size = () => {
    const current = ctx.getSize?.() ?? { cols: ctx.cols, rows: ctx.rows };
    return { cols: Math.max(1, current.cols), rows: Math.max(1, current.rows) };
  };
  const initialSize = size();
  const topRow = (height: number, rows: number) => Math.max(1, Math.floor((rows - height) / 2) + 1);
  const finalHeight = renderB2Banner(initialSize.cols, B2_TIMELINE.final, noColor, tagline).length;

  if (!animate) {
    const current = size();
    drawFrame({ ...ctx, cols: current.cols }, topRow(finalHeight, current.rows), B2_TIMELINE.final, noColor, inPlace, tagline);
    return;
  }

  ctx.write(HIDE_CURSOR, true);
  try {
    const animation: BannerAnimation = { startedAt: now(), phase: "core" };
    const initial = size();
    drawFrame({ ...ctx, cols: initial.cols }, topRow(renderB2Banner(initial.cols, 0, noColor, tagline).length, initial.rows), 0, noColor, inPlace, tagline);
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
        const currentTop = topRow(renderB2Banner(current.cols, elapsed, noColor, tagline).length, current.rows);
        if (elapsed >= B2_TIMELINE.final) {
          drawFrame(currentContext, currentTop, B2_TIMELINE.final, noColor, inPlace, tagline);
          finish();
          return;
        }
        drawFrame(currentContext, currentTop, elapsed, noColor, inPlace, tagline);
      };
      timer = setInterval(tick, options.frameMs ?? 33);
      tick();
    });
  } finally {
    const current = size();
    const finalLines = renderB2Banner(current.cols, B2_TIMELINE.final, noColor, tagline);
    ctx.write(SHOW_CURSOR + cursorAt(topRow(finalLines.length, current.rows) + finalLines.length), true);
  }
}

export function printToolNetBanner(version = getVersion()): Promise<void> {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  return playB2Banner({ cols, rows, write: (value) => process.stdout.write(value) }, {
    animate: process.stdout.isTTY === true && process.env.TOOLNETCLI_ANIMATIONS !== "0",
    inPlace: process.stdout.isTTY === true,
    noColor: isNoColor(),
    tagline: `AI Coding CLI · v${version} · AgentHarness 2.0`,
  });
}

export function bannerLineWidths(cols: number, elapsed = B2_TIMELINE.final, noColor = true): number[] {
  return renderB2Banner(cols, elapsed, noColor).map(visibleWidth);
}

export const b2BrandMark = SYMBOL;
export const b2CompactBrandMark = SYMBOL;
export { toneCode };