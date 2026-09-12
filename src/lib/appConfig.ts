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
 * Schema v2:
 * - gatewayUrl defaults to null (no mandatory localhost connection)
 * - provider field added (references src/providers/registry)
 * - No hardcoded gateway URLs
 *
 * Schema v3 (current):
 * - `routing` block added (Phase 80): default profile, policy, fallback chain,
 *   attempt bound and excluded providers. Backward compatible — a v2 config
 *   migrates by gaining the defaults.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getToolnetConfigPath, getToolnetHome } from "./toolnetHome";
import { BANNER_SETTINGS } from "../banner/types";
import type { BannerSetting } from "../banner/types";

export const CURRENT_SCHEMA_VERSION = 5;

export type SandboxMode = "workspace" | "ask" | "full-access";
export const SANDBOX_MODES: SandboxMode[] = ["workspace", "ask", "full-access"];

/**
 * Phase 80 — persisted routing settings. Stored in the canonical config file;
 * no second config owner is introduced.
 */
export interface AppRoutingSettings {
  /** Default routing profile (`auto`, `quality`, `coding`, ...). */
  profile: string;
  /** Default ordering policy (`priority`, `cheapest`, `fastest`, ...). */
  policy: string;
  /** Ordered fallback model references. */
  fallback: string[];
  /** Attempts per routing decision, including the head. */
  maxAttempts: number;
  /** Providers never considered unless explicitly named. */
  excludedProviders: string[];
  /**
   * Phase 82 — provider/upstream ordering policy (`priority`, `cheapest`,
   * `fastest`, `balanced`, `reliability-first`).
   */
  providerPolicy: string;
  /** Phase 82 — absolute veto on provider/upstream fallback for a request. */
  allowProviderFallback: boolean;
}

export const DEFAULT_ROUTING_SETTINGS: AppRoutingSettings = {
  profile: "auto",
  policy: "priority",
  fallback: [],
  maxAttempts: 3,
  excludedProviders: [],
  providerPolicy: "priority",
  allowProviderFallback: true,
};

/**
 * Phase 81 — persisted harness profile selection. Stored in the canonical
 * config file; no second config owner is introduced.
 *
 * Harness and routing are independent axes: `routing.profile` picks which model
 * serves a request, `harness.profile` picks the policy contract that runs it.
 */
export interface AppHarnessSettings {
  /** Default harness profile id (`default`, `minimal`, `coding`, ...). */
  profile: string;
}

export const DEFAULT_HARNESS_SETTINGS: AppHarnessSettings = {
  profile: "default",
};

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
  /** Startup banner: "once" (default) | "always" | "never". */
  banner: BannerSetting;
  /** Phase 80 — provider/model routing settings. */
  routing: AppRoutingSettings;
  /** Phase 81 — harness profile (policy) settings. */
  harness: AppHarnessSettings;
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
  banner: "once",
  routing: { ...DEFAULT_ROUTING_SETTINGS },
  harness: { ...DEFAULT_HARNESS_SETTINGS },
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
  if (
    typeof input.banner === "string" &&
    (BANNER_SETTINGS as readonly string[]).includes(input.banner)
  ) {
    cfg.banner = input.banner as BannerSetting;
  }

  cfg.routing = validateRoutingSettings(input.routing);
  cfg.harness = validateHarnessSettings(input.harness);

  return cfg;
}

/**
 * Coerce an unknown `harness` block into valid settings.
 *
 * The id is validated SYNTACTICALLY here, not against the registry: a
 * hand-edited config must never brick the CLI, and silently rewriting a
 * mistyped id would hide the mistake. The CLI (`toolnet harness use`) validates
 * against the registry before persisting, and `toolnet harness current` reports
 * an id the registry does not know.
 */
export function validateHarnessSettings(input: unknown): AppHarnessSettings {
  const out: AppHarnessSettings = { ...DEFAULT_HARNESS_SETTINGS };
  if (!isRecord(input)) return out;
  if (typeof input.profile !== "string") return out;
  const profile = input.profile.trim().toLowerCase();
  if (!profile || /\s/.test(profile)) return out;
  out.profile = profile;
  return out;
}

/**
 * Coerce an unknown `routing` block into valid settings. Invalid fields fall
 * back to defaults rather than throwing — a hand-edited config must not brick
 * the CLI. Model references are validated by the router, not here.
 */
export function validateRoutingSettings(input: unknown): AppRoutingSettings {
  const out: AppRoutingSettings = { ...DEFAULT_ROUTING_SETTINGS };
  if (!isRecord(input)) return out;

  if (typeof input.profile === "string" && input.profile.trim()) {
    out.profile = input.profile.trim().toLowerCase();
  }
  if (typeof input.policy === "string" && input.policy.trim()) {
    out.policy = input.policy.trim().toLowerCase();
  }
  if (Array.isArray(input.fallback)) {
    out.fallback = input.fallback
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && !/\s/.test(entry));
  }
  if (
    typeof input.maxAttempts === "number" &&
    Number.isFinite(input.maxAttempts) &&
    input.maxAttempts >= 1 &&
    input.maxAttempts <= 10
  ) {
    out.maxAttempts = Math.floor(input.maxAttempts);
  }
  if (Array.isArray(input.excludedProviders)) {
    out.excludedProviders = input.excludedProviders
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);
  }
  // Phase 82 — provider/upstream ordering + fallback veto.
  if (typeof input.providerPolicy === "string" && input.providerPolicy.trim()) {
    out.providerPolicy = input.providerPolicy.trim().toLowerCase();
  }
  if (typeof input.allowProviderFallback === "boolean") {
    out.allowProviderFallback = input.allowProviderFallback;
  }
  return out;
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

  // v2 → v3 migration: add the routing block without touching anything else.
  if (cfg.schemaVersion < 3) {
    cfg.routing = validateRoutingSettings((raw as Record<string, unknown>).routing);
    cfg.schemaVersion = 3;
  }

  // v3 → v4 migration (Phase 81): add the harness block.
  if (cfg.schemaVersion < 4) {
    cfg.harness = validateHarnessSettings((raw as Record<string, unknown>).harness);
    cfg.schemaVersion = 4;
  }

  // v4 → v5 migration (Phase 82): add the provider routing policy/fallback veto.
  if (cfg.schemaVersion < 5) {
    cfg.routing = validateRoutingSettings({ ...cfg.routing, ...(raw as Record<string, unknown>).routing as object });
    cfg.schemaVersion = 5;
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
