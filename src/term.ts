// ─── ANSI Helpers ───────────────────────────────────────────────────────────
const ESC = "\x1b";
const CSI = ESC + "[";

let noColorOverride: boolean | null = null;

export function isNoColor(): boolean {
  if (noColorOverride !== null) return noColorOverride;
  if (typeof process !== "undefined") {
    if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "" && process.env.NO_COLOR !== "0") {
      return true;
    }
    if (process.argv && process.argv.includes("--no-color")) {
      return true;
    }
  }
  return false;
}

export function setNoColor(val: boolean | null): void {
  noColorOverride = val;
}

const RAW_A = {
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

export const A: typeof RAW_A = new Proxy(RAW_A, {
  get(target, prop: keyof typeof RAW_A) {
    if (isNoColor()) {
      return "";
    }
    return target[prop] ?? "";
  }
});

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
  const cols = (process.stdout && process.stdout.columns) || 100;
  const rows = (process.stdout && process.stdout.rows) || 30;
  return {
    cols: Math.max(20, cols),
    rows: Math.max(5, rows),
  };
}
