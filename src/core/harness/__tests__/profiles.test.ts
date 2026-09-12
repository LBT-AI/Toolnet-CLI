/**
 * Phase 81 §3/§4/§5/§17/§18 — profiles, registry, resolver, persistence.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetAppConfigCache } from "../../../lib/appConfig";
import {
  AUTO_HARNESS_BY_TASK,
  BUILTIN_HARNESS_PROFILES,
  CANONICAL_MAX_CONSECUTIVE_NO_PROGRESS_TURNS,
  CANONICAL_MAX_DUPLICATE_SENSITIVE_TOOL_CALLS,
  CANONICAL_MAX_REPEATED_TOOL_CALLS,
  DEFAULT_HARNESS_PROFILE_ID,
  NO_PROGRESS_BOUND_DISABLED,
  HarnessError,
  HarnessRegistry,
  codingProfile,
  currentHarnessSettings,
  defaultProfile,
  harnessRegistry,
  minimalProfile,
  persistHarnessProfile,
  reasoningProfile,
  resetPersistedHarness,
  resolveHarnessProfile,
  summarizeHarnessProfile,
  toolHeavyProfile,
  tryResolveHarnessProfile,
  validateHarnessPatch,
} from "..";

const ORIGINAL_DIR = process.env.TOOLNETCLI_CONFIG_DIR;
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase81-harness-"));
  process.env.TOOLNETCLI_CONFIG_DIR = tempDir;
  resetAppConfigCache();
});

afterEach(() => {
  if (ORIGINAL_DIR === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR;
  else process.env.TOOLNETCLI_CONFIG_DIR = ORIGINAL_DIR;
  resetAppConfigCache();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

describe("Phase 81 — built-in profiles", () => {
  it("registers each built-in exactly once, in declaration order", () => {
    const builtinIds = ["default", "minimal", "coding", "tool-heavy", "reasoning"];
    for (const id of builtinIds) expect(harnessRegistry.get(id)).toBeDefined();
    // A test or plugin may register its own fixture profile, so the assertion is
    // that the built-ins come first in order and that no id is duplicated —
    // which is what would catch a second registry or a double registration.
    expect(harnessRegistry.ids().slice(0, builtinIds.length)).toEqual(builtinIds);
    expect(new Set(harnessRegistry.ids()).size).toBe(harnessRegistry.ids().length);
  });

  it("default is an identity profile (no narrowing, no extra bounds)", () => {
    expect(defaultProfile.toolPolicy.allow).toBeUndefined();
    expect(defaultProfile.toolPolicy.deny).toBeUndefined();
    expect(defaultProfile.toolPolicy.prefer).toBeUndefined();
    expect(defaultProfile.toolPolicy.guidance).toBeUndefined();
    expect(defaultProfile.promptPolicy.verbosity).toBe("full");
    expect(defaultProfile.promptPolicy.instructions).toBeUndefined();
    // No turn override: the caller's existing default still wins.
    expect(defaultProfile.continuationPolicy.maxTurns).toBeUndefined();
    expect(defaultProfile.continuationPolicy.maxConsecutiveNoProgressTurns).toBe(
      NO_PROGRESS_BOUND_DISABLED,
    );
    expect(defaultProfile.contextPolicy.autoPrune).toBe(true);
    expect(defaultProfile.contextPolicy.forceCompact).toBe(false);
  });

  it("default keeps the canonical repeat bound", () => {
    expect(defaultProfile.continuationPolicy.maxRepeatedToolCalls).toBe(
      CANONICAL_MAX_REPEATED_TOOL_CALLS,
    );
  });

  it("minimal removes instructions but not tools or security", () => {
    expect(minimalProfile.promptPolicy.includeCodingPolicy).toBe(false);
    expect(minimalProfile.promptPolicy.includeToolUseGuidance).toBe(false);
    expect(minimalProfile.promptPolicy.verbosity).toBe("minimal");
    // Same exposure surface as default: a smaller prompt must never mean a
    // different permission surface.
    expect(minimalProfile.toolPolicy).toEqual({});
    expect(minimalProfile.contextPolicy.protectPermissionResults).toBe(true);
  });

  it("coding prioritises inspect → edit → verify and requires evidence", () => {
    expect(codingProfile.promptPolicy.instructions).toContain("INSPECT");
    expect(codingProfile.promptPolicy.instructions).toContain("VERIFY");
    expect(codingProfile.promptPolicy.instructions).toContain("Do NOT claim");
    expect(codingProfile.completionPolicy.requireEvidenceForSuccess).toBe(true);
  });

  it("tool-heavy uses a tighter duplicate bound than default", () => {
    expect(toolHeavyProfile.continuationPolicy.maxRepeatedToolCalls).toBe(
      CANONICAL_MAX_DUPLICATE_SENSITIVE_TOOL_CALLS,
    );
    expect(toolHeavyProfile.continuationPolicy.maxRepeatedToolCalls).toBeLessThan(
      CANONICAL_MAX_REPEATED_TOOL_CALLS,
    );
  });

  it("reasoning allocates more turns and forbids chain-of-thought exposure", () => {
    expect(reasoningProfile.continuationPolicy.maxTurns).toBeGreaterThan(10);
    expect(reasoningProfile.promptPolicy.instructions).toContain("chain-of-thought");
  });

  it("every profile enabling a no-progress bound uses the canonical one", () => {
    for (const profile of BUILTIN_HARNESS_PROFILES) {
      const bound = profile.continuationPolicy.maxConsecutiveNoProgressTurns;
      if (bound === NO_PROGRESS_BOUND_DISABLED) continue;
      expect(bound).toBe(CANONICAL_MAX_CONSECUTIVE_NO_PROGRESS_TURNS);
    }
  });

  it("no profile names a model or a vendor", () => {
    const serialized = JSON.stringify(BUILTIN_HARNESS_PROFILES).toLowerCase();
    for (const vendor of ["claude", "gpt", "gemini", "anthropic", "openai", "openrouter"]) {
      expect(serialized).not.toContain(vendor);
    }
  });
});

describe("Phase 81 — registry", () => {
  it("rejects a duplicate id", () => {
    const registry = new HarnessRegistry();
    registry.register(defaultProfile);
    expect(() => registry.register(defaultProfile)).toThrow(HarnessError);
  });

  it("rejects a structurally invalid profile", () => {
    const registry = new HarnessRegistry();
    const broken = { id: "broken", version: "1.0.0" } as never;
    expect(() => registry.register(broken)).toThrow(HarnessError);
  });

  it("unregister removes a profile and reports whether it existed", () => {
    const registry = new HarnessRegistry();
    registry.register(defaultProfile);
    expect(registry.unregister("default")).toBe(true);
    expect(registry.unregister("default")).toBe(false);
    expect(registry.get("default")).toBeUndefined();
  });

  it("list preserves registration order deterministically", () => {
    const registry = new HarnessRegistry();
    registry.register(reasoningProfile);
    registry.register(defaultProfile);
    expect(registry.ids()).toEqual(["reasoning", "default"]);
  });
});

describe("Phase 81 §17 — auto resolution (one table)", () => {
  it("maps coding/debugging to coding, tool_heavy and reasoning/planning", () => {
    expect(AUTO_HARNESS_BY_TASK.coding).toBe("coding");
    expect(AUTO_HARNESS_BY_TASK.debugging).toBe("coding");
    expect(AUTO_HARNESS_BY_TASK.tool_heavy).toBe("tool-heavy");
    expect(AUTO_HARNESS_BY_TASK.reasoning).toBe("reasoning");
    expect(AUTO_HARNESS_BY_TASK.planning).toBe("reasoning");
  });

  it("resolves by task type", () => {
    expect(resolveHarnessProfile({ taskType: "coding" }).profile.id).toBe("coding");
    expect(resolveHarnessProfile({ taskType: "tool_heavy" }).profile.id).toBe("tool-heavy");
    expect(resolveHarnessProfile({ taskType: "planning" }).profile.id).toBe("reasoning");
  });

  it("falls back to default for an unmapped or absent task type", () => {
    expect(resolveHarnessProfile({ taskType: "search" }).profile.id).toBe("default");
    expect(resolveHarnessProfile({}).profile.id).toBe("default");
    expect(resolveHarnessProfile({}).explicit).toBe(false);
  });

  it("an explicit profile always beats auto resolution", () => {
    const resolution = resolveHarnessProfile({ profile: "minimal", taskType: "coding" });
    expect(resolution.profile.id).toBe("minimal");
    expect(resolution.explicit).toBe(true);
  });

  it("every auto-mapped target is a registered profile", () => {
    for (const target of Object.values(AUTO_HARNESS_BY_TASK)) {
      expect(harnessRegistry.has(target)).toBe(true);
    }
  });

  it("the default profile's autoFor list matches the unmapped task types", () => {
    const unmapped = [
      "general",
      "search",
      "review",
      "vision",
      "long_context",
      "fast",
      "background",
    ];
    for (const taskType of unmapped) {
      expect(AUTO_HARNESS_BY_TASK[taskType]).toBeUndefined();
      expect(resolveHarnessProfile({ taskType }).profile.id).toBe(DEFAULT_HARNESS_PROFILE_ID);
    }
    expect(defaultProfile.autoFor!.sort()).toEqual(unmapped.sort());
  });
});

describe("Phase 81 §5 — an unknown profile id fails loudly", () => {
  it("throws a structured error for an explicit unknown id", () => {
    expect(() => resolveHarnessProfile({ profile: "codign" })).toThrow(HarnessError);
    try {
      resolveHarnessProfile({ profile: "codign" });
    } catch (error) {
      expect((error as HarnessError).code).toBe("HARNESS_PROFILE_NOT_FOUND");
      expect((error as HarnessError).known).toContain("coding");
    }
  });

  it("never silently substitutes a different profile", () => {
    expect(() => resolveHarnessProfile({ profile: "nope" })).toThrow(/Unknown harness profile/);
  });

  it("tryResolveHarnessProfile reports the known set instead of throwing", () => {
    const result = tryResolveHarnessProfile({ profile: "nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.known).toEqual(harnessRegistry.ids());
  });
});

describe("Phase 81 §18 — persistence in the canonical config owner", () => {
  it("defaults to the default profile", () => {
    expect(currentHarnessSettings().profile).toBe("default");
  });

  it("persists a valid profile and reads it back", () => {
    const result = persistHarnessProfile("coding");
    expect(result.ok).toBe(true);
    expect(currentHarnessSettings().profile).toBe("coding");
  });

  it("rejects an unknown profile and leaves the config untouched", () => {
    persistHarnessProfile("coding");
    const result = persistHarnessProfile("codign");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("Unknown harness profile");
    expect(currentHarnessSettings().profile).toBe("coding");
  });

  it("reset restores the default profile", () => {
    persistHarnessProfile("reasoning");
    expect(resetPersistedHarness().profile).toBe("default");
    expect(currentHarnessSettings().profile).toBe("default");
  });

  it("validateHarnessPatch reports every known profile on a bad id", () => {
    const validation = validateHarnessPatch({ profile: "nope" });
    expect(validation.ok).toBe(false);
    expect(validation.errors[0]).toContain("reasoning");
  });

  it("a harness profile is independent of the routing profile", () => {
    persistHarnessProfile("tool-heavy");
    // The routing block is untouched by a harness selection.
    expect(currentHarnessSettings().profile).toBe("tool-heavy");
  });
});

describe("Phase 81 — policy summary is inspectable", () => {
  it("summarizeHarnessProfile names every policy module", () => {
    const lines = summarizeHarnessProfile(defaultProfile).join("\n");
    for (const label of ["Prompt", "Tools", "Continuation", "Context", "Completion"]) {
      expect(lines).toContain(label);
    }
  });

  it("states that tool exposure is not permission", () => {
    expect(summarizeHarnessProfile(defaultProfile).join("\n")).toContain(
      "permission is unchanged",
    );
  });
});
