/**
 * Provider Registry for ToolNet CLI.
 *
 * Manages provider configurations, active provider selection,
 * and provides the runtime provider instance.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getToolnetHome } from "../lib/toolnetHome";
import type { Provider, ProviderConfig } from "./types";
import { OpenAICompatibleProvider } from "./openaiCompatible";
import { getCliKey, loadCliKeys } from "../lib/keys";

export function getProvidersConfigDir(): string {
  // Phase 3: canonical home module (single TOOLNETCLI_CONFIG_DIR-aware source).
  return getToolnetHome();
}

export function getProvidersConfigFile(): string {
  return path.join(getProvidersConfigDir(), "providers.json");
}

// Computed lazily via getters to honor TOOLNETCLI_CONFIG_DIR set at runtime.
export const PROVIDERS_CONFIG_DIR = getToolnetHome();
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
let lastConfigFilePath = "";

// Provider switch event bus
export type ProviderSwitchListener = (providerId: string, config: ProviderConfig | null) => void;
const switchListeners: ProviderSwitchListener[] = [];

export function onProviderSwitch(listener: ProviderSwitchListener): () => void {
  switchListeners.push(listener);
  return () => {
    const idx = switchListeners.indexOf(listener);
    if (idx !== -1) switchListeners.splice(idx, 1);
  };
}

export function notifyProviderSwitch(id: string, config: ProviderConfig | null): void {
  for (const listener of switchListeners) {
    try {
      listener(id, config);
    } catch {}
  }
}

function ensureDir(): void {
  try {
    fs.mkdirSync(getProvidersConfigDir(), { recursive: true });
  } catch {}
}

export function loadProvidersConfig(): StoredProvidersConfig {
  const file = getProvidersConfigFile();
  if (cachedConfig && lastConfigFilePath === file) return cachedConfig;
  ensureDir();
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    cachedConfig = { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    cachedConfig = { ...DEFAULT_CONFIG };
  }
  lastConfigFilePath = file;
  return cachedConfig!;
}

export function saveProvidersConfig(config: StoredProvidersConfig): void {
  ensureDir();
  const file = getProvidersConfigFile();
  try {
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8");
    cachedConfig = config;
    lastConfigFilePath = file;
  } catch {}
}

export function resetProvidersConfigCache(): void {
  cachedConfig = null;
  lastConfigFilePath = "";
}

/**
 * Returns default ProviderConfig for standard known providers.
 */
export function getDefaultProviderConfig(id: string): ProviderConfig {
  const norm = id.toLowerCase().trim();
  switch (norm) {
    case "toolnet":
      return {
        id: "toolnet",
        name: "ToolNet Gateway",
        baseUrl: process.env.TOOLNET_BASE_URL || "https://api.toolnet.ai/v1",
        type: "toolnet",
        apiKeyEnv: "TOOLNET_API_KEY",
        defaultModel: "claude-3-5-sonnet",
      };
    case "openai":
      return {
        id: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        type: "openai",
        apiKeyEnv: "OPENAI_API_KEY",
        defaultModel: "gpt-4o",
      };
    case "anthropic":
      return {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        type: "anthropic",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        defaultModel: "claude-3-5-sonnet-20241022",
      };
    case "gemini":
    case "google":
      return {
        id: "gemini",
        name: "Google Gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        type: "gemini",
        apiKeyEnv: "GEMINI_API_KEY",
        defaultModel: "gemini-2.0-flash",
      };
    case "deepseek":
      return {
        id: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        type: "openai",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        defaultModel: "deepseek-chat",
      };
    case "groq":
      return {
        id: "groq",
        name: "Groq",
        baseUrl: "https://api.groq.com/openai/v1",
        type: "openai",
        apiKeyEnv: "GROQ_API_KEY",
        defaultModel: "llama-3.3-70b-versatile",
      };
    case "openrouter":
      return {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        type: "openai",
        apiKeyEnv: "OPENROUTER_API_KEY",
        defaultModel: "anthropic/claude-3.5-sonnet",
      };
    case "together":
      return {
        id: "together",
        name: "Together AI",
        baseUrl: "https://api.together.xyz/v1",
        type: "openai",
        apiKeyEnv: "TOGETHER_API_KEY",
        defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      };
    case "mistral":
      return {
        id: "mistral",
        name: "Mistral AI",
        baseUrl: "https://api.mistral.ai/v1",
        type: "openai",
        apiKeyEnv: "MISTRAL_API_KEY",
        defaultModel: "mistral-large-latest",
      };
    case "xai":
      return {
        id: "xai",
        name: "xAI",
        baseUrl: "https://api.x.ai/v1",
        type: "openai",
        apiKeyEnv: "XAI_API_KEY",
        defaultModel: "grok-2-latest",
      };
    case "alibaba":
    case "dashscope":
    case "qwen":
      return {
        id: "alibaba",
        name: "Alibaba Cloud",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        type: "openai",
        apiKeyEnv: "DASHSCOPE_API_KEY",
        defaultModel: "qwen-plus",
      };
    case "minimax":
      return {
        id: "minimax",
        name: "MiniMax",
        baseUrl: "https://api.minimax.chat/v1",
        type: "openai",
        apiKeyEnv: "MINIMAX_API_KEY",
        defaultModel: "MiniMax-Text-01",
      };
    case "cohere":
      return {
        id: "cohere",
        name: "Cohere",
        baseUrl: "https://api.cohere.com/v2",
        type: "openai",
        apiKeyEnv: "COHERE_API_KEY",
        defaultModel: "command-r-plus-08-2024",
      };
    default:
      return {
        id: norm,
        name: norm,
        baseUrl: "https://api.openai.com/v1",
        type: "openai",
        apiKeyEnv: `${norm.toUpperCase()}_API_KEY`,
      };
  }
}

/**
 * Resolve the API key for a provider config.
 * Priority: apiKeyEnv (env var) > apiKey (inline) > CLI stored key > null
 */
export function resolveApiKey(config: ProviderConfig): string | null {
  if (config.apiKeyEnv) {
    const val = process.env[config.apiKeyEnv];
    if (val) return val.trim();
  }
  if (config.apiKey) return config.apiKey;
  const cliKey = getCliKey(config.id);
  if (cliKey) return cliKey.trim();
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
  const normId = id.toLowerCase().trim();
  let exists = cfg.providers.find((p) => p.id.toLowerCase() === normId);
  if (!exists) {
    const def = getDefaultProviderConfig(normId);
    cfg.providers.push(def);
    exists = def;
  }
  cfg.activeProviderId = exists.id;
  saveProvidersConfig(cfg);
  notifyProviderSwitch(exists.id, exists);
  return true;
}

/**
 * Automatically restores active provider on startup if keys exist.
 */
export function autoRestoreActiveProvider(): ProviderConfig | null {
  const cfg = loadProvidersConfig();
  if (cfg.activeProviderId) {
    const active = cfg.providers.find((p) => p.id === cfg.activeProviderId);
    if (active && resolveApiKey(active)) {
      return active;
    }
  }

  // Check stored CLI keys
  const keys = loadCliKeys();
  const preferred = ["toolnet", "openai", "anthropic", "gemini", "deepseek", ...Object.keys(keys)];
  for (const id of preferred) {
    const key = getCliKey(id);
    if (key) {
      const def = getDefaultProviderConfig(id);
      if (!cfg.providers.some((p) => p.id.toLowerCase() === def.id.toLowerCase())) {
        cfg.providers.push(def);
      }
      cfg.activeProviderId = def.id;
      saveProvidersConfig(cfg);
      notifyProviderSwitch(def.id, def);
      return def;
    }
  }

  return null;
}

/**
 * Synchronizes provider state after a key is saved.
 * - If no active provider (or active provider has no key), activates this provider.
 * - If another valid provider is active, does not switch active provider.
 */
export function syncProviderOnKeySave(providerId: string, apiKey: string): ProviderConfig | null {
  const normId = providerId.toLowerCase().trim();
  if (!normId || !apiKey.trim()) return null;

  const cfg = loadProvidersConfig();
  let providerConfig = cfg.providers.find((p) => p.id.toLowerCase() === normId);
  if (!providerConfig) {
    providerConfig = getDefaultProviderConfig(normId);
    cfg.providers.push(providerConfig);
  }

  const currentActive = cfg.activeProviderId
    ? cfg.providers.find((p) => p.id === cfg.activeProviderId)
    : null;
  const currentActiveKey = currentActive ? resolveApiKey(currentActive) : null;

  const shouldActivate = !currentActive || !currentActiveKey || currentActive.id.toLowerCase() === normId;

  if (shouldActivate) {
    cfg.activeProviderId = providerConfig.id;
    saveProvidersConfig(cfg);
    notifyProviderSwitch(providerConfig.id, providerConfig);
  } else {
    saveProvidersConfig(cfg);
  }

  return providerConfig;
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
