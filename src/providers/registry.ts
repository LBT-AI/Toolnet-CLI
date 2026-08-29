/**
 * Provider Registry for ToolNet CLI.
 *
 * Manages provider configurations, active provider selection,
 * and provides the runtime provider instance.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Provider, ProviderConfig } from "./types";
import { OpenAICompatibleProvider } from "./openaiCompatible";

export const PROVIDERS_CONFIG_DIR = (() => {
  if (process.env.TOOLNETCLI_CONFIG_DIR) return process.env.TOOLNETCLI_CONFIG_DIR;
  return path.join(os.homedir(), ".toolnetcli");
})();

export const PROVIDERS_CONFIG_FILE = path.join(PROVIDERS_CONFIG_DIR, "providers.json");

export interface StoredProvidersConfig {
  schemaVersion: number;
  providers: ProviderConfig[];
  activeProviderId: string | null;
}

const DEFAULT_CONFIG: StoredProvidersConfig = {
  schemaVersion: 1,
  providers: [],
  activeProviderId: null,
};

let cachedConfig: StoredProvidersConfig | null = null;

function ensureDir(): void {
  try {
    fs.mkdirSync(PROVIDERS_CONFIG_DIR, { recursive: true });
  } catch {}
}

export function loadProvidersConfig(): StoredProvidersConfig {
  if (cachedConfig) return cachedConfig;
  ensureDir();
  try {
    const raw = fs.readFileSync(PROVIDERS_CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    cachedConfig = { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    cachedConfig = { ...DEFAULT_CONFIG };
  }
  return cachedConfig!;
}

export function saveProvidersConfig(config: StoredProvidersConfig): void {
  ensureDir();
  try {
    fs.writeFileSync(PROVIDERS_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf8");
    cachedConfig = config;
  } catch {}
}

export function resetProvidersConfigCache(): void {
  cachedConfig = null;
}

/**
 * Resolve the API key for a provider config.
 * Priority: apiKeyEnv (env var) > apiKey (inline) > null
 */
export function resolveApiKey(config: ProviderConfig): string | null {
  if (config.apiKeyEnv) {
    const val = process.env[config.apiKeyEnv];
    if (val) return val.trim();
  }
  if (config.apiKey) return config.apiKey;
  return null;
}

/**
 * Get all stored provider configurations.
 */
export function listProviders(): ProviderConfig[] {
  return loadProvidersConfig().providers;
}

/**
 * Get the currently active provider config, or null if none.
 */
export function getActiveProviderConfig(): ProviderConfig | null {
  const cfg = loadProvidersConfig();
  if (!cfg.activeProviderId) return null;
  return cfg.providers.find((p) => p.id === cfg.activeProviderId) ?? null;
}

/**
 * Add or update a provider configuration.
 */
export function addProvider(config: ProviderConfig): void {
  const cfg = loadProvidersConfig();
  const idx = cfg.providers.findIndex((p) => p.id === config.id);
  if (idx >= 0) {
    cfg.providers[idx] = config;
  } else {
    cfg.providers.push(config);
  }
  saveProvidersConfig(cfg);
}

/**
 * Remove a provider by ID.
 */
export function removeProvider(id: string): boolean {
  const cfg = loadProvidersConfig();
  const before = cfg.providers.length;
  cfg.providers = cfg.providers.filter((p) => p.id !== id);
  if (cfg.activeProviderId === id) {
    cfg.activeProviderId = null;
  }
  saveProvidersConfig(cfg);
  return cfg.providers.length < before;
}

/**
 * Set the active provider by ID.
 */
export function setActiveProvider(id: string): boolean {
  const cfg = loadProvidersConfig();
  const exists = cfg.providers.some((p) => p.id === id);
  if (!exists) return false;
  cfg.activeProviderId = id;
  saveProvidersConfig(cfg);
  return true;
}

/**
 * Create a Provider instance from a ProviderConfig.
 */
export function createProviderInstance(config: ProviderConfig): Provider {
  const providerType = config.type || config.id;

  if (providerType === "toolnet") {
    const { ToolNetProvider } = require("./toolnet") as typeof import("./toolnet");
    return new ToolNetProvider(config);
  }

  if (providerType === "anthropic" || config.id === "anthropic") {
    const { AnthropicProvider } = require("./anthropic") as typeof import("./anthropic");
    return new AnthropicProvider(config);
  }

  if (providerType === "gemini" || providerType === "google" || config.id === "gemini" || config.id === "google") {
    const { GeminiProvider } = require("./gemini") as typeof import("./gemini");
    return new GeminiProvider(config);
  }

  // Default: OpenAI-compatible
  return new OpenAICompatibleProvider(config);
}

/**
 * Get the active Provider instance, or null if no provider configured.
 */
export function getActiveProvider(): Provider | null {
  const config = getActiveProviderConfig();
  if (!config) return null;
  return createProviderInstance(config);
}

/**
 * Resolve the base URL for API calls.
 * Returns the active provider's baseUrl, or null if no provider configured.
 */
export function getActiveBaseUrl(): string | null {
  const config = getActiveProviderConfig();
  return config?.baseUrl ?? null;
}

/**
 * Resolve the API key for the active provider.
 */
export function getActiveApiKey(): string | null {
  const config = getActiveProviderConfig();
  if (!config) return null;
  return resolveApiKey(config);
}

/**
 * Resolve the default model from the active provider config.
 * Returns null if no provider or no defaultModel configured.
 */
export function getActiveDefaultModel(): string | null {
  const config = getActiveProviderConfig();
  return config?.defaultModel ?? null;
}
