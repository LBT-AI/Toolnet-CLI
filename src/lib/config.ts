/**
 * Compatibility adapter over appConfig.ts.
 *
 * Prevents dual-schema conflict and file overwrite of ~/.toolnetcli/config.json.
 * All reads and writes are safely routed through appConfig.ts (source of truth).
 */

import {
  getAppConfig,
  updateAppConfig,
  getAppConfigPath,
  type AppConfig,
  type SandboxMode,
} from "./appConfig";

export interface CliConfig {
  baseUrl: string | null;
  defaultModel: string;
  theme: string;
  rtkEnabled: boolean;
  sandboxMode: SandboxMode;
  sessionNames: Record<string, string>;
  sessionOrder: string[];
  lastSession: string | null;
}

export const DEFAULT_CONFIG: CliConfig = {
  baseUrl: null,
  defaultModel: "",
  theme: "dark",
  rtkEnabled: true,
  sandboxMode: "ask",
  sessionNames: {},
  sessionOrder: [],
  lastSession: null,
};

export function loadConfig(): CliConfig {
  const appCfg = getAppConfig();
  return {
    baseUrl: appCfg.baseUrl,
    defaultModel: appCfg.defaultModel,
    theme: appCfg.theme,
    rtkEnabled: true,
    sandboxMode: appCfg.sandboxMode,
    sessionNames: {},
    sessionOrder: [],
    lastSession: null,
  };
}

export function saveConfig(): void {
  // Source of truth is appConfig.ts — no-op to prevent schema stripping
}

export function getConfig(): CliConfig {
  return loadConfig();
}

export function updateConfig(partial: Partial<CliConfig>): void {
  const updatePayload: Partial<AppConfig> = {};
  if (partial.baseUrl !== undefined) updatePayload.baseUrl = partial.baseUrl;
  if (partial.defaultModel !== undefined) updatePayload.defaultModel = partial.defaultModel;
  if (partial.theme !== undefined) updatePayload.theme = partial.theme;
  if (partial.sandboxMode !== undefined) updatePayload.sandboxMode = partial.sandboxMode;
  updateAppConfig(updatePayload);
}

export function getConfigPath(): string {
  return getAppConfigPath();
}
