/**
 * Phase 81 §16/§17 — harness resolution.
 *
 * Harness selection and model routing are INDEPENDENT. This module decides only
 * which policy contract runs; the ModelRouter separately decides which model
 * serves the request. Nothing here names a model, and the router never consults
 * a harness profile.
 *
 * Resolution is deterministic and total:
 *
 *   1. explicit profile id  → that profile, or a structured error (never a
 *                             silent fallback — a mistyped id must fail loudly)
 *   2. task type            → the single AUTO_HARNESS_BY_TASK table
 *   3. `default`
 */

import { harnessProfileNotFound } from "./errors";
import {
  AUTO_HARNESS_BY_TASK,
  DEFAULT_HARNESS_PROFILE_ID,
} from "./profiles";
import { harnessRegistry, type HarnessRegistry } from "./registry";
import type {
  HarnessProfile,
  HarnessResolution,
  HarnessResolveRequest,
} from "./types";

/** Resolution used by the harness hot path: never throws, never does I/O. */
export function resolveHarnessProfile(
  request: HarnessResolveRequest = {},
  registry: HarnessRegistry = harnessRegistry,
): HarnessResolution {
  const explicitId = request.profile?.trim();

  if (explicitId) {
    const found = registry.get(explicitId);
    if (!found) {
      // An explicit id is a contract: fail loudly rather than running a
      // different profile than the caller asked for.
      throw harnessProfileNotFound(explicitId, registry.ids());
    }
    return { profile: found, explicit: true, reason: "explicit profile id" };
  }

  const byTask = request.taskType ? AUTO_HARNESS_BY_TASK[request.taskType] : undefined;
  if (byTask) {
    const found = registry.get(byTask);
    if (found) {
      return {
        profile: found,
        explicit: false,
        reason: `task type '${request.taskType}' → ${byTask}`,
      };
    }
  }

  const fallback = registry.get(DEFAULT_HARNESS_PROFILE_ID) ?? registry.defaultProfile;
  return {
    profile: fallback,
    explicit: false,
    reason: request.taskType
      ? `task type '${request.taskType}' has no dedicated profile → default`
      : "no task signal → default",
  };
}

/** Safe variant for CLI/config validation where an error must become a message. */
export function tryResolveHarnessProfile(
  request: HarnessResolveRequest = {},
  registry: HarnessRegistry = harnessRegistry,
): { ok: true; resolution: HarnessResolution } | { ok: false; error: string; known: string[] } {
  try {
    return { ok: true, resolution: resolveHarnessProfile(request, registry) };
  } catch (error) {
    const known = registry.ids();
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      known,
    };
  }
}

/** One-line summary used by `toolnet harness list` and the TUI panel. */
export function describeHarnessProfile(profile: HarnessProfile): string {
  return `${profile.id} — ${profile.description}`;
}

/**
 * Human-readable policy boundaries. Used by `toolnet harness show` so the
 * "policy only, never permission" contract is visible to the operator.
 */
export function summarizeHarnessProfile(profile: HarnessProfile): string[] {
  const { promptPolicy, toolPolicy, continuationPolicy, contextPolicy, completionPolicy } =
    profile;
  const tools =
    toolPolicy.allow === undefined
      ? "all registered tools"
      : `${toolPolicy.allow.length} allowed`;
  const denied = toolPolicy.deny?.length ? `, ${toolPolicy.deny.length} denied` : "";
  return [
    `Prompt     : verbosity=${promptPolicy.verbosity}, codingPolicy=${promptPolicy.includeCodingPolicy}, toolGuidance=${promptPolicy.includeToolUseGuidance}, projectContext=${promptPolicy.includeProjectContext}`,
    `Tools      : ${tools}${denied} (exposure only — permission is unchanged)`,
    `Continuation: maxTurns=${continuationPolicy.maxTurns ?? "caller default"}, maxRepeatedToolCalls=${continuationPolicy.maxRepeatedToolCalls}, maxNoProgressTurns=${continuationPolicy.maxConsecutiveNoProgressTurns || "disabled"}`,
    `Context    : mode=${contextPolicy.mode}, autoPrune=${contextPolicy.autoPrune}, forceCompact=${contextPolicy.forceCompact}, protectPermissionResults=${contextPolicy.protectPermissionResults}`,
    `Completion : enforceEvidence=${completionPolicy.enforceEvidence}, requireEvidenceForSuccess=${completionPolicy.requireEvidenceForSuccess}, requireVerificationForSuccess=${completionPolicy.requireVerificationForSuccess}`,
  ];
}
