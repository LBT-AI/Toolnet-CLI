/**
 * Canonical user configuration for ToolNet CLI.
 *
 * Location: ~/.toolnetcli/config.json  (override: TOOLNETCLI_CONFIG_DIR)
 *
 * Features:
 * - typed schema + defaults
 * - schemaVersion field with migration mechanism
 * - validation of every known field
 * - secrets are NOT stored here — API keys live in the key manager
 *   (`src/lib/keys.ts`, file mode 0600)
 *
 * Schema v2 (current):
 * - gatewayUrl defaults to null (no mandatory localhost connection)
 * - provider field added (references src/providers/registry)
 * - No hardcoded gateway URLs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getToolnetConfigPath, getToolnetHome } from "./toolnetHome";

export const CURRENT_SCHEMA_VERSION = 2;

export type SandboxMode = "workspace" | "ask" | "full-access";
export const SANDBOX_MODES: SandboxMode[] = ["workspace", "ask", "full-access"];

export interface AppConfig {
  schemaVersion: number;
  /** Gateway URL, or null when not using ToolNet gateway. Default: null */
  gatewayUrl: string | null;
  /** API base URL for direct provider mode (legacy alias for gatewayUrl migration). */
  apiUrl: string | null;
  /** Provider name for the stored key (see src/lib/keys.ts). */
  keyProvider: string | null;
  /** Active provider ID from src/providers/registry, or null if none configured. */
  provider: string | null;
  /** Base URL for the active provider (null = use provider default). */
  baseUrl: string | null;
  defaultModel: string;
  sandboxMode: SandboxMode;
  theme: string;
  /** Auto-update check cadence in hours (24 or 168). */
  updateCheckIntervalHours: number;
  updateCheckEnabled: boolean;
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  gatewayUrl: null,
  apiUrl: null,
  keyProvider: null,
  provider: null,
  baseUrl: null,
  defaultModel: "",
  sandboxMode: "workspace",
  theme: "dark",
  updateCheckIntervalHours: 24,
  updateCheckEnabled: true,
};

/** Fields that may be carried over from the legacy ~/.toolnetapi/config.json. */
const MIGRATABLE_FIELDS = [
  "baseUrl",
  "defaultModel",
  "theme",
  "sandboxMode",
] as const;

export function getConfigDir(): string {
  // Phase 3: canonical home module is the single source of truth.
  return getToolnetHome();
}

export function getAppConfigPath(): string {
  return getToolnetConfigPath();
}

function legacyConfigPath(): string {
  if (process.env.DATA_DIR) return path.join(process.env.DATA_DIR, "config.json");
  return path.join(os.homedir(), ".toolnetapi", "config.json");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validates/coerces a parsed JSON object into an AppConfig.
 * Unknown/invalid fields fall back to defaults instead of crashing.
 */
export function validateConfig(input: unknown): AppConfig {
  const cfg: AppConfig = { ...DEFAULT_APP_CONFIG };
  if (!isRecord(input)) return cfg;

  const num = input.schemaVersion;
  if (typeof num === "number" && Number.isInteger(num) && num >= 1) {
    cfg.schemaVersion = Math.min(num, CURRENT_SCHEMA_VERSION);
  }

  for (const key of ["gatewayUrl", "apiUrl", "keyProvider", "provider", "baseUrl"] as const) {
    const v = input[key];
    if (v === null || typeof v === "string") cfg[key] = v as string | null;
  }
  if (typeof input.defaultModel === "string" && input.defaultModel.trim()) {
    cfg.defaultModel = input.defaultModel.trim();
  }
  if (
    typeof input.sandboxMode === "string" &&
    SANDBOX_MODES.includes(input.sandboxMode as SandboxMode)
  ) {
    cfg.sandboxMode = input.sandboxMode as SandboxMode;
  }
  if (typeof input.theme === "string" && input.theme.trim()) {
    cfg.theme = input.theme.trim();
  }
  if (typeof input.updateCheckEnabled === "boolean") {
    cfg.updateCheckEnabled = input.updateCheckEnabled;
  }
  const interval = input.updateCheckIntervalHours;
  if (typeof interval === "number" && Number.isFinite(interval) && interval >= 1) {
    cfg.updateCheckIntervalHours = Math.floor(interval);
  }

  return cfg;
}

/** Migrate older/legacy configs forward to the current schema version. */
function migrateConfig(raw: Record<string, unknown>): AppConfig {
  let cfg = validateConfig(raw);

  // v1 → v2 migration: gatewayUrl becomes null, provider field added
  if (cfg.schemaVersion < 2) {
    // If gatewayUrl was the old default, set it to null
    if (cfg.gatewayUrl === "http://127.0.0.1:20127") {
      cfg.gatewayUrl = null;
    }
    // If apiUrl was set and gatewayUrl is null, prefer apiUrl as baseUrl
    if (!cfg.gatewayUrl && cfg.apiUrl) {
      cfg.baseUrl = cfg.apiUrl;
    }
    // If gatewayUrl was set to something non-default, keep it but also set baseUrl
    if (cfg.gatewayUrl && cfg.gatewayUrl !== "http://127.0.0.1:20127") {
      cfg.baseUrl = cfg.gatewayUrl;
    }
    // Map keyProvider to provider if gateway was in use
    if (cfg.keyProvider && !cfg.provider) {
      cfg.provider = cfg.keyProvider;
    }
    cfg.schemaVersion = CURRENT_SCHEMA_VERSION;
  }

  // Legacy flat config from ~/.toolnetapi/config.json (no schemaVersion).
  if (!isRecord(raw) || raw.schemaVersion === undefined) {
    let migrated = false;
    for (const field of MIGRATABLE_FIELDS) {
      const value = raw[field];
      if (value === undefined) continue;
      migrated = true;
      if (field === "baseUrl") {
        // Legacy baseUrl → store as baseUrl, not gatewayUrl
        cfg.baseUrl = typeof value === "string" ? value : null;
      } else if (field === "defaultModel" && typeof value === "string") {
        cfg.defaultModel = value;
      } else if (field === "theme" && typeof value === "string") {
        cfg.theme = value;
      } else if (field === "sandboxMode" && typeof value === "string") {
        cfg.sandboxMode = validateConfig({ sandboxMode: value }).sandboxMode;
      }
    }
    if (migrated) cfg.schemaVersion = CURRENT_SCHEMA_VERSION;
  }

  cfg.schemaVersion = CURRENT_SCHEMA_VERSION;
  return cfg;
}

let cachedConfig: AppConfig | null = null;

export function resetAppConfigCache(): void {
  cachedConfig = null;
}

export interface LoadResult {
  config: AppConfig;
  created: boolean;
  migratedFromLegacy: boolean;
}

export function loadAppConfig(): LoadResult {
  if (cachedConfig) return { config: cachedConfig, created: false, migratedFromLegacy: false };

  const file = getAppConfigPath();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const config = migrateConfig(raw);
    cachedConfig = config;
    saveAppConfig(config); // persist migrations
    return { config, created: false, migratedFromLegacy: raw.schemaVersion === undefined };
  } catch {
    // No config yet (or unreadable) -> migrate whatever exists from legacy location.
    try {
      const legacy = JSON.parse(fs.readFileSync(legacyConfigPath(), "utf8"));
      const config = { ...migrateConfig(legacy), schemaVersion: CURRENT_SCHEMA_VERSION };
      cachedConfig = config;
      saveAppConfig(config);
      return { config, created: true, migratedFromLegacy: true };
    } catch {
      const config = { ...DEFAULT_APP_CONFIG };
      cachedConfig = config;
      return { config, created: false, migratedFromLegacy: false };
    }
  }
}

export function getAppConfig(): AppConfig {
  return loadAppConfig().config;
}

export function appConfigExists(): boolean {
  try {
    return fs.existsSync(getAppConfigPath());
  } catch {
    return false;
  }
}

export function saveAppConfig(config: AppConfig): void {
  const dir = getConfigDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getAppConfigPath(), JSON.stringify(config, null, 2) + "\n", "utf8");
    cachedConfig = config;
  } catch {
    // Non-fatal: CLI keeps working with in-memory config.
  }
}

export function updateAppConfig(partial: Partial<AppConfig>): AppConfig {
  const current = getAppConfig();
  const next = validateConfig({ ...current, ...partial, schemaVersion: CURRENT_SCHEMA_VERSION });
  saveAppConfig(next);
  return next;
}
