/**
 * Phase 80 §8 — Read-only catalog projection.
 *
 * One place that turns the canonical layer into display rows, so the TUI and
 * the CLI cannot drift apart. It reads `ModelCatalog`, `ProviderRegistry` and
 * `ProviderHealth` only — it never constructs a provider, never performs I/O,
 * and never mutates config.
 *
 * Tri-state capability rendering is preserved: `undefined` stays "unknown".
 */

import { modelCatalog, type ModelCatalog } from "./catalog";
import { providerRegistry, type ProviderRegistry } from "./registry";
import type {
  CapabilityKey,
  HealthState,
  ModelCapabilities,
  ModelPricing,
  ModelStatus,
} from "./types";

export interface CatalogFilter {
  /** Provider id (case-insensitive). */
  provider?: string;
  /** Only models that declare this capability as `true`. */
  capability?: CapabilityKey;
  /**
   * "free"  → declared price is exactly zero
   * "paid"  → declared price is greater than zero
   * A model whose pricing was never declared matches NEITHER (metadata is not
   * sufficient to classify it).
   */
  pricing?: "free" | "paid";
  /** Case-insensitive substring match on model id / display name. */
  search?: string;
}

export interface CatalogRow {
  id: string;
  providerId: string;
  apiModelId: string;
  displayName: string;
  contextWindow?: number;
  capabilities: ModelCapabilities;
  pricing?: ModelPricing;
  /** true only when the provider declared a zero price. */
  declaredFree: boolean;
  /** false when the provider published no pricing at all. */
  pricingKnown: boolean;
  health: HealthState;
  status: ModelStatus;
}

export interface CatalogView {
  rows: CatalogRow[];
  totalBeforeFilter: number;
  filter: CatalogFilter;
}

function isDeclaredFree(pricing: ModelPricing | undefined): boolean {
  if (!pricing) return false;
  const input = pricing.input ?? 0;
  const output = pricing.output ?? 0;
  return input === 0 && output === 0;
}

export function classifyPricing(pricing: ModelPricing | undefined): "free" | "paid" | "unknown" {
  if (!pricing) return "unknown";
  if (pricing.input === undefined && pricing.output === undefined) return "unknown";
  return isDeclaredFree(pricing) ? "free" : "paid";
}

export function buildCatalogRows(options: {
  catalog?: ModelCatalog;
  registry?: ProviderRegistry;
  filter?: CatalogFilter;
} = {}): CatalogView {
  const catalog = options.catalog ?? modelCatalog;
  const registry = options.registry ?? providerRegistry;
  const filter = options.filter ?? {};
  const all = catalog.list();

  const search = filter.search?.trim().toLowerCase();
  const providerFilter = filter.provider?.trim().toLowerCase();

  const rows: CatalogRow[] = [];
  for (const model of all) {
    if (providerFilter && model.providerId.toLowerCase() !== providerFilter) continue;
    if (filter.capability && model.capabilities[filter.capability] !== true) continue;
    if (filter.pricing && classifyPricing(model.pricing) !== filter.pricing) continue;
    if (search) {
      const haystack = `${model.id} ${model.displayName ?? ""} ${model.apiModelId}`.toLowerCase();
      if (!haystack.includes(search)) continue;
    }
    rows.push({
      id: model.id,
      providerId: model.providerId,
      apiModelId: model.apiModelId,
      displayName: model.displayName ?? model.apiModelId,
      contextWindow: model.contextWindow ?? model.limits?.contextWindow,
      capabilities: model.capabilities,
      pricing: model.pricing,
      declaredFree: isDeclaredFree(model.pricing),
      pricingKnown: classifyPricing(model.pricing) !== "unknown",
      health: registry.healthOf(model.providerId).state,
      status: model.status,
    });
  }

  rows.sort(
    (a, b) => a.providerId.localeCompare(b.providerId) || a.apiModelId.localeCompare(b.apiModelId),
  );

  return { rows, totalBeforeFilter: all.length, filter };
}

/** `yes` / `no` / `unknown` — unknown is never rendered as a capability. */
export function triState(value: boolean | undefined): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}

/** Compact price label; `—` when the provider declared nothing. */
export function priceLabel(pricing: ModelPricing | undefined): string {
  if (!pricing || (pricing.input === undefined && pricing.output === undefined)) return "—";
  const format = (value: number | undefined) => (value === undefined ? "?" : String(value));
  return `${format(pricing.input)}/${format(pricing.output)}`;
}
