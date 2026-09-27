/**
 * The last gate between the composed TUI frame and `process.stdout`.
 *
 * Everything a frame contains — transcript text, tool output, box borders,
 * glyph markers — was assembled by many renderers. This module makes ONE
 * guarantee about what actually leaves the process:
 *
 *   1. The frame is always WELL-FORMED UTF-16. A lone surrogate (produced by
 *      slicing through an emoji anywhere upstream) is an encoding artifact, not
 *      content, and is dropped — otherwise it is written as U+FFFD and a
 *      terminal without that glyph prints `?`.
 *   2. When the terminal cannot render Unicode glyphs (non-UTF-8 locale,
 *      `TERM=dumb`, or `TOOLNET_ASCII=1`), every known box-drawing/symbol
 *      character is transliterated to its ASCII twin. Borders degrade to clean
 *      ASCII instead of a row of `?`.
 *
 * Both passes are deterministic and idempotent: the same frame always produces
 * the same bytes, and running the finalizer twice changes nothing.
 */

import { toWellFormed, transliterateGlyphs } from "../lib/text";
import { isUnicodeCapable } from "../term";

/** Sanitize a fully composed frame so it can never emit `?`-style garbage. */
export function finalizeFrameText(frame: string): string {
  const wellFormed = toWellFormed(frame);
  return isUnicodeCapable() ? wellFormed : transliterateGlyphs(wellFormed);
}
