/**
 * Phase 79 §7/§8/§9/§14 — Provider definitions + config bootstrap.
 *
 * Backward compatibility is a hard requirement: an existing install has a
 * `providers.json` produced by `src/providers/registry`, optionally an active
 * provider, and environment variables. Bootstrap reads exactly that state and
 * projects it into the canonical registry — it does not require a migration and
 * it does not rewrite the user's config file.
 *
 * Registration is idempotent (`replace: true`) and NEVER clears discovered
 * models, so calling bootstrap on every CLI/harness start is safe and cannot
 * wipe a freshly refreshed catalog.
 */

import {
  getActiveProviderConfig,
  getDefaultProviderConfig,
  listProviders,
  resolveApiKey,
  OPENROUTER_DEFAULT_BASE_URL,
  type ProviderConfig,
} from "../../providers";
import type { ProviderKind, ProviderRegistration, ModelCapabilities } from "./types";
import { ProviderRegistry, providerRegistry } from "./registry";
import { ModelCatalog, modelCatalog } from "./catalog";

/** Map a legacy provider `type`/id onto the canonical kind. */
export function kindFromLegacyType(type: string | undefined, id: string): ProviderKind {
  const value = (type || id || "").toLowerCase().trim();
  switch (value) {
    case "toolnet":
      return "toolnet";
    case "openrouter":
      return "openrouter";
    case "anthropic":
      return "anthropic";
    case "gemini":
    case "google":
      return "gemini";
    case "openai-compatible":
    case "openai-compatible-provider":
      return "openai-compatible";
    case "":
      return "custom";
    default:
      return "openai-compatible";
  }
}

/** Provider-level capability declarations. Only what the provider guarantees. */
function providerCapabilities(kind: ProviderKind): ModelCapabilities {
  switch (kind) {
    case "openrouter":
      // OpenRouter's chat surface is streaming-capable for every model it
      // serves; this is a provider-level fact, not a per-model guess.
      return { streaming: true };
    case "toolnet":
      return { streaming: true };
    default:
      return {};
  }
}

/** Project one legacy `ProviderConfig` into a canonical registration. */
export function registrationFromConfig(config: ProviderConfig): ProviderRegistration {
  const kind = kindFromLegacyType(config.type, config.id);
  return {
    id: config.id,
    name: config.name || config.id,
    kind,
    baseURL: config.baseUrl,
    authentication: {
      apiKeyEnv: config.apiKeyEnv,
      scheme: "bearer",
      hasApiKey: Boolean(resolveApiKey(config)),
    },
    capabilities: providerCapabilities(kind),
    enabled: true,
    // The active provider is preferred by policy without excluding the rest.
    priority: config.active ? 10 : 100,
    metadata: { source: "config", legacyType: config.type },
  };
}

/** OpenRouter's default registration, used when the key exists in env. */
export function openRouterRegistration(env: NodeJS.ProcessEnv = process.env): ProviderRegistration {
  const defaults = getDefaultProviderConfig("openrouter");
  return {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openrouter",
    baseURL: env.OPENROUTER_BASE_URL || defaults.baseUrl || OPENROUTER_DEFAULT_BASE_URL,
    authentication: {
      apiKeyEnv: "OPENROUTER_API_KEY",
      scheme: "bearer",
      hasApiKey: Boolean(env.OPENROUTER_API_KEY?.trim()),
    },
    capabilities: providerCapabilities("openrouter"),
    priority: 20,
    metadata: { source: "builtin" },
  };
}

export interface BootstrapOptions {
  registry?: ProviderRegistry;
  catalog?: ModelCatalog;
  env?: NodeJS.ProcessEnv;
  /** Include the built-in OpenRouter entry even without a key in env. */
  includeOpenRouter?: boolean;
}

export interface BootstrapResult {
  registered: string[];
  skipped: string[];
}

/**
 * Populate the canonical registry from existing provider state.
 * Idempotent; never touches the catalog's model list.
 */
export function bootstrapProviderRegistry(options: BootstrapOptions = {}): BootstrapResult {
  const registry = options.registry ?? providerRegistry;
  const env = options.env ?? process.env;
  const registered: string[] = [];
  const skipped: string[] = [];

  const configs = listProviders();
  for (const config of configs) {
    if (!config?.id || !config.baseUrl) {
      skipped.push(config?.id ?? "(anonymous)");
      continue;
    }
    registry.register(registrationFromConfig(config), { replace: true, skipModels: true });
    registered.push(config.id.toLowerCase());
  }

  // The active provider may exist only implicitly (key stored without a config
  // row). Register it so the active-provider path keeps working.
  const active = getActiveProviderConfig();
  if (active && !registered.includes(active.id.toLowerCase())) {
    registry.register(registrationFromConfig(active), { replace: true, skipModels: true });
    registered.push(active.id.toLowerCase());
  }

  // Built-in OpenRouter: registered when a key is present, or on request (so
  // `toolnet providers` can show it before a key is configured).
  const hasOpenRouterKey = Boolean(env.OPENROUTER_API_KEY?.trim());
  if ((hasOpenRouterKey || options.includeOpenRouter) && !registry.has("openrouter")) {
    registry.register(openRouterRegistration(env), { replace: true, skipModels: true });
    registered.push("openrouter");
  }

  return { registered, skipped };
}
