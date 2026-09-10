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