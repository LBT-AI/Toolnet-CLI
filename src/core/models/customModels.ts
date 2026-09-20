/**
 * User-added custom models: persistence, deterministic merge and
 * materialization into the canonical ModelCatalog.
 *
 * Custom models are CONFIGURATION, not a second catalog. Persistence lives in
 * the canonical app config (`customModels`); the catalog remains the only
 * runtime owner. Every path that writes a provider's model set must pass
 * through `mergeCustomModels` first, so one provider refresh still performs
 * exactly ONE atomic `replaceProviderModels` and the catalog's contract is
 * never weakened.
 *
 * Merge precedence (deterministic):
 *   - connection/identity fields: the provider (discovery) is authoritative;
 *   - `apiModelId` is the identity key — one entry per provider+id;
 *   - explicit user metadata (displayName, limits, explicitly-set capability
 *     booleans) overrides discovery;
 *   - discovery fills fields the user did not explicitly set;
 *   - UNKNOWN capabilities are never guessed into true/false.
 */

import { loadAppConfig, saveAppConfig, type CustomModelEntry } from "../../lib/appConfig";
import type { ModelDefinition, ModelCapabilities } from "./types";

/** Capability keys a user may explicitly declare (three-state semantics). */
const EDITABLE_CAPABILITY_KEYS = [
  "tools",
  "nativeToolCalls",
  "streaming",
  "reasoning",
  "vision",
  "structuredOutput",
  "jsonMode",
] as const;

export type EditableCapabilityKey = (typeof EDITABLE_CAPABILITY_KEYS)[number];

export function listCustomModels(): CustomModelEntry[] {
  return loadAppConfig().config.customModels;
}

export function listCustomModelsForProvider(providerId: string): CustomModelEntry[] {
  const key = providerId.toLowerCase();
  return listCustomModels().filter((entry) => entry.providerId.toLowerCase() === key);
}

export function isCustomModel(providerId: string, apiModelId: string): boolean {
  const key = providerId.toLowerCase();
  const id = apiModelId.toLowerCase();
  return listCustomModels().some(
    (entry) => entry.providerId.toLowerCase() === key && entry.apiModelId.toLowerCase() === id,
  );
}

/**
 * Persist one custom model. Re-adding the same provider+model id REPLACES the
 * existing entry (idempotent add — no duplicate catalog rows).
 */
export function upsertCustomModel(entry: CustomModelEntry): CustomModelEntry[] {
  const { config } = loadAppConfig();
  const key = entry.providerId.toLowerCase();
  const id = entry.apiModelId;
  const next = config.customModels.filter(
    (e) => !(e.providerId.toLowerCase() === key && e.apiModelId === id),
  );
  next.push(entry);
  saveAppConfig({ ...config, customModels: next });
  return next;
}

/**
 * Remove a user-added model. Returns false when the entry is not custom:
 * discovered-only models are NOT deletable here (no tombstones, no hidden
 * lists — disabling a discovered model belongs to provider configuration).
 */
export function removeCustomModel(providerId: string, apiModelId: string): boolean {
  const { config } = loadAppConfig();
  const key = providerId.toLowerCase();
  const id = apiModelId.toLowerCase();
  const next = config.customModels.filter(
    (e) => !(e.providerId.toLowerCase() === key && e.apiModelId.toLowerCase() === id),
  );
  if (next.length === config.customModels.length) return false;
  saveAppConfig({ ...config, customModels: next });
  return true;
}

/**
 * Merge discovered models with persisted custom models for one provider.
 *
 * Discovery wins on identity/health fields; explicit user declarations win on
 * display name, limits and capability booleans; missing capability fields fall
 * through to whatever discovery materialized (possibly still undefined =
 * UNKNOWN). Custom entries absent from discovery are appended — a custom model
 * remains visible even when the provider's listing omits it.
 */
export function mergeCustomModels(
  providerId: string,
  discovered: ModelDefinition[],
  custom: CustomModelEntry[] = listCustomModelsForProvider(providerId),
): ModelDefinition[] {
  const key = providerId.toLowerCase();
  const byId = new Map<string, ModelDefinition>();
  for (const model of discovered) {
    const normalized = model.providerId.toLowerCase() === key ? model : { ...model, providerId: key };
    byId.set(normalized.apiModelId, normalized);
  }

  for (const entry of custom) {
    const existing = byId.get(entry.apiModelId);
    if (existing) {
      byId.set(entry.apiModelId, applyCustomOverrides(existing, entry));
    } else {
      byId.set(entry.apiModelId, customToDefinition(key, entry));
    }
  }

  // Deterministic order: discovery order first, custom-only entries after
  // (sorted by apiModelId), so repeated merges never reshuffle the picker.
  const out: ModelDefinition[] = [];
  const seen = new Set<string>();
  for (const model of discovered) {
    const merged = byId.get(model.apiModelId);
    if (merged) {
      out.push(merged);
      seen.add(model.apiModelId);
    }
  }
  const customOnly = [...byId.entries()]
    .filter(([id]) => !seen.has(id))
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [, model] of customOnly) out.push(model);
  return out;
}

/** Explicit user declarations override; absent keys keep discovery's value. */
function applyCustomOverrides(model: ModelDefinition, entry: CustomModelEntry): ModelDefinition {
  const merged: ModelDefinition = { ...model };
  if (entry.displayName !== undefined) merged.displayName = entry.displayName;
  if (entry.contextWindow !== undefined) merged.contextWindow = entry.contextWindow;
  if (entry.maxOutputTokens !== undefined) merged.maxOutputTokens = entry.maxOutputTokens;

  if (entry.capabilities) {
    const caps: ModelCapabilities = { ...merged.capabilities };
    for (const key of EDITABLE_CAPABILITY_KEYS) {
      const explicit = (entry.capabilities as Record<string, boolean | undefined>)[key];
      if (typeof explicit === "boolean") {
        (caps as Record<string, boolean | undefined>)[key] = explicit;
      }
    }
    merged.capabilities = caps;
  }

  const metadata = { ...(merged.metadata ?? {}) };
  metadata.custom = true;
  merged.metadata = metadata;
  return merged;
}

/** Materialize a custom-only entry (provider discovery does not list it). */
function customToDefinition(providerId: string, entry: CustomModelEntry): ModelDefinition {
  const caps: ModelCapabilities = {};
  if (entry.capabilities) {
    for (const key of EDITABLE_CAPABILITY_KEYS) {
      const explicit = (entry.capabilities as Record<string, boolean | undefined>)[key];
      if (typeof explicit === "boolean") {
        (caps as Record<string, boolean | undefined>)[key] = explicit;
      }
    }
  }
  return {
    id: `${providerId}/${entry.apiModelId}`,
    providerId,
    apiModelId: entry.apiModelId,
    ...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}),
    ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    ...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
    capabilities: caps,
    status: "active",
    metadata: { custom: true },
  };
}
