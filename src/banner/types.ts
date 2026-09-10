export type BannerVariant = "full" | "compact" | "text";

export type BannerSetting = "once" | "always" | "never";

export interface BannerDecision {
  run: boolean;
  variant: BannerVariant;
  reason: "force" | "setting-once" | "setting-always" | "never" | "no-config-banner" | "no-tty" | "no-color" | "headless" | "no-splash";
}

export interface DoneInfo {
  shown: boolean;
  variant: BannerVariant;
}

export const BANNER_SETTINGS: readonly BannerSetting[] = ["once", "always", "never"];