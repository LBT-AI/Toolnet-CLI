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

const rgb = (r: number, g: number, b: number) => CSI + `38;2;${r};${g};${b}m`;
const bgRgb = (r: number, g: number, b: number) => CSI + `48;2;${r};${g};${b}m`;

// ─── Glyph capability ───────────────────────────────────────────────────────
// A terminal that cannot render Unicode box-drawing / wide glyphs does not
// print a friendly placeholder: it prints `?` (or drops the cell entirely),
// which is the source of the `??` / `????` artifacts next to borders and
// tables. Capability is therefore decided ONCE, from the environment, and every
// glyph is selected through `S` (or transliterated by `transliterateGlyphs`)
// instead of being hardcoded at the call site.
let unicodeOverride: boolean | null = null;

/**
 * Whether the current terminal can render Unicode box-drawing and symbols.
 *
 * Defaults to true (modern terminals are UTF-8), but any explicit signal — a
 * non-UTF-8 locale, a dumb terminal, or the `TOOLNET_ASCII`/`TOOLNET_UNICODE`
 * overrides — switches deterministically to the ASCII glyph set.
 */
export function isUnicodeCapable(): boolean {
  if (unicodeOverride !== null) return unicodeOverride;
  const env = typeof process !== "undefined" ? process.env : undefined;
  if (!env) return true;
  const ascii = (env.TOOLNET_ASCII || "").toLowerCase();
  if (ascii === "1" || ascii === "true" || ascii === "yes") return false;
  const unicode = (env.TOOLNET_UNICODE || "").toLowerCase();
  if (unicode === "1" || unicode === "true" || unicode === "yes") return true;
  if (unicode === "0" || unicode === "false" || unicode === "no") return false;
  if ((env.TERM || "").toLowerCase() === "dumb") return false;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  if (locale && !/utf-?8/i.test(locale)) return false;
  return true;
}

/** Test/forced override for glyph capability; `null` restores env detection. */
export function setUnicodeCapable(value: boolean | null): void {
  unicodeOverride = value;
}

export interface GlyphSet {
  bullet: string;
  check: string;
  cross: string;
  dot: string;
  square: string;
  arrowUp: string;
  arrowDown: string;
  pageUp: string;
  pageDown: string;
  ellipsis: string;
  hrule: string;
  caretBar: string;
  thought: string;
  spinner: readonly string[];
  box: {
    topLeft: string;
    topRight: string;
    bottomLeft: string;
    bottomRight: string;
    horizontal: string;
    vertical: string;
  };
}

/**
 * The one symbol bag. Unicode is the default; every entry has an ASCII twin so
 * a terminal without glyph support degrades to clean ASCII rather than `?`.
 */
const UNICODE_GLYPHS: GlyphSet = {
  bullet: "•",
  check: "✓",
  cross: "✗",
  dot: "●",
  square: "■",
  arrowUp: "↑",
  arrowDown: "↓",
  pageUp: "⇞",
  pageDown: "⇟",
  ellipsis: "…",
  hrule: "─",
  caretBar: "▊",
  thought: "💭",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  box: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
  },
};

const ASCII_GLYPHS: GlyphSet = {
  bullet: "-",
  check: "v",
  cross: "x",
  dot: "*",
  square: "#",
  arrowUp: "^",
  arrowDown: "v",
  pageUp: "PgUp",
  pageDown: "PgDn",
  ellipsis: "...",
  hrule: "-",
  caretBar: "|",
  thought: "*",
  spinner: ["|", "/", "-", "\\"],
  box: {
    topLeft: "+",
    topRight: "+",
    bottomLeft: "+",
    bottomRight: "+",
    horizontal: "-",
    vertical: "|",
  },
};

export const S: GlyphSet = new Proxy(UNICODE_GLYPHS, {
  get(_target, prop: keyof GlyphSet) {
    const set = isUnicodeCapable() ? UNICODE_GLYPHS : ASCII_GLYPHS;
    return set[prop];
  },
});

/**
 * Surface + text + semantic palette.
 *
 * Design intent: a dark terminal should still feel LIT. No pure black, no
 * mud-gray text. Backgrounds are navy/charcoal, text is high-contrast ivory,
 * and every semantic role has one obvious color. Legacy token names are kept
 * (renderers depend on them) but re-pointed at the brighter values.
 */
const RAW_A = {
  reset:     CSI + "0m",
  bold:      CSI + "1m",
  boldOff:   CSI + "22m",
  dim:       CSI + "2m",
  dimOff:    CSI + "22m",
  italic:    CSI + "3m",
  italicOff: CSI + "23m",

  bg:        "",
  // Surfaces — navy/charcoal, never absolute black.
  bgSurface: bgRgb(11, 18, 32),    // #0B1220 app background
  bgPanel:   bgRgb(17, 26, 43),    // #111A2B panel
  bgOverlay: bgRgb(22, 32, 51),    // #162033 elevated overlay
  bgElevated:bgRgb(26, 39, 64),    // #1A2740 elevated surface
  bgStatus:  bgRgb(17, 26, 43),    // #111A2B status strip
  bgBadge:   bgRgb(26, 39, 64),    // #1A2740 badge chip
  bgTool:    bgRgb(16, 24, 38),    // #101826 assistant/tool block
  bgSelected:bgRgb(29, 49, 82),    // #1D3152 selected row
  bgSuggest: bgRgb(17, 26, 43),    // #111A2B suggestion palette
  bgHeader:  "",
  bgInput:   "",
  bgRed:     bgRgb(255, 107, 107),

  // Foreground / text hierarchy.
  fgText:    rgb(234, 242, 255),   // #EAF2FF primary text
  fgPrimary: rgb(234, 242, 255),
  fgSubtext: rgb(183, 196, 214),   // #B7C4D6 secondary text
  fgSecondary:rgb(183, 196, 214),
  fgMuted:   rgb(127, 140, 163),   // #7F8CA3 muted text
  fgBorder:  rgb(34, 49, 77),      // #22314D border
  borderStrong: rgb(46, 66, 102),  // #2E4266 stronger divider

  // Metadata tones — code, paths and identifiers are NEUTRAL COOL, never a
  // warm accent. Peach stays reserved for write/edit action semantics.
  fgCode:    rgb(159, 182, 217),   // #9FB6D9 inline code / path metadata
  bgCode:    bgRgb(22, 35, 58),    // #16233A very subtle code backdrop
  fgHeadingPrimary: rgb(89, 208, 255),   // #59D0FF primary section heading
  fgHeadingSecondary: rgb(183, 196, 214), // #B7C4D6 secondary heading

  // Accents.
  fgCyan:    rgb(89, 208, 255),    // #59D0FF cyan accent
  fgAccent:  rgb(77, 163, 255),    // #4DA3FF primary accent
  fgBlue:    rgb(77, 163, 255),    // #4DA3FF read / info accent
  fgViolet:  rgb(167, 139, 250),   // #A78BFA purple accent
  fgMauve:   rgb(167, 139, 250),
  fgMagenta: rgb(167, 139, 250),
  fgPeach:   rgb(255, 159, 90),    // #FF9F5A write/edit accent
  fgOrange:  rgb(255, 159, 90),
  fgYellow:  rgb(245, 185, 66),    // #F5B942 warning
  fgAmber:   rgb(245, 185, 66),
  caret:     rgb(102, 179, 255),   // #66B3FF input focus caret

  // Semantic.
  fgGreen:   rgb(46, 204, 113),    // #2ECC71 success
  fgSuccess: rgb(46, 204, 113),
  fgWarning: rgb(245, 185, 66),    // #F5B942 warning
  fgInfo:    rgb(91, 192, 255),    // #5BC0FF info
  fgRed:     rgb(255, 107, 107),   // #FF6B6B error
  fgError:   rgb(255, 107, 107),
};

export const A: typeof RAW_A = new Proxy(RAW_A, {
  get(target, prop: keyof typeof RAW_A) {
    if (isNoColor()) {
      return "";
    }
    return target[prop] ?? "";
  }
});

/** Semantic role → color. One place that decides "what color is a read?". */
const RAW_THEME = {
  brand:     rgb(89, 208, 255),    // #59D0FF cyan — brand / navigation
  read:      rgb(77, 163, 255),    // #4DA3FF blue — read
  search:    rgb(77, 163, 255),    // #4DA3FF blue — search
  lsp:       rgb(77, 163, 255),    // #4DA3FF blue — lsp
  thinking:  rgb(167, 139, 250),   // #A78BFA violet — reasoning
  reasoning: rgb(167, 139, 250),
  subagent:  rgb(167, 139, 250),
  running:   rgb(245, 185, 66),    // #F5B942 amber — running/test/build
  test:      rgb(245, 185, 66),
  build:     rgb(245, 185, 66),
  install:   rgb(245, 185, 66),
  mutation:  rgb(255, 159, 90),    // #FF9F5A peach — write/edit
  write:     rgb(255, 159, 90),
  edit:      rgb(255, 159, 90),
  patch:     rgb(255, 159, 90),
  success:   rgb(46, 204, 113),    // #2ECC71
  error:     rgb(255, 107, 107),   // #FF6B6B
  warning:   rgb(245, 185, 66),    // #F5B942
  info:      rgb(91, 192, 255),    // #5BC0FF
  accent:    rgb(77, 163, 255),    // #4DA3FF
  caret:     rgb(102, 179, 255),   // #66B3FF
  cancelled: rgb(127, 140, 163),   // #7F8CA3
  text:      rgb(234, 242, 255),   // #EAF2FF
  subtext:   rgb(183, 196, 214),   // #B7C4D6
  muted:     rgb(127, 140, 163),   // #7F8CA3
  border:    rgb(34, 49, 77),      // #22314D
  code:      rgb(159, 182, 217),   // #9FB6D9 inline code / path metadata
};

export const theme: typeof RAW_THEME = new Proxy(RAW_THEME, {
  get(target, prop: keyof typeof RAW_THEME) {
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
