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
  bgOverlay: CSI + "48;2;30;34;44m",
  bgStatus:  CSI + "48;2;20;20;25m",
  bgBadge:   CSI + "48;2;35;35;45m",
  bgTool:    CSI + "48;2;22;22;26m",
  fgText:    CSI + "38;2;226;232;240m",
  fgSubtext: CSI + "38;2;148;163;184m",
  fgMuted:   CSI + "38;2;100;116;139m",
  fgBorder:  CSI + "38;2;51;65;85m",
  fgCyan:    CSI + "38;2;56;189;248m",
  fgGreen:   CSI + "38;2;74;222;128m",
  fgYellow:  CSI + "38;2;251;191;36m",
  fgRed:     CSI + "38;2;248;113;113m",
  fgBlue:    CSI + "38;2;56;189;248m",
  fgViolet:  CSI + "38;2;167;139;250m",
  fgMauve:   CSI + "38;2;167;139;250m",
  fgPeach:   CSI + "38;2;251;146;60m",
  fgMagenta: CSI + "38;2;167;139;250m",
  bgHeader:  "",
  bgInput:   "",
  bgSuggest: CSI + "48;2;20;20;20m",
  bgRed:     CSI + "48;2;248;113;113m",
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
