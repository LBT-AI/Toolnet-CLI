/**
 * Phase 79 §17 — Runtime integration.
 *
 * THE single place a front-end obtains "which provider instance, which model
 * id". The AgentHarness calls this instead of reaching into `src/providers`
 * itself, so TUI, headless, simple-repl and subagents all traverse:
 *
 *   AgentHarness → ModelRouter → ProviderRegistry → ModelAdapter → provider
 *
 * Backward compatibility is explicit and deliberate: when a model reference
 * cannot be resolved from the catalog (the normal state before any discovery
 * has run), this falls back to the pre-existing active-provider lookup. That
 * keeps every current install working without a config migration — the legacy
 * path is a fallback, not a second routing system.
 */

import type { Provider } from "../../providers";
import {
  getActiveBaseUrl,
  getActiveDefaultModel,
  getActiveProvider,
  OpenAICompatibleProvider,
} from "../../providers";
import { setModelCapabilities } from "../../lib/reasoning";
import { toLegacyCapabilities } from "./capabilities";
import { hydrateCatalogFromCache } from "./cache";
import { modelCatalog } from "./catalog";
import { bootstrapProviderRegistry } from "./providers";
import { providerRegistry, type ProviderRegistry } from "./registry";
import { modelRouter } from "./router";
import { loadRoutingConfig } from "./routingStore";
import type { ResolvedModel } from "./types";

export interface RuntimeModel {
  /** Provider-native model id — exactly what the provider API expects. */
  model: string;
  provider: Provider;
  /** Canonical catalog id when the router resolved one. */
  canonicalId?: string;
  resolved?: ResolvedModel;
  source: "router" | "legacy";
}

let bootstrapped = false;

/**
 * Populate the registry from existing config exactly once per process.
 *
 * Phase 80 adds two more one-time steps, both failure-tolerant:
 *  - hydrate the catalog from the on-disk model cache (so `toolnet models`
 *    does not need the network),
 *  - load the persisted routing profile/policy into the router.
 * Neither is allowed to prevent startup, and neither performs network I/O.
 */
export function ensureProviderRegistry(): ProviderRegistry {
  if (!bootstrapped) {
    try {
      bootstrapProviderRegistry();
    } catch {
      // A malformed providers.json must never prevent the agent from starting.
    }
    try {
      hydrateCatalogFromCache();
    } catch {
      // A corrupt/unreadable cache must never prevent the agent from starting.
    }
    try {
      loadRoutingConfig();
    } catch {
      // A malformed routing block must never prevent the agent from starting.
    }
    bootstrapped = true;
  }
  return providerRegistry;
}

/** Test seam — forces the next call to re-bootstrap. */
export function resetRuntimeBootstrap(): void {
  bootstrapped = false;
}

/**
 * Publish catalog capabilities into the adapter's capability cache.
 *
 * The ModelAdapter gate (`tools === false`, `nativeToolCalls === false`) reads
 * that cache, so without this bridge a capability discovered from a provider
 * would never reach the gating decision — the exact loss §5 forbids.
 */
export function syncAdapterCapabilities(): void {
  const entries = modelCatalog
    .list()
    .filter((model) => Object.keys(model.capabilities).length > 0)
    .map((model) => ({ id: model.apiModelId, capabilities: toLegacyCapabilities(model.capabilities) }));
  if (entries.length > 0) setModelCapabilities(entries);
}

/**
 * Resolve the provider instance + model id for one agent run.
 *
 * Never throws: a routing failure degrades to the legacy active-provider path
 * so an agent turn cannot be blocked by a catalog/discovery problem.
 */
export function resolveRuntimeModel(
  modelRef?: string,
  options: { signal?: AbortSignal; gatewayUrl?: string } = {},
): RuntimeModel {
  const registry = ensureProviderRegistry();
  syncAdapterCapabilities();

  const trimmed = typeof modelRef === "string" ? modelRef.trim() : "";

  // A real reference: try the canonical router first.
  if (trimmed && trimmed !== "default") {
    try {
      const resolved = modelRouter.resolve({
        model: trimmed,
        policy: "explicit",
        signal: options.signal,
      });
      const instance = registry.createInstance(resolved.provider.id);
      if (instance) {
        return {
          model: resolved.model.apiModelId,
          provider: instance,
          canonicalId: resolved.model.id,
          resolved,
          source: "router",
        };
      }
    } catch {
      // Unknown/unregistered model — fall through to the active provider.
    }
    return legacyModel(trimmed, options.gatewayUrl);
  }

  // Sentinel passthrough: `AgentRuntime`/the harness pass the literal string
  // "default" to mean "whatever the provider defaults to". Reinterpreting it
  // as "caller gave no model" would silently swap in the active default and
  // change both the model actually called and context budgeting.
  return legacyModel(trimmed || getActiveDefaultModel() || "default", options.gatewayUrl);
}

/** The pre-Phase-79 resolution path, preserved verbatim for compatibility. */
function legacyModel(model: string, gatewayUrl?: string): RuntimeModel {
  const baseUrl = gatewayUrl || getActiveBaseUrl() || "http://localhost:8080";
  const provider =
    getActiveProvider() ??
    new OpenAICompatibleProvider({ id: "default", name: "Default", baseUrl });
  return { model: model || "default", provider, source: "legacy" };
}

// ── Health recording ────────────────────────────────────────────────────────

export function noteModelSuccess(providerId: string, latencyMs?: number): void {
  providerRegistry.recordSuccess(providerId, latencyMs);
}

export function noteModelFailure(providerId: string, error?: string): void {
  providerRegistry.recordFailure(providerId, error);
}
