/**
 * Phase 83 §3 — THE ExternalHarnessRegistry.
 *
 * Stores adapter DEFINITIONS only — it never spawns processes, never talks to
 * providers, and never executes tools. Exactly one instance exists
 * (`externalHarnessRegistry`); duplicates are refused, unknown ids produce a
 * structured error, and detection results are cached with a bounded TTL so
 * repeated CLI/TUI status calls do not re-probe binaries.
 */

import { HarnessNotFoundError } from "./errors";
import type { ExternalHarnessDefinition, HarnessCapabilityView, TriState } from "./types";

/** Detection cache TTL — cheap re-probe window for status surfaces. */
export const HARNESS_DETECT_TTL_MS = 60_000;

export interface HarnessDetectionState {
  available: boolean;
  version?: string;
  detail?: string;
  checkedAt: number;
}

export interface HarnessStatusView {
  id: string;
  displayName: string;
  executable: string;
  executionTrust: "external_managed" | "toolnet_managed";
  detection: HarnessDetectionState;
  capabilities: HarnessCapabilityView;
}

export class ExternalHarnessRegistry {
  private readonly definitions = new Map<string, ExternalHarnessDefinition>();
  private detectionCache = new Map<string, HarnessDetectionState>();

  /** Register an adapter. Duplicate ids are refused (no silent overwrite). */
  register(definition: ExternalHarnessDefinition): void {
    if (this.definitions.has(definition.id)) {
      throw new Error(`External harness '${definition.id}' is already registered.`);
    }
    this.definitions.set(definition.id, definition);
  }

  /** Registered ids, sorted for deterministic output. */
  ids(): string[] {
    return [...this.definitions.keys()].sort();
  }

  /** Lookup by id (undefined when unknown — use `resolve` for errors). */
  get(id: string): ExternalHarnessDefinition | undefined {
    return this.definitions.get(id.trim().toLowerCase());
  }

  has(id: string): boolean {
    return this.definitions.has(id.trim().toLowerCase());
  }

  /**
   * Resolve a definition or throw the structured not-found error.
   * Accepts both `opencode` and `external:opencode` forms.
   */
  resolve(id: string): ExternalHarnessDefinition {
    const bare = id.trim().toLowerCase().replace(/^external:/, "");
    const found = this.definitions.get(bare);
    if (!found) throw new HarnessNotFoundError(bare);
    return found;
  }

  /** Drop a registration (test isolation only). */
  unregister(id: string): boolean {
    this.detectionCache.delete(id.trim().toLowerCase());
    return this.definitions.delete(id.trim().toLowerCase());
  }

  /** Forget all cached detection state (also after binary changes). */
  invalidateDetection(id?: string): void {
    if (id) this.detectionCache.delete(id.trim().toLowerCase());
    else this.detectionCache.clear();
  }

  /** Non-blocking read of cached detection (no probe). For status surfaces. */
  peekDetection(id: string): HarnessDetectionState | undefined {
    return this.detectionCache.get(id.trim().toLowerCase());
  }

  /**
   * Detect availability — bounded, offline, side-effect-free, cached for
   * HARNESS_DETECT_TTL_MS. Malformed detectors resolve to unavailable rather
   * than throwing (a broken adapter must not crash a status call).
   */
  async detect(id: string, options: { force?: boolean } = {}): Promise<HarnessDetectionState> {
    const key = id.trim().toLowerCase();
    const cached = this.detectionCache.get(key);
    if (!options.force && cached && Date.now() - cached.checkedAt < HARNESS_DETECT_TTL_MS) return cached;

    const definition = this.definitions.get(key);
    if (!definition) throw new HarnessNotFoundError(key);

    let state: HarnessDetectionState;
    try {
      const result = await definition.detect();
      state = {
        available: result.available === true,
        ...(result.version !== undefined ? { version: result.version } : {}),
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
        checkedAt: Date.now(),
      };
    } catch (error) {
      state = {
        available: false,
        detail: error instanceof Error ? error.message : String(error),
        checkedAt: Date.now(),
      };
    }
    this.detectionCache.set(key, state);
    return state;
  }

  /** CLI/TUI status view — verified-true capabilities only, no secrets. */
  async statusOf(id: string): Promise<HarnessStatusView> {
    const definition = this.resolve(id);
    const detection = await this.detect(definition.id);
    return {
      id: definition.id,
      displayName: definition.displayName,
      executable: definition.executable,
      executionTrust: definition.executionTrust,
      detection,
      capabilities: {
        structuredOutput: definition.capabilities.structuredOutput === true,
        modelOverride: definition.capabilities.modelOverride === true,
        sessionResume: definition.capabilities.sessionResume === true,
        nonInteractive: definition.capabilities.nonInteractive === true,
      },
    };
  }
}

/** Process-wide canonical registry. */
export const externalHarnessRegistry = new ExternalHarnessRegistry();

/** Tri-state helper re-exported for diagnostics. */
export function isSupported(value: TriState): boolean {
  return value === true;
}
