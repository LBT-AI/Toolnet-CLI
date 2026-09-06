import type { BannerDecision, BannerSetting } from "./types";
import { BANNER_SETTINGS } from "./types";

export const FLAG_FORCE = "--banner";
export const FLAG_DISABLE = "--no-splash";

export type FlagShape = { force: boolean; disable: boolean };

export function parseBannerFlags(argv: string[]): FlagShape {
  const force = argv.includes(FLAG_FORCE);
  const disable = argv.includes(FLAG_DISABLE);
  return { force, disable };
}

export function isKnownBannerSetting(value: unknown): value is BannerSetting {
  return typeof value === "string" && (BANNER_SETTINGS as readonly string[]).includes(value);
}

export function resolveBannerDecision(input: {
  flags: FlagShape;
  setting: unknown;
  seenOnce: boolean;
  isTty: boolean;
  headless: boolean;
  noColor: boolean;
}): BannerDecision {
  if (input.noColor) return { run: false, variant: "text", reason: "no-color" };
  if (input.headless) return { run: false, variant: "text", reason: "headless" };
  if (input.flags.force) return { run: true, variant: "full", reason: "force" };
  if (input.flags.disable) return { run: false, variant: "text", reason: "no-splash" };
  if (!input.isTty) return { run: false, variant: "text", reason: "no-tty" };

  const setting: BannerSetting = isKnownBannerSetting(input.setting) ? input.setting : "once";
  if (setting === "never") return { run: false, variant: "text", reason: "never" };
  if (setting === "always") return { run: true, variant: "full", reason: "setting-always" };
  if (setting === "once" && input.seenOnce) return { run: false, variant: "text", reason: "setting-once" };
  return { run: true, variant: "full", reason: "setting-once" };
}