import fs from "node:fs";
import path from "node:path";
import { getToolnetHome } from "../lib/toolnetHome";
import { loadAppConfig } from "../lib/appConfig";
import { isNoColor } from "../term";
import { parseBannerFlags, resolveBannerDecision, isKnownBannerSetting } from "./config";
import { playB2Banner, printToolNetBanner, type BannerPlayContext } from "./b2Banner";
import { selectVariant } from "./terminal";
import { getVersion } from "../lib/version";
import type { BannerDecision, BannerSetting, DoneInfo } from "./types";

const BANNER_MARKER = ".banner-shown";

export function bannerSeenPath(homeDir: string): string {
  return path.join(homeDir, BANNER_MARKER);
}

export function hasBannerSeen(homeDir: string): boolean {
  try {
    return fs.existsSync(bannerSeenPath(homeDir));
  } catch {
    return false;
  }
}

export function markBannerSeen(homeDir: string): void {
  try {
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(bannerSeenPath(homeDir), new Date().toISOString(), "utf8");
  } catch {
    // Non-fatal: "once" may re-play if the marker cannot be persisted.
  }
}

function currentSetting(): unknown {
  try {
    const { config } = loadAppConfig();
    return config.banner;
  } catch {
    return "once";
  }
}

function isHeadlessEnv(): boolean {
  return process.env.TOOLNET_HEADLESS === "1" || process.env.CI === "true";
}

export interface ShowBannerOptions {
  argv?: string[];
  cols?: number;
  rows?: number;
  isTty?: boolean;
  homeDir?: string;
  version?: string;
  setting?: unknown;
  headless?: boolean;
  write?: (s: string, flush?: boolean) => void;
}

export async function showBannerIfEligible(opts: ShowBannerOptions = {}): Promise<DoneInfo> {
  const argv = opts.argv ?? process.argv.slice(2);
  const cols = Math.max(1, opts.cols ?? process.stdout.columns ?? 100);
  const rows = Math.max(1, opts.rows ?? process.stdout.rows ?? 30);
  const isTty = opts.isTty ?? process.stdout.isTTY === true;
  const homeDir = opts.homeDir ?? getToolnetHome();
  const setting: unknown = opts.setting !== undefined ? opts.setting : currentSetting();
  const noColor = isNoColor();
  const seenOnce = hasBannerSeen(homeDir);
  const purposeSetting: BannerSetting = isKnownBannerSetting(setting) ? setting : "once";

  const decision: BannerDecision = resolveBannerDecision({
    flags: parseBannerFlags(argv),
    setting,
    seenOnce,
    isTty,
    headless: opts.headless ?? isHeadlessEnv(),
    noColor,
  });

  if (!decision.run) return { shown: false, variant: "text" };

  const variant = selectVariant(cols, rows);
  const ctx: BannerPlayContext = {
    cols,
    rows,
    write: opts.write ?? ((value: string) => process.stdout.write(value)),
  };

  try {
    if (variant === "text") {
      // Only terminals too short to hold the compact four-row lockup use a
      // single line. This is still static and never scrolls the terminal.
      ctx.write(`◇ ToolNet CLI${noColor ? "" : "\x1b[0m"}\n`);
    } else {
      await playB2Banner(ctx, {
        noColor,
        animate: isTty && process.env.TOOLNETCLI_ANIMATIONS !== "0",
        inPlace: isTty,
        tagline: `AI Coding CLI · v${opts.version ?? getVersion()} · AgentHarness 2.0`,
      });
    }
  } finally {
    if (decision.reason === "setting-once" && purposeSetting === "once" && isTty) markBannerSeen(homeDir);
  }

  return { shown: true, variant };
}

export { printToolNetBanner };
export type { BannerSetting };
