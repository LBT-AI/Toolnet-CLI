import fs from "node:fs";
import path from "node:path";
import { getToolnetHome } from "../lib/toolnetHome";
import { loadAppConfig } from "../lib/appConfig";
import { isNoColor } from "../term";
import { parseBannerFlags, resolveBannerDecision, isKnownBannerSetting } from "./config";
import { playCompact, playFull, playText, type PlayContext } from "./animator";
import { selectVariant } from "./terminal";
import type { BannerDecision, BannerSetting, DoneInfo } from "./types";
import { printToolNetBanner } from "./toolnet-banner";
import { getVersion } from "../lib/version";

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
  const cols = opts.cols ?? process.stdout.columns ?? 100;
  const rows = opts.rows ?? process.stdout.rows ?? 30;
  const isTty = opts.isTty ?? process.stdout.isTTY === true;
  const homeDir = opts.homeDir ?? getToolnetHome();
  const version = opts.version;
  const setting: unknown = opts.setting !== undefined ? opts.setting : currentSetting();
  const headless = opts.headless ?? isHeadlessEnv();
  const noColor = isNoColor();
  const seenOnce = hasBannerSeen(homeDir);
  const purposeSetting: BannerSetting = isKnownBannerSetting(setting) ? setting : "once";

  const decision: BannerDecision = resolveBannerDecision({
    flags: parseBannerFlags(argv),
    setting,
    seenOnce,
    isTty,
    headless,
    noColor,
  });

  if (!decision.run) return { shown: false, variant: "text" };

  const variant = selectVariant(cols, rows);
  const ctx: PlayContext = {
    cols: Math.max(20, cols),
    rows: Math.max(5, rows),
    write: opts.write ?? ((s: string) => process.stdout.write(s)),
  };

  try {
    if (variant === "full") {
      if (opts.write) {
        await playFull(ctx, version);
      } else {
        await printToolNetBanner("TOOLNET", version ?? getVersion());
      }
    } else if (variant === "compact") {
      await playCompact(ctx, version);
    } else {
      await playText(ctx, version);
    }
  } finally {
    if (decision.reason === "setting-once" && purposeSetting === "once") markBannerSeen(homeDir);
  }

  return { shown: true, variant };
}

export { printToolNetBanner };
export type { BannerSetting };