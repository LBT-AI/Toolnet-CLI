/**
 * Phase 81 §18 — harness profile persistence.
 *
 * Persisted into the CANONICAL config owner (`~/.toolnetcli/config.json`,
 * `src/lib/appConfig.ts`, schema v4). No second config file is introduced, and
 * writes go through `updateAppConfig`, which validates and writes atomically.
 *
 * Harness selection is validated against the registry HERE (loudly), because
 * this is the path a user's typed profile id travels. The config LOADER stays
 * lenient so a hand-edited file cannot brick the CLI.
 */

import {
  getAppConfig,
  updateAppConfig,
  validateHarnessSettings,
  type AppHarnessSettings,
} from "../../lib/appConfig";
import { harnessRegistry } from "./registry";

export interface HarnessValidation {
  ok: boolean;
  errors: string[];
  settings?: AppHarnessSettings;
}

/** Validate a candidate harness patch against the canonical registry. */
export function validateHarnessPatch(patch: Partial<AppHarnessSettings>): HarnessValidation {
  const errors: string[] = [];

  if (patch.profile !== undefined) {
    const id = patch.profile.trim().toLowerCase();
    if (!id) {
      errors.push("Harness profile must not be empty.");
    } else if (!harnessRegistry.has(id)) {
      errors.push(
        `Unknown harness profile '${patch.profile}'. Known: ${harnessRegistry.ids().join(", ")}.`,
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    settings: validateHarnessSettings({ ...currentHarnessSettings(), ...patch }),
  };
}

/** Harness settings currently persisted (lenient — never throws). */
export function currentHarnessSettings(): AppHarnessSettings {
  try {
    return validateHarnessSettings(getAppConfig().harness);
  } catch {
    return validateHarnessSettings(undefined);
  }
}

/** Persist a validated profile selection. Invalid ids never reach the file. */
export function persistHarnessProfile(
  id: string,
): { ok: true; settings: AppHarnessSettings } | { ok: false; errors: string[] } {
  const validation = validateHarnessPatch({ profile: id });
  if (!validation.ok || !validation.settings) return { ok: false, errors: validation.errors };
  const saved = updateAppConfig({ harness: validation.settings }).harness;
  return { ok: true, settings: validateHarnessSettings(saved) };
}

/** Restore the default profile in the config file. */
export function resetPersistedHarness(): AppHarnessSettings {
  const defaults = validateHarnessSettings(undefined);
  const saved = updateAppConfig({ harness: defaults }).harness;
  return validateHarnessSettings(saved);
}
