/**
 * Phase 79 §5 — Canonical ModelCatalog.
 *
 * The single owner of model metadata. Providers never store model lists that
 * the runtime reads; discovery writes here, and the registry/router read here.
 *
 * Keys are canonical ids (`${providerId}/${apiModelId}`), so two providers may
 * expose the same upstream model without colliding, and one provider may expose
 * an id that itself contains slashes (OpenRouter).
 *
 * Mutation is atomic per provider: `replaceProviderModels` builds the complete
 * new index before swapping, so a failed/partial discovery can never leave the
 * catalog half-updated, and one provider's failure never disturbs another's
 * entries.
 */

import { formatModelRef } from "./ref";
import type { ModelDefinition } from "./types";

export interface CatalogChange {
  type: "added" | "removed" | "replaced" | "cleared";
  providerId?: string;
  modelIds: string[];
}

export type CatalogListener = (change: CatalogChange) => void;

export class ModelCatalog {
  private models = new Map<string, ModelDefinition>();
  private byProvider = new Map<string, Set<string>>();
  private listeners = new Set<CatalogListener>();

  // ── Reads ─────────────────────────────────────────────────────────────────

  get(id: string): ModelDefinition | undefined {
    const direct = this.models.get(id);
    if (direct) return direct;
    // Tolerate a case-different provider prefix while keeping model ids exact.
    const separator = id.indexOf("/");
    if (separator === -1) return undefined;
    const providerId = id.slice(0, separator).toLowerCase();
    return this.models.get(`${providerId}/${id.slice(separator + 1)}`);
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  list(): ModelDefinition[] {
    return [...this.models.values()];
  }

  listByProvider(providerId: string): ModelDefinition[] {
    const ids = this.byProvider.get(providerId.toLowerCase());
    if (!ids) return [];
    const out: ModelDefinition[] = [];
    for (const id of ids) {
      const model = this.models.get(id);
      if (model) out.push(model);
    }
    return out;
  }

  /** Every provider id that currently has at least one model. */
  providerIds(): string[] {
    return [...this.byProvider.keys()];
  }

  size(): number {
    return this.models.size;
  }

  find(predicate: (model: ModelDefinition) => boolean): ModelDefinition | undefined {
    for (const model of this.models.values()) {
      if (predicate(model)) return model;
    }
    return undefined;
  }

  filter(predicate: (model: ModelDefinition) => boolean): ModelDefinition[] {
    return this.list().filter(predicate);
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /** Add or replace one model. Returns the canonical id. */
  add(model: ModelDefinition): string {
    const id = this.canonicalize(model);
    this.models.set(id, { ...model, id });
    const set = this.byProvider.get(model.providerId.toLowerCase()) ?? new Set<string>();
    set.add(id);
    this.byProvider.set(model.providerId.toLowerCase(), set);
    this.emit({ type: "added", providerId: model.providerId.toLowerCase(), modelIds: [id] });
    return id;
  }

  addMany(models: ModelDefinition[]): string[] {
    return models.map((model) => this.add(model));
  }

  remove(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    const canonical = existing.id;
    this.models.delete(canonical);
    const set = this.byProvider.get(existing.providerId.toLowerCase());
    if (set) {
      set.delete(canonical);
      if (set.size === 0) this.byProvider.delete(existing.providerId.toLowerCase());
    }
    this.emit({ type: "removed", providerId: existing.providerId.toLowerCase(), modelIds: [canonical] });
    return true;
  }

  removeProvider(providerId: string): string[] {
    const key = providerId.toLowerCase();
    const ids = [...(this.byProvider.get(key) ?? [])];
    if (ids.length === 0) return [];
    for (const id of ids) this.models.delete(id);
    this.byProvider.delete(key);
    this.emit({ type: "removed", providerId: key, modelIds: ids });
    return ids;
  }

  /**
   * Atomically replace the complete model set of one provider.
   *
   * The new index is computed in full before anything is mutated, so a provider
   * that returns a partial/failed result leaves the catalog untouched.
   */
  replaceProviderModels(providerId: string, models: ModelDefinition[]): string[] {
    const key = providerId.toLowerCase();
    const next = new Map<string, ModelDefinition>();
    for (const model of models) {
      const normalized = { ...model, providerId: key };
      const id = this.canonicalize(normalized);
      next.set(id, { ...normalized, id });
    }

    const previous = this.byProvider.get(key) ?? new Set<string>();
    for (const id of previous) this.models.delete(id);

    for (const [id, model] of next) this.models.set(id, model);
    if (next.size > 0) {
      this.byProvider.set(key, new Set(next.keys()));
    } else {
      this.byProvider.delete(key);
    }

    this.emit({ type: "replaced", providerId: key, modelIds: [...next.keys()] });
    return [...next.keys()];
  }

  clear(): void {
    this.models.clear();
    this.byProvider.clear();
    this.emit({ type: "cleared", modelIds: [] });
  }

  // ── Snapshot (for atomic refresh rollback) ────────────────────────────────

  snapshotProvider(providerId: string): ModelDefinition[] {
    return this.listByProvider(providerId).map((model) => ({ ...model, capabilities: { ...model.capabilities } }));
  }

  // ── Change notifications ──────────────────────────────────────────────────

  onChange(listener: CatalogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: CatalogChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // A listener must never break a catalog mutation.
      }
    }
  }

  private canonicalize(model: ModelDefinition): string {
    return formatModelRef(model.providerId, model.apiModelId);
  }
}

/** Process-wide canonical catalog. */
export const modelCatalog = new ModelCatalog();
