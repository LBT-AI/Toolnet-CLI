/**
 * Phase 80 §7 — Routing config persistence.
 *
 * Persisted into the CANONICAL config owner (`~/.toolnetcli/config.json`,
 * `src/lib/appConfig.ts`). No second config file is introduced.
 *
 * The store is the only place that reads/writes routing settings, so the CLI,
 * the TUI and the harness all mutate the same source of truth. Writes go
 * through `updateAppConfig`, which validates and writes atomically.
 */

import {
  getAppConfig,
  updateAppConfig,
  validateRoutingSettings,
  type AppRoutingSettings,
} from "../../lib/appConfig";
import { ROUTING_PROFILE_NAMES, resolveRoutingProfile } from "./profiles";
import { getRoutingConfig, resetRoutingConfig, setRoutingConfig, type RoutingConfig } from "./router";
import type { RoutingPolicy } from "./types";

const POLICIES: RoutingPolicy[] = ["explicit", "priority", "cheapest", "fastest", "capability-first", "fallback"];

export interface RoutingValidation {
  ok: boolean;
  errors: string[];
  settings?: AppRoutingSettings;
}

/**
 * Validate a candidate routing patch. Unknown profile/policy values are
 * rejected loudly (an API caller asked for something impossible) while the
 * config loader stays lenient (a hand-edited file must not brick the CLI).
 */
export function validateRoutingPatch(patch: Partial<AppRoutingSettings>): RoutingValidation {
  const errors: string[] = [];

  if (patch.profile !== undefined && !(ROUTING_PROFILE_NAMES as string[]).includes(patch.profile.toLowerCase())) {
    errors.push(`Unknown routing profile '${patch.profile}'. Known: ${ROUTING_PROFILE_NAMES.join(", ")}.`);
  }
  if (patch.policy !== undefined && !POLICIES.includes(patch.policy.toLowerCase() as RoutingPolicy)) {
    errors.push(`Unknown routing policy '${patch.policy}'. Known: ${POLICIES.join(", ")}.`);
  }
  if (patch.maxAttempts !== undefined && (!Number.isInteger(patch.maxAttempts) || patch.maxAttempts < 1 || patch.maxAttempts > 10)) {
    errors.push("maxAttempts must be an integer between 1 and 10.");
  }
  for (const reference of patch.fallback ?? []) {
    if (typeof reference !== "string" || !reference.trim() || /\s/.test(reference)) {
      errors.push(`Invalid fallback reference '${String(reference)}'.`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], settings: validateRoutingSettings({ ...currentSettings(), ...patch }) };
}

/** Routing settings currently persisted. */
export function currentSettings(): AppRoutingSettings {
  try {
    return validateRoutingSettings(getAppConfig().routing);
  } catch {
    return validateRoutingSettings(undefined);
  }
}

/** Apply settings to the process-wide router. */
export function applyRoutingSettings(settings: AppRoutingSettings): RoutingConfig {
  return setRoutingConfig({
    profile: resolveRoutingProfile(settings.profile).id,
    policy: settings.policy as RoutingPolicy,
    fallback: settings.fallback,
    maxAttempts: settings.maxAttempts,
    excludedProviders: settings.excludedProviders,
  });
}

/**
 * Load persisted settings into the router. Called once during model-layer
 * bootstrap; safe to call repeatedly (idempotent).
 */
export function loadRoutingConfig(): RoutingConfig {
  const settings = currentSettings();
  return applyRoutingSettings(settings);
}

/** Persist a validated patch and apply it immediately. */
export function persistRoutingConfig(
  patch: Partial<AppRoutingSettings>,
): { ok: true; settings: AppRoutingSettings; config: RoutingConfig } | { ok: false; errors: string[] } {
  const validation = validateRoutingPatch(patch);
  if (!validation.ok || !validation.settings) return { ok: false, errors: validation.errors };

  const saved = updateAppConfig({ routing: validation.settings }).routing;
  const settings = validateRoutingSettings(saved);
  return { ok: true, settings, config: applyRoutingSettings(settings) };
}

/** Add a fallback reference (idempotent, order preserved). */
export function addFallback(reference: string): ReturnType<typeof persistRoutingConfig> {
  const current = currentSettings();
  if (current.fallback.includes(reference)) return persistRoutingConfig({ fallback: current.fallback });
  return persistRoutingConfig({ fallback: [...current.fallback, reference] });
}

export function removeFallback(reference: string): ReturnType<typeof persistRoutingConfig> {
  const current = currentSettings();
  return persistRoutingConfig({ fallback: current.fallback.filter((entry) => entry !== reference) });
}

/** Restore defaults in both the config file and the running router. */
export function resetPersistedRouting(): AppRoutingSettings {
  resetRoutingConfig();
  const saved = validateRoutingSettings(updateAppConfig({ routing: validateRoutingSettings(undefined) }).routing);
  applyRoutingSettings(saved);
  return saved;
}

export { POLICIES };
