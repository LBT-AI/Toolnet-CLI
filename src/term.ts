// ─── ANSI Helpers ───────────────────────────────────────────────────────────
const ESC = "\x1b";
const CSI = ESC + "[";

export const A = {
  reset:     CSI + "0m",
  bold:      CSI + "1m",
  dim:       CSI + "2m",
  italic:    CSI + "3m",

  bg:        "",
  bgSurface: CSI + "48;2;15;15;15m",
  bgOverlay: CSI + "48;2;30;30;30m",
  fgText:    CSI + "38;2;230;230;230m",
  fgSubtext: CSI + "38;2;120;120;120m",
  fgCyan:    CSI + "38;2;0;175;255m",
  fgGreen:   CSI + "38;2;98;209;150m",
  fgYellow:  CSI + "38;2;229;192;123m",
  fgRed:     CSI + "38;2;224;108;117m",
  fgBlue:    CSI + "38;2;97;175;239m",
  fgMauve:   CSI + "38;2;180;180;220m",
  fgPeach:   CSI + "38;2;209;154;102m",
  fgMagenta: CSI + "38;2;255;0;255m",
  bgHeader:  "",
  bgInput:   "",
  bgSuggest: CSI + "48;2;20;20;20m",
  bgRed:     CSI + "48;2;224;108;117m",
};

export const T = {
  hide:      CSI + "?25l",
  show:      CSI + "?25h",
  home:      CSI + "H",
  goto: (r: number, c: number) => CSI + r + ";" + c + "H",
  clearLine: CSI + "2K",
  clearDown: CSI + "J",
  altOn:     CSI + "?1049h",
  altOff:    CSI + "?1049l",
};

export function write(s: string) { process.stdout.write(s); }

export function getSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || 100,
    rows: process.stdout.rows || 30,
  };
}
