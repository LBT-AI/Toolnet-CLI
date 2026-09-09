import { T } from "../term";
import type { BannerVariant } from "./types";

export const FULL_MIN_COLS = 80;
export const FULL_MIN_ROWS = 8;
export const COMPACT_MIN_COLS = 40;
export const COMPACT_MIN_ROWS = 3;

/** Bands for responsive banner: large terminal → full animation. */
export function selectVariant(cols: number, rows: number): BannerVariant {
  if (cols >= FULL_MIN_COLS && rows >= FULL_MIN_ROWS) return "full";
  if (cols >= COMPACT_MIN_COLS && rows >= COMPACT_MIN_ROWS) return "compact";
  return "text";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const HIDE_CURSOR = T.hide;
export const SHOW_CURSOR = T.show;

export const CLEAR_LINE = T.clearLine;
export const CLEAR_DOWN = T.clearDown;
export const HOME = T.home;

export function goto(row: number, col: number): string {
  return T.goto(Math.max(1, row), Math.max(1, col));
}

/** Centers `text` within `width`, truncating when it does not fit. */
export function center(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, Math.max(0, width));
  const pad = Math.floor((width - text.length) / 2);
  return " ".repeat(pad) + text;
}

/** Left-align with trailing spaces (erases stale content on redraw). */
export function padTo(text: string, width: number): string {
  return text.padEnd(Math.max(0, width));
}

export function clearScreen(): string {
  return CLEAR_DOWN + HOME;
}