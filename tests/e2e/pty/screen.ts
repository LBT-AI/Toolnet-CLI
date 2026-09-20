"use strict";
/**
 * Minimal ANSI screen painter for assertions: replays a captured output stream
 * onto a fixed grid, honoring cursor addressing, line erase, CR/LF and SGR
 * (ignored visually). Enough fidelity to assert row/col placement of the
 * composer, footer and cursor in the final painted frame.
 */

/** Paint a raw ANSI byte stream onto a rows×cols character grid. */
function paint(output, cols, rows) {
  const grid = [];
  for (let r = 0; r < rows; r++) grid.push(new Array(cols).fill(" "));
  let row = 0;
  let col = 0;
  let i = 0;
  const n = output.length;

  const putChar = (ch) => {
    if (col >= cols) {
      col = 0;
      row = Math.min(row + 1, rows - 1);
    }
    if (row >= 0 && row < rows && col >= 0 && col < cols) grid[row][col] = ch;
    col += 1;
  };

  while (i < n) {
    const ch = output[i];
    if (ch === "\x1b") {
      if (output[i + 1] === "[") {
        // CSI … final-byte
        let j = i + 2;
        while (j < n && !/[A-Za-z]/.test(output[j])) j += 1;
        const final = j < n ? output[j] : "";
        const body = output.slice(i + 2, j);
        const params = body.split(";").map((p) => parseInt(p, 10));
        const p0 = Number.isFinite(params[0]) ? params[0] : undefined;
        const p1 = Number.isFinite(params[1]) ? params[1] : undefined;
        if (final === "H" || final === "f") {
          row = Math.min(Math.max((p0 ?? 1) - 1, 0), rows - 1);
          col = Math.max((p1 ?? 1) - 1, 0);
        } else if (final === "J") {
          const mode = p0 ?? 0;
          if (mode === 2) {
            for (let r = 0; r < rows; r++) grid[r].fill(" ");
          } else if (mode === 0) {
            for (let c = col; c < cols; c++) grid[row][c] = " ";
            for (let r = row + 1; r < rows; r++) grid[r].fill(" ");
          }
        } else if (final === "K") {
          const mode = p0 ?? 0;
          if (mode === 0) for (let c = col; c < cols; c++) grid[row][c] = " ";
          if (mode === 1) for (let c = 0; c <= col && c < cols; c++) grid[row][c] = " ";
          if (mode === 2) grid[row].fill(" ");
        } else if (final === "A") {
          row = Math.max(0, row - (p0 ?? 1));
        } else if (final === "B") {
          row = Math.min(rows - 1, row + (p0 ?? 1));
        } else if (final === "C") {
          col = Math.min(cols - 1, col + (p0 ?? 1));
        } else if (final === "D") {
          col = Math.max(0, col - (p0 ?? 1));
        }
        // SGR and private modes (?1049, ?25, ?2004 …) are visual no-ops here.
        i = j + 1;
        continue;
      }
      // Non-CSI escape: skip the next byte (covers \x1b] OSC roughly, \x1bX etc.)
      i += 2;
      continue;
    }
    if (ch === "\r") {
      col = 0;
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row = Math.min(row + 1, rows - 1);
      i += 1;
      continue;
    }
    if (ch === "\b") {
      col = Math.max(0, col - 1);
      i += 1;
      continue;
    }
    if (ch < " ") {
      // Other control bytes (BEL, SO/SI …) carry no glyph.
      i += 1;
      continue;
    }
    putChar(ch);
    i += 1;
  }
  return grid;
}

/** Render the painted grid to a plain string (one line per row). */
function toText(grid) {
  return grid.map((line) => line.join("").trimEnd()).join("\n");
}

module.exports = { paint, toText };
