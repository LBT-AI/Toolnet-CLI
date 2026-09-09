/**
 * P8 — Startup banner (Copilot-style) tests.
 *
 * Locks in the new ToolNet startup banner:
 *  1. `banner` config key: default "once", validated on load/set.
 *  2. Decision rules: no-color / headless / non-TTY / `--no-splash` skip;
 *     `--banner` forces; `once` marker short-circuits; `never` skips.
 *  3. Responsive bands: large terminal → full animation, medium → compact,
 *     tiny → static text line.
 *  4. Frames: 20-row sprite → 10 output rows (half-block), step count and
 *     wall-clock starts are monotonic; total under 3s.
 *  5. Renderer emits truecolor ANSI runs only, restores cursor in `finally`.
 *  6. `once` persists a `.banner-shown` marker in the toolnet home dir.
 */

import { describe, it, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setNoColor } from "../../term";
import { visibleWidth } from "../../tui/layout";
import { DEFAULT_APP_CONFIG, validateConfig, loadAppConfig, resetAppConfigCache } from "../../lib/appConfig";
import { resolveBannerDecision, parseBannerFlags } from "../../banner/config";
import { selectVariant } from "../../banner/terminal";
import { hasBannerSeen, markBannerSeen, bannerSeenPath, showBannerIfEligible } from "../../banner/banner";
import { playFull, playCompact } from "../../banner/animator";
import { playMascotBanner, renderMascotBanner, MASCOT_TIMELINE, mascotLineWidths } from "../../banner/mascot";
import { buildSteps, FRAMES, SPRITE_ROWS, OUTPUT_ROWS, BASE, PALETTE } from "../../banner/frames";
import { renderStep, buildPalette } from "../../banner/renderer";
import type { PlayContext } from "../../banner/animator";

setDefaultTimeout(60_000);

let dir: string;
let prevDir: string | undefined;

beforeEach(() => {
  prevDir = process.env.TOOLNETCLI_CONFIG_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "p8-banner-"));
  process.env.TOOLNETCLI_CONFIG_DIR = dir;
  setNoColor(false);
  resetAppConfigCache();
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
  if (prevDir !== undefined) process.env.TOOLNETCLI_CONFIG_DIR = prevDir;
  else delete process.env.TOOLNETCLI_CONFIG_DIR;
  setNoColor(null);
  resetAppConfigCache();
});

/** Captures writes into a single string buffer. */
function capture(): { ctx: PlayContext; out: () => string } {
  let buf = "";
  const ctx: PlayContext = { cols: 120, rows: 40, write: (s: string) => void (buf += s) };
  return { ctx, out: () => buf };
}

// ---------------------------------------------------------------------------
// 1. Config key
// ---------------------------------------------------------------------------

describe("P8 — banner config key", () => {
  it("defaults to 'once'", () => {
    expect(DEFAULT_APP_CONFIG.banner).toBe("once");
    expect(loadAppConfig().config.banner).toBe("once");
  });

  it("validates only known values, falling back to 'once'", () => {
    for (const bad of ["always!", "ALWAYS", "", 1, null, undefined]) {
      expect(validateConfig({ ...DEFAULT_APP_CONFIG, banner: bad as never }).banner).toBe("once");
    }
    expect(validateConfig({ ...DEFAULT_APP_CONFIG, banner: "always" }).banner).toBe("always");
    expect(validateConfig({ ...DEFAULT_APP_CONFIG, banner: "never" }).banner).toBe("never");
  });

  it("survives a full persist + re-load round trip", () => {
    const { updateAppConfig } = require("../../lib/appConfig");
    updateAppConfig({ banner: "never" });
    resetAppConfigCache();
    expect(loadAppConfig().config.banner).toBe("never");
  });
});

// ---------------------------------------------------------------------------
// 2. Decision rules
// ---------------------------------------------------------------------------

describe("P8 — decision matrix", () => {
  it("flag parsing", () => {
    expect(parseBannerFlags(["--banner"])).toEqual({ force: true, disable: false });
    expect(parseBannerFlags(["--no-splash"])).toEqual({ force: false, disable: true });
    expect(parseBannerFlags(["--banner", "--no-splash"])).toEqual({ force: true, disable: true });
    expect(parseBannerFlags([])).toEqual({ force: false, disable: false });
  });

  const base = { flags: { force: false, disable: false }, setting: "once", seenOnce: false, isTty: true, headless: false, noColor: false };

  it("forces with --banner even after once-marker", () => {
    const d = resolveBannerDecision({ ...base, flags: { force: true, disable: false }, seenOnce: true });
    expect(d.run).toBe(true);
    expect(d.reason).toBe("force");
  });

  it("--no-splash wins over config", () => {
    const d = resolveBannerDecision({ ...base, flags: { force: false, disable: true }, setting: "always" });
    expect(d.run).toBe(false);
    expect(d.reason).toBe("no-splash");
  });

  it("NO_COLOR and non-TTY remain eligible for a static, geometry-preserving banner", () => {
    expect(resolveBannerDecision({ ...base, noColor: true }).run).toBe(true);
    expect(resolveBannerDecision({ ...base, isTty: false }).run).toBe(true);
    expect(resolveBannerDecision({ ...base, headless: true }).run).toBe(false);
  });

  it("'once' + seen → skip, 'once' + fresh → run", () => {
    expect(resolveBannerDecision(base).run).toBe(true);
    expect(resolveBannerDecision({ ...base, seenOnce: true }).run).toBe(false);
  });

  it("'always' runs regardless of marker; 'never' skips", () => {
    expect(resolveBannerDecision({ ...base, setting: "always", seenOnce: true }).run).toBe(true);
    expect(resolveBannerDecision({ ...base, setting: "never" }).run).toBe(false);
  });

  it("invalid config value falls back to 'once' safely", () => {
    const cfg = validateConfig({ banner: "bogus" });
    expect(resolveBannerDecision({ ...base, setting: cfg.banner }).run).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Responsive bands
// ---------------------------------------------------------------------------

describe("P8 — responsive variants", () => {
  it("full on 80+ column terminals", () => {
    expect(selectVariant(120, 40)).toBe("full");
    expect(selectVariant(80, 10)).toBe("full");
  });
  it("compact on 40–79 column terminals", () => {
    expect(selectVariant(60, 10)).toBe("compact");
    expect(selectVariant(40, 4)).toBe("compact");
  });
  it("static text on tiny ones", () => {
    expect(selectVariant(30, 40)).toBe("text");
    expect(selectVariant(120, 2)).toBe("text");
    expect(selectVariant(10, 10)).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// 4. Frames
// ---------------------------------------------------------------------------

describe("P8 — frames", () => {
  it("sprite dimensions and frame count match the half-block renderer", () => {
    expect(SPRITE_ROWS).toBe(20);
    expect(OUTPUT_ROWS).toBe(10);
    expect(FRAMES.length).toBe(10);
    for (const frame of ["open", "ear", "blink", "sparkle-l", "sparkle-r"]) {
      expect(FRAMES.some((f) => f.title === frame)).toBe(true);
    }
  });

  it("every base row is exactly 80 chars with only known glyphs", () => {
    const known = new Set(Object.keys(PALETTE).concat("."));
    for (const row of BASE) {
      expect(row.length).toBe(80);
      for (const ch of row) expect(known.has(ch)).toBe(true);
    }
  });

  it("step timeline is monotonic, complete, and under 3s", () => {
    const { steps, starts, totalMs } = buildSteps();
    expect(steps.length).toBe(5 + FRAMES.length + 3 + 1 + 4);
    for (let i = 1; i < starts.length; i++) expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1]);
    const sum = steps.reduce((a, s) => a + s.durationMs, 0);
    expect(totalMs).toBe(sum);
    expect(totalMs).toBeLessThan(3000);
    expect(starts[0]).toBe(0);
  });

  it("frames render viewable output rows with truecolor runs", () => {
    const { steps } = buildSteps();
    const live = steps.find((s) => s.rows.length === SPRITE_ROWS && s.opacity === 1)!;
    const pal = buildPalette(PALETTE, "#0A2430", 1, 1, 0, "#062B2C");
    const { spriteLines, outputRows } = renderStep(live, pal);
    expect(outputRows).toBe(OUTPUT_ROWS);
    expect(spriteLines.length).toBe(OUTPUT_ROWS);
    expect(spriteLines.join("")).toContain("\x1b[38;2;");
    expect(spriteLines.join("")).not.toContain("."); // no raw sprite chars leak
  });
});

// ---------------------------------------------------------------------------
// 5. Animators
// ---------------------------------------------------------------------------

describe("P8 — animators restore the cursor", () => {
  it("playFull hides first and shows + clears in the end", async () => {
    const { ctx, out } = capture();
    await playFull(ctx, "9.9.9-test");
    const text = out();
    expect(text.startsWith("\x1b[?25l")).toBe(true);
    expect(text).toContain("TOOLNET");
    expect(text).toContain("v9.9.9-test");
    expect(text.endsWith("\x1b[?25h\x1b[J\x1b[H")).toBe(true);
  });

  it("playCompact ends with cursor visible and a cleared line", async () => {
    const { ctx, out } = capture();
    await playCompact(ctx, "9.9.9-test");
    const text = out();
    expect(text.startsWith("\x1b[?25l")).toBe(true);
    expect(text).toContain("ToolNet CLI");
    expect(text.endsWith("\x1b[?25h\x1b[2K")).toBe(true);
  });

  it("mascot keeps its responsive geometry and survives NO_COLOR", () => {
    for (const cols of [40, 50, 60, 80, 120]) {
      const plain = renderMascotBanner(cols, MASCOT_TIMELINE.final, true);
      const colored = renderMascotBanner(cols, MASCOT_TIMELINE.final, false);
      const spriteRows = Math.ceil((32 * ({ 40: 20, 50: 22, 60: 24, 80: 28, 120: 28 } as Record<number, number>)[cols]) / 28);
      expect(plain.length).toBe(Math.ceil(spriteRows / 2) + 2);
      expect(plain.every((line) => visibleWidth(line) <= cols)).toBe(true);
      expect(mascotLineWidths(cols)).toEqual(plain.map(visibleWidth));
      expect(colored.map(visibleWidth)).toEqual(plain.map(visibleWidth));
      expect(plain.join("\n")).toContain("TOOLNET");
    }
  });

  it("mascot animation is abortable and restores the cursor", async () => {
    let output = "";
    const controller = new AbortController();
    const promise = playMascotBanner({ cols: 80, rows: 24, write: (value) => { output += value; } }, {
      signal: controller.signal,
      frameMs: 10,
      noColor: true,
      inPlace: true,
    });
    setTimeout(() => controller.abort(), 25);
    await expect(promise).rejects.toThrow("Mascot animation aborted");
    expect(output).toContain("\x1b[?25l");
    expect(output).toContain("\x1b[?25h");
  });

});

// ---------------------------------------------------------------------------
// 6. Integration & marker
// ---------------------------------------------------------------------------

describe("P8 — showBannerIfEligible integration", () => {
  const opts = (over: Record<string, unknown> = {}) =>
    ({
      cols: 120,
      rows: 40,
      isTty: true,
      homeDir: dir,
      version: "9.9.9-test",
      setting: "once",
      headless: false,
      write: (s: string) => void (captured += s),
      ...over,
    }) as any;

  let captured = "";

  beforeEach(() => {
    captured = "";
  });

  it("fresh 'once' run: shows full banner and writes the marker", async () => {
    const res = await showBannerIfEligible(opts());
    expect(res.shown).toBe(true);
    expect(res.variant).toBe("full");
    expect(hasBannerSeen(dir)).toBe(true);
    expect(fs.existsSync(bannerSeenPath(dir))).toBe(true);
  });

  it("second 'once' run: skipped because marker exists", async () => {
    markBannerSeen(dir);
    const res = await showBannerIfEligible(opts());
    expect(res.shown).toBe(false);
  });

  it("--banner forces a replay even when the marker exists", async () => {
    markBannerSeen(dir);
    const res = await showBannerIfEligible(opts({ argv: ["--banner"] }));
    expect(res.shown).toBe(true);
  });

  it("--no-splash suppresses even when 'always' and no marker", async () => {
    const res = await showBannerIfEligible(opts({ argv: ["--no-splash"], setting: "always" }));
    expect(res.shown).toBe(false);
    expect(hasBannerSeen(dir)).toBe(false);
  });

  it("headless suppresses, while non-TTY renders the final static banner", async () => {
    expect((await showBannerIfEligible(opts({ headless: true }))).shown).toBe(false);
    const result = await showBannerIfEligible(opts({ isTty: false, cols: 80, rows: 20 }));
    expect(result.shown).toBe(true);
    expect(captured).toContain("TOOLNET");
    expect(captured).not.toContain("\x1b[?25l");
    expect(hasBannerSeen(dir)).toBe(false);
  });

  it("NO_COLOR renders the same final geometry without color escapes", async () => {
    setNoColor(true);
    const result = await showBannerIfEligible(opts({ cols: 80, rows: 20 }));
    expect(result.shown).toBe(true);
    expect(captured).toContain("TOOLNET");
    expect(captured).not.toContain("\x1b[38;2;");
    setNoColor(false);
    expect(hasBannerSeen(dir)).toBe(true);
  });

  it("uses the mascot by default and B2 only when mascot is disabled", async () => {
    const previousMascot = process.env.TOOLNETCLI_MASCOT;
    try {
      delete process.env.TOOLNETCLI_MASCOT;
      await showBannerIfEligible(opts({ isTty: false, cols: 80, rows: 20 }));
      expect(captured).toContain("TOOLNET");
      expect(captured).not.toContain("◇");

      captured = "";
      process.env.TOOLNETCLI_MASCOT = "0";
      await showBannerIfEligible(opts({ isTty: false, cols: 80, rows: 20 }));
      expect(captured).toContain("◇");
    } finally {
      if (previousMascot === undefined) delete process.env.TOOLNETCLI_MASCOT;
      else process.env.TOOLNETCLI_MASCOT = previousMascot;
    }
  });

  it("medium terminals use B2 fallback when the mascot cannot fit vertically", async () => {
    const res = await showBannerIfEligible(opts({ isTty: false, cols: 60, rows: 10, argv: ["--banner"] }));
    expect(res.shown).toBe(true);
    expect(captured).toContain("◇");
    expect(captured).not.toContain("AI CODING CLI");
  });

  it("'never' and invalid config values never show or mark", async () => {
    expect((await showBannerIfEligible(opts({ setting: "never" }))).shown).toBe(false);
    expect((await showBannerIfEligible(opts({ setting: "bogus" }))).shown).toBe(true); // falls back to once
    expect(hasBannerSeen(dir)).toBe(true);
  });

  it("medium terminal degrades to compact B2", async () => {
    markBannerSeen(dir);
    const res = await showBannerIfEligible(opts({ cols: 60, rows: 10, argv: ["--banner"] }));
    expect(res.shown).toBe(true);
    expect(res.variant).toBe("compact");
  });
});