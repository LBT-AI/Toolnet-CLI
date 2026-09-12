/**
 * Phase 79 §16 — Model discovery / refresh.
 *
 * Refresh rules:
 *  - Fetch, validate, normalize, then replace ATOMICALLY per provider.
 *  - If a provider fails, its previous catalog entries are preserved; other
 *    providers are untouched. One dead provider never empties the catalog.
 *  - No package installation, no implicit config writes.
 *  - Failures are classified so the caller can tell an auth problem from an
 *    outage, and secrets are redacted before the message is stored.
 */

import { createProviderInstance, type ModelInfo, type Provider } from "../../providers";
import { OpenRouterProvider } from "../../providers";
import { normalizeCapabilities, mergeCapabilities } from "./capabilities";
import { normalizeOpenRouterModels } from "./openrouter";
import { formatModelRef } from "./ref";
import { providerRegistry, ProviderRegistry } from "./registry";
import { redactSecret } from "./errors";
import type { ModelCapabilities, ModelDefinition, ProviderDefinition } from "./types";

export type RefreshErrorClass = "auth" | "rate-limit" | "network" | "protocol" | "not-found" | "cancelled" | "unknown";

export interface RefreshResult {
  providerId: string;
  ok: boolean;
  modelCount: number;
  /** True when the previous catalog entries were preserved. */
  preservedPrevious: boolean;
  error?: string;
  errorClass?: RefreshErrorClass;
}

export interface RefreshOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  registry?: ProviderRegistry;
}

/** Normalize a legacy ModelInfo row into a canonical ModelDefinition. */
export function normalizeListedModel(
  info: ModelInfo,
  providerId: string,
  defaults?: ModelCapabilities,
): ModelDefinition | null {
  const apiModelId = typeof info?.id === "string" ? info.id.trim() : "";
  if (!apiModelId) return null;

  const capabilities = mergeCapabilities(defaults, normalizeCapabilities(info.capabilities));

  const metadata: Record<string, unknown> = {};
  if (info.owned_by) metadata.ownedBy = info.owned_by;
  if (info.object) metadata.object = info.object;
  if (typeof info.created === "number") metadata.created = info.created;

  return {
    id: formatModelRef(providerId, apiModelId),
    providerId,
    apiModelId,
    displayName: typeof info.name === "string" && info.name.trim() ? info.name.trim() : apiModelId,
    capabilities,
    status: "active",
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

export function classifyRefreshError(error: unknown): { errorClass: RefreshErrorClass; message: string } {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return { errorClass: "cancelled", message: redactSecret(error.message) };
  }
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactSecret(message);

  const status = /HTTP\s+(\d{3})/.exec(message)?.[1];
  if (status === "401" || status === "403") return { errorClass: "auth", message: redacted };
  if (status === "404") return { errorClass: "not-found", message: redacted };
  if (status === "429") return { errorClass: "rate-limit", message: redacted };
  if (status && /^5\d\d$/.test(status)) return { errorClass: "network", message: redacted };

  if (/abort|cancel/i.test(message)) return { errorClass: "cancelled", message: redacted };
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket|network|timeout/i.test(message)) {
    return { errorClass: "network", message: redacted };
  }
  if (/invalid json|unexpected token|malformed|schema/i.test(message)) {
    return { errorClass: "protocol", message: redacted };
  }
  return { errorClass: "unknown", message: redacted };
}

/** Build the adapter instance for a provider definition (no second factory). */
export function instanceFor(definition: ProviderDefinition): Provider | null {
  return createProviderInstance({
    id: definition.id,
    name: definition.name,
    baseUrl: definition.baseURL,
    type: definition.kind,
    apiKeyEnv: definition.authentication?.apiKeyEnv,
  });
}

/**
 * Discover and normalize a provider's models WITHOUT touching the catalog.
 * Exported so a caller can dry-run discovery.
 */
export async function discoverProviderModels(
  definition: ProviderDefinition,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ModelDefinition[]> {
  const defaults = definition.capabilities;

  if (definition.kind === "openrouter") {
    const instance = instanceFor(definition);
    // Duck-type the capability instead of `instanceof`: the provider factory
    // constructs adapters through `require`, while this module imports the class
    // through ESM, so the two class identities can differ and an `instanceof`
    // check would silently skip OpenRouter's raw discovery (returning an empty
    // catalog instead of an error).
    const discover = (instance as { discoverModels?: unknown } | null)?.discoverModels;
    if (typeof discover === "function") {
      const records = await (instance as OpenRouterProvider).discoverModels({
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      return normalizeOpenRouterModels(records, definition.id, defaults);
    }
  }

  const instance = instanceFor(definition);
  if (!instance) return [];
  const listed = await instance.listModels();
  const out: ModelDefinition[] = [];
  for (const info of listed) {
    const model = normalizeListedModel(info, definition.id, defaults);
    if (model) out.push(model);
  }
  return out;
}

/** Refresh one provider, atomically, preserving its old models on failure. */
export async function refreshProvider(
  providerId: string,
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  const registry = options.registry ?? providerRegistry;
  const definition = registry.get(providerId);
  if (!definition) {
    return {
      providerId,
      ok: false,
      modelCount: 0,
      preservedPrevious: false,
      error: `No provider registered with id '${providerId}'.`,
      errorClass: "not-found",
    };
  }

  const startedAt = Date.now();
  try {
    const models = await discoverProviderModels(definition, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });

    if (models.length === 0) {
      // An empty listing is treated as a failure so we never wipe a working
      // catalog because a provider returned `{data: []}` transiently.
      registry.recordFailure(definition.id, "discovery returned no models");
      return {
        providerId: definition.id,
        ok: false,
        modelCount: 0,
        preservedPrevious: true,
        error: "Discovery returned no models; previous catalog preserved.",
        errorClass: "protocol",
      };
    }

    registry.replaceModels(definition.id, models);
    registry.recordSuccess(definition.id, Date.now() - startedAt);
    registry.setStatus(definition.id, "connected");

    return { providerId: definition.id, ok: true, modelCount: models.length, preservedPrevious: false };
  } catch (error) {
    const { errorClass, message } = classifyRefreshError(error);
    registry.recordFailure(definition.id, message);
    if (errorClass === "auth") registry.setStatus(definition.id, "failed");
    return {
      providerId: definition.id,
      ok: false,
      modelCount: 0,
      preservedPrevious: true,
      error: message,
      errorClass,
    };
  }
}

/** Refresh every enabled provider, isolating failures. */
export async function refreshAllProviders(options: RefreshOptions = {}): Promise<RefreshResult[]> {
  const registry = options.registry ?? providerRegistry;
  const results: RefreshResult[] = [];
  for (const definition of registry.enabled()) {
    results.push(await refreshProvider(definition.id, options));
  }
  return results;
}
