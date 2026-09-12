/**
 * Phase 79 §4 — Canonical ProviderRegistry.
 *
 * This registry is a PROJECTION layer over the existing provider abstraction
 * (`src/providers`): one registration per provider id, one place that answers
 * "which providers and models exist and how healthy are they".
 *
 * It deliberately does NOT introduce a second transport, a second adapter
 * hierarchy, or a second instance factory. Instance construction delegates to
 * `createProviderInstance` in `src/providers/registry`, and model metadata is
 * owned by the canonical `ModelCatalog` — `ProviderDefinition.models` is a
 * computed read, never a stored duplicate.
 */

import type { Provider, ProviderConfig } from "../../providers";
import { createProviderInstance } from "../../providers";
import { ModelCatalog, modelCatalog } from "./catalog";
import { DuplicateProviderError, ModelNotFoundError, ProviderNotFoundError } from "./errors";
import { ProviderHealthTracker, type ProviderOutcome } from "./health";
import { formatModelRef } from "./ref";
import type {
  ModelDefinition,
  ModelRef,
  ProviderDefinition,
  ProviderHealth,
  ProviderRegistration,
  ProviderStatus,
} from "./types";
import { unknownHealth } from "./types";

export interface RegisterOptions {
  /** Allow replacing an existing registration (used by refresh/reload). */
  replace?: boolean;
  /** Skip indexing `registration.models` into the catalog. */
  skipModels?: boolean;
}

export class ProviderRegistry {
  private readonly definitions = new Map<string, ProviderDefinition>();
  private readonly health = new ProviderHealthTracker();

  constructor(private readonly catalog: ModelCatalog = modelCatalog) {}

  // ── Registration ──────────────────────────────────────────────────────────

  register(registration: ProviderRegistration, options: RegisterOptions = {}): ProviderDefinition {
    const id = normalizeId(registration.id);
    if (!id) {
      throw new ProviderNotFoundError(String(registration.id));
    }

    const existing = this.definitions.get(id);
    if (existing && !options.replace) {
      throw new DuplicateProviderError(id);
    }

    const definition: ProviderDefinition = {
      id,
      name: registration.name?.trim() || id,
      kind: registration.kind,
      baseURL: registration.baseURL,
      authentication: registration.authentication,
      capabilities: registration.capabilities,
      models: [],
      status: registration.status ?? (registration.enabled === false ? "disabled" : "unknown"),
      health: existing?.health ?? unknownHealth(),
      priority: registration.priority ?? existing?.priority ?? 100,
      enabled: registration.enabled ?? existing?.enabled ?? true,
      metadata: registration.metadata,
    };

    this.definitions.set(id, definition);

    if (!options.skipModels && registration.models && registration.models.length > 0) {
      this.catalog.replaceProviderModels(
        id,
        registration.models.map((model) => ({
          ...model,
          providerId: id,
          id: formatModelRef(id, model.apiModelId),
        })),
      );
    }

    return this.materialize(definition);
  }

  unregister(id: string): boolean {
    const key = normalizeId(id);
    if (!this.definitions.has(key)) return false;
    this.definitions.delete(key);
    this.catalog.removeProvider(key);
    this.health.reset(key);
    return true;
  }

  // ── Lookup ────────────────────────────────────────────────────────────────

  get(id: string): ProviderDefinition | undefined {
    const key = normalizeId(id);
    const definition = this.definitions.get(key);
    if (!definition) return undefined;
    return this.materialize(definition);
  }

  has(id: string): boolean {
    return this.definitions.has(normalizeId(id));
  }

  list(): ProviderDefinition[] {
    return [...this.definitions.values()].map((definition) => this.materialize(definition));
  }

  /** Enabled providers, ordered by priority then id (deterministic). */
  enabled(): ProviderDefinition[] {
    return this.list()
      .filter((definition) => definition.enabled && definition.status !== "disabled")
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  ids(): string[] {
    return [...this.definitions.keys()];
  }

  size(): number {
    return this.definitions.size;
  }

  // ── Mutation ──────────────────────────────────────────────────────────────

  setStatus(id: string, status: ProviderStatus): void {
    const definition = this.definitions.get(normalizeId(id));
    if (definition) definition.status = status;
  }

  setEnabled(id: string, enabled: boolean): void {
    const key = normalizeId(id);
    const definition = this.definitions.get(key);
    if (!definition) return;
    definition.enabled = enabled;
    definition.status = enabled ? (definition.status === "disabled" ? "unknown" : definition.status) : "disabled";
  }

  setPriority(id: string, priority: number): void {
    const definition = this.definitions.get(normalizeId(id));
    if (definition) definition.priority = priority;
  }

  addModels(providerId: string, models: ModelDefinition[]): string[] {
    const key = normalizeId(providerId);
    if (!this.definitions.has(key)) return [];
    return this.catalog.addMany(models.map((model) => ({ ...model, providerId: key })));
  }

  /** Atomically replace a provider's models (used by discovery/refresh). */
  replaceModels(providerId: string, models: ModelDefinition[]): string[] {
    const key = normalizeId(providerId);
    if (!this.definitions.has(key)) return [];
    return this.catalog.replaceProviderModels(key, models);
  }

  // ── Health ────────────────────────────────────────────────────────────────

  healthOf(id: string): ProviderHealth {
    return this.health.get(normalizeId(id));
  }

  recordSuccess(id: string, latencyMs?: number): void {
    this.health.recordSuccess(normalizeId(id), latencyMs);
  }

  recordFailure(id: string, error?: string): void {
    this.health.recordFailure(normalizeId(id), error);
  }

  markUnavailable(id: string, error?: string): void {
    this.health.markUnavailable(normalizeId(id), error);
  }

  /**
   * Phase 82 §4 — classification-aware outcome recording.
   *
   * Caller-fault failures (permission, cancellation, malformed request, schema)
   * are observed but never degrade the provider.
   */
  recordOutcome(id: string, outcome: ProviderOutcome, now?: number): ProviderHealth {
    return this.health.recordOutcome(normalizeId(id), outcome, now);
  }

  resetHealth(id?: string): void {
    this.health.reset(id ? normalizeId(id) : undefined);
  }

  // ── Instance factory (delegates — no second adapter hierarchy) ────────────

  createInstance(id: string): Provider | null {
    const definition = this.get(id);
    if (!definition) return null;
    const config: ProviderConfig = {
      id: definition.id,
      name: definition.name,
      baseUrl: definition.baseURL,
      type: definition.kind,
      apiKeyEnv: definition.authentication?.apiKeyEnv,
    };
    return createProviderInstance(config);
  }

  // ── Resolution ────────────────────────────────────────────────────────────

  /**
   * Resolve a parsed reference to a concrete provider + model pair.
   * Throws ProviderNotFoundError / ModelNotFoundError — never returns a guess.
   */
  resolve(ref: ModelRef): { provider: ProviderDefinition; model: ModelDefinition } {
    if (ref.providerId) {
      const provider = this.get(ref.providerId);
      if (!provider) throw new ProviderNotFoundError(ref.providerId);
      const model = this.catalog.get(formatModelRef(provider.id, ref.modelId));
      if (!model) throw new ModelNotFoundError(ref.modelId, provider.id);
      return { provider, model };
    }

    const model = this.catalog.get(ref.modelId);
    if (model) {
      const provider = this.get(model.providerId);
      if (provider) return { provider, model };
    }

    // Unqualified: accept a unique apiModelId match across providers.
    const matches = this.catalog.filter((entry) => entry.apiModelId === ref.modelId);
    if (matches.length === 1) {
      const provider = this.get(matches[0].providerId);
      if (provider) return { provider, model: matches[0] };
    }
    if (matches.length > 1) {
      throw new ModelNotFoundError(
        ref.modelId,
        undefined,
        new Error(`ambiguous across providers: ${matches.map((m) => m.providerId).join(", ")}`),
      );
    }

    throw new ModelNotFoundError(ref.modelId);
  }

  /** Canonical model ids for a provider (computed from the catalog). */
  modelsOf(id: string): string[] {
    return this.catalog.listByProvider(normalizeId(id)).map((model) => model.id);
  }

  clear(): void {
    this.definitions.clear();
    this.health.reset();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Attach the live, catalog-derived model list to a stored definition. */
  private materialize(definition: ProviderDefinition): ProviderDefinition {
    return {
      ...definition,
      models: this.modelsOf(definition.id),
      health: this.health.get(definition.id),
    };
  }
}

function normalizeId(id: string): string {
  return typeof id === "string" ? id.trim().toLowerCase() : "";
}

/** Process-wide canonical registry. */
export const providerRegistry = new ProviderRegistry();
