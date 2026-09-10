/**
 * P8 — Startup banner (wordmark) tests.
 *
 * Locks in the ToolNet startup wordmark (◇ symbol + TOOLNET lettering):
 *  1. `banner` config key: default "once", validated on load/set.
 *  2. Decision rules: no-color / headless / non-TTY / `--no-splash` skip;
 *     `--banner` forces; `once` marker short-circuits; `never` skips.
 *  3. Responsive bands: large terminal → full lockup, medium → compact,
 *     tiny → single-line ◇ ToolNet CLI text.
 *  4. Wordmark geometry: sub-second timeline, symbol + lettering inside
 *     width at every band, cursor restored by the animation.
 *  5. `once` persists a `.banner-shown` marker in the toolnet home dir.
 */

import { describe, it, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setNoColor } from "../../term";
import { stripAnsi, visibleWidth } from "../../tui/layout";
import { DEFAULT_APP_CONFIG, validateConfig, loadAppConfig, resetAppConfigCache } from "../../lib/appConfig";
import { resolveBannerDecision, parseBannerFlags } from "../../banner/config";
import { selectVariant } from "../../banner/terminal";
import { hasBannerSeen, markBannerSeen, bannerSeenPath, showBannerIfEligible } from "../../banner/banner";
import { playB2Banner, renderB2Banner, B2_TIMELINE, type BannerPlayContext } from "../../banner/b2Banner";

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
function capture(): { ctx: BannerPlayContext; out: () => string } {
  let buf = "";
  const ctx: BannerPlayContext = { cols: 120, rows: 40, write: (s: string) => void (buf += s) };
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
// 4. Wordmark geometry
// ---------------------------------------------------------------------------

describe("P8 — wordmark geometry", () => {
  it("renders the compact ◇ symbol lockup on narrow terminals and the figlet wordmark on wide ones", () => {
    for (const cols of [40, 50, 60, 80, 120]) {
      const lines = renderB2Banner(cols, B2_TIMELINE.final, true);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((line) => visibleWidth(line) <= cols)).toBe(true);
      const text = lines.join("\n");
      expect(text).not.toContain("▄▄▄▄▄▄▄▄▄"); // no pixel mascot anywhere
      if (cols < 80) {
        expect(text).toContain("◇");
        expect(text).toContain("TOOLNET"); // clean text wordmark
      } else {
        expect(text).toContain("████████╗"); // figlet T glyph
        expect(text).not.toContain("◇");
      }
    }
  });

  it("uses the compact three-row lockup below 80 columns and the seven-row desktop lockup at 80+", () => {
    for (const cols of [40, 50, 60]) expect(renderB2Banner(cols, B2_TIMELINE.final, true).length).toBe(3);
    for (const cols of [80, 120]) expect(renderB2Banner(cols, B2_TIMELINE.final, true).length).toBe(7);
  });

  it("timeline is sub-second and monotonic", () => {
    const entries = Object.entries(B2_TIMELINE);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i][1]).toBeGreaterThanOrEqual(entries[i - 1][1]);
    }
    expect(B2_TIMELINE.final).toBeLessThan(1000);
    expect(B2_TIMELINE.core).toBeGreaterThan(0);
  });

  it("NO_COLOR keeps identical geometry without color escapes", () => {
    for (const cols of [40, 60, 80, 120]) {
      const plain = renderB2Banner(cols, B2_TIMELINE.final, true);
      const colored = renderB2Banner(cols, B2_TIMELINE.final, false);
      expect(colored.map(visibleWidth)).toEqual(plain.map(visibleWidth));
      expect(colored.join("")).toContain("\x1b[");
      expect(plain.join("")).not.toContain("\x1b[");
    }
  });

  it("animation restores the cursor exactly once and ends on the final lockup", async () => {
    const { ctx, out } = capture();
    await playB2Banner(ctx, { animate: true, inPlace: true, noColor: true, frameMs: 50 });
    const text = out();
    expect(text.startsWith("\x1b[?25l")).toBe(true);
    expect((text.match(/\x1b\[\?25l/g) ?? []).length).toBe(1);
    expect((text.match(/\x1b\[\?25h/g) ?? []).length).toBe(1);
    expect(text).toContain("████████╗"); // figlet TOOLNET
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
    expect(captured).toContain("████████╗");
    expect(captured).toContain("AgentHarness 2.0");
    expect(captured).not.toContain("\x1b[?25l");
    expect(hasBannerSeen(dir)).toBe(false);
  });

  it("NO_COLOR renders the same final geometry without color escapes", async () => {
    setNoColor(true);
    const result = await showBannerIfEligible(opts({ cols: 80, rows: 20 }));
    expect(result.shown).toBe(true);
    expect(captured).toContain("████████╗");
    expect(captured).not.toContain("\x1b[38;2;");
    setNoColor(false);
    expect(hasBannerSeen(dir)).toBe(true);
  });

  it("always uses the wordmark — full lockup on desktop, compact on narrow", async () => {
    await showBannerIfEligible(opts({ isTty: false, cols: 80, rows: 20 }));
    expect(stripAnsi(captured)).toContain("████████╗");
    expect(captured).toContain("AgentHarness 2.0");
    expect(captured).not.toContain("\x1b[?25l");

    captured = "";
    await showBannerIfEligible(opts({ isTty: false, cols: 60, rows: 10, argv: ["--banner"] }));
    expect(captured).toContain("◇");
    expect(captured).not.toContain("AgentHarness 2.0"); // compact band omits the long tagline
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