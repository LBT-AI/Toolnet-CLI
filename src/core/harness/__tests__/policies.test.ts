/**
 * Phase 81 §6/§7/§8/§9/§10/§11/§12 — policy modules.
 */

import { describe, expect, it } from "bun:test";
import {
  CANONICAL_MAX_CONSECUTIVE_NO_PROGRESS_TURNS,
  PERMISSION_DECISIONS_MARKER,
  PERMISSION_LIMIT_NOTE,
  ProgressTracker,
  applyToolOrdering,
  assemblePromptBase,
  codingProfile,
  composeSystemPrompt,
  computeVerdict,
  defaultProfile,
  detectProgress,
  emptyExecutionEvidence,
  emptySignals,
  ensureDenialsRetained,
  exceedsRepeatedToolCalls,
  exposedToolNames,
  fingerprintResponse,
  isPassthroughPromptPolicy,
  isPassthroughToolPolicy,
  isToolExposed,
  maxTurnsError,
  minimalProfile,
  noProgressError,
  orderByPreference,
  permissionDecisionsBlock,
  prepareOptionsFor,
  repeatedToolCallError,
  resolveMaxTurns,
  toolGuidance as toolPolicyGuidance,
  toolHeavyProfile,
  type ExecutionEvidence,
  type HarnessProfile,
} from "..";

const BLOCKS = {
  codingPolicy: "CODING_POLICY",
  toolUseGuidance: "TOOL_GUIDANCE",
  projectContext: "PROJECT_CONTEXT",
  memoryAndToolRules: "MEMORY_RULES",
  permissionContext: "RUNTIME_PERMISSION_CONTEXT",
  languageDirective: "LANGUAGE_DIRECTIVE",
};

/**
 * Mirrors exactly what AgentHarness passes: the profile's ToolPolicy guidance is
 * forwarded as its own input, not smuggled inside `blocks`.
 */
function promptFor(profile: HarnessProfile) {
  return assemblePromptBase({
    profile,
    blocks: BLOCKS,
    toolPolicyGuidance: toolPolicyGuidance(profile.toolPolicy),
  });
}

function evidence(partial: Partial<ExecutionEvidence> = {}): ExecutionEvidence {
  return { ...emptyExecutionEvidence(), ...partial };
}

// ── §6 prompt policy ─────────────────────────────────────────────────────────

describe("Phase 81 §6 — prompt policy", () => {
  it("default is a prompt pass-through", () => {
    expect(isPassthroughPromptPolicy(defaultProfile.promptPolicy)).toBe(true);
  });

  it("default produces the pre-Phase-81 prompt byte-for-byte", () => {
    const expected = [
      "CODING_POLICY",
      "TOOL_GUIDANCE",
      "PROJECT_CONTEXT",
      "RUNTIME_PERMISSION_CONTEXT",
      PERMISSION_LIMIT_NOTE,
      "MEMORY_RULES",
      "LANGUAGE_DIRECTIVE",
    ].join("\n\n");
    expect(promptFor(defaultProfile)).toBe(expected);
  });

  it("the permission boundary is emitted for EVERY profile", () => {
    for (const profile of [
      defaultProfile,
      minimalProfile,
      codingProfile,
      toolHeavyProfile,
    ]) {
      const prompt = promptFor(profile);
      expect(prompt).toContain("RUNTIME_PERMISSION_CONTEXT");
      expect(prompt).toContain(PERMISSION_LIMIT_NOTE);
    }
  });

  it("minimal drops orchestration guidance but keeps the boundary", () => {
    const prompt = promptFor(minimalProfile);
    expect(prompt).not.toContain("CODING_POLICY");
    expect(prompt).not.toContain("TOOL_GUIDANCE");
    expect(prompt).not.toContain("MEMORY_RULES");
    expect(prompt).toContain(PERMISSION_LIMIT_NOTE);
    expect(prompt).toContain("PROJECT_CONTEXT");
  });

  it("a profile instruction block is appended", () => {
    expect(promptFor(codingProfile)).toContain("INSPECT");
  });

  it("a caller-supplied prompt is used verbatim (existing precedence)", () => {
    const override = "CALLER_PROMPT";
    expect(
      composeSystemPrompt({ profile: codingProfile, blocks: BLOCKS, callerOverride: override }),
    ).toBe(override);
    // Even an empty-string override falls through, exactly as `extra || base` did.
    expect(
      composeSystemPrompt({ profile: codingProfile, blocks: BLOCKS, callerOverride: "" }),
    ).toContain("RUNTIME_PERMISSION_CONTEXT");
  });

  it("tool policy guidance is appended when the profile declares it", () => {
    expect(promptFor(toolHeavyProfile)).toContain("fewest tool calls");
  });
});

// ── §7 tool policy ───────────────────────────────────────────────────────────

describe("Phase 81 §7 — tool policy (exposure, never permission)", () => {
  const all = ["read_file", "shell", "write_file", "grep", "glob"];

  it("default exposes every registered tool", () => {
    expect(isPassthroughToolPolicy(defaultProfile.toolPolicy)).toBe(true);
    expect(exposedToolNames(all, defaultProfile.toolPolicy)).toEqual(all);
  });

  it("an allow-list narrows the set", () => {
    expect(exposedToolNames(all, { allow: ["read_file", "grep"] })).toEqual([
      "read_file",
      "grep",
    ]);
  });

  it("a deny-list narrows the set", () => {
    expect(exposedToolNames(all, { deny: ["shell"], maxRepeatedToolCalls: 3 } as never)).toEqual([
      "read_file",
      "write_file",
      "grep",
      "glob",
    ]);
  });

  it("an allow-list can never widen the set", () => {
    const exposed = exposedToolNames(all, { allow: ["read_file", "not_a_tool"] } as never);
    expect(exposed).toEqual(["read_file"]);
  });

  it("isToolExposed agrees with exposedToolNames", () => {
    const policy = { allow: ["read_file", "shell"] } as never;
    for (const name of all) {
      expect(isToolExposed(name, policy)).toBe(exposedToolNames(all, policy).includes(name));
    }
  });

  it("prefer reorders without removing", () => {
    expect(orderByPreference(all, ["grep", "shell"])).toEqual([
      "grep",
      "shell",
      "read_file",
      "write_file",
      "glob",
    ]);
  });

  it("applyToolOrdering reorders provider schemas in place", () => {
    const schemas = all.map((name) => ({ type: "function" as const, function: { name } }));
    const ordered = applyToolOrdering(schemas, { prefer: ["glob"] } as never);
    expect(ordered[0].function.name).toBe("glob");
    expect(ordered).toHaveLength(schemas.length);
  });

  it("toolGuidance returns undefined when a profile declares none", () => {
    expect(toolPolicyGuidance(defaultProfile.toolPolicy)).toBeUndefined();
    expect(toolPolicyGuidance(toolHeavyProfile.toolPolicy)).toContain("fewest tool calls");
  });
});

// ── §8 continuation policy ───────────────────────────────────────────────────

describe("Phase 81 §8 — bounded continuation", () => {
  it("uses the canonical repeat bound and reports the historical loop message", () => {
    expect(exceedsRepeatedToolCalls(defaultProfile.continuationPolicy, 2)).toBe(false);
    expect(exceedsRepeatedToolCalls(defaultProfile.continuationPolicy, 3)).toBe(true);
    expect(repeatedToolCallError("bash", 3)).toContain("Infinite loop detected");
  });

  it("a disabled bound (0) never triggers", () => {
    expect(exceedsRepeatedToolCalls({ maxRepeatedToolCalls: 0 } as never, 99)).toBe(false);
  });

  it("resolves the turn budget: caller > profile > config > fallback", () => {
    expect(resolveMaxTurns(4, 16, 10, 10)).toBe(4);
    expect(resolveMaxTurns(undefined, 16, 10, 10)).toBe(16);
    expect(resolveMaxTurns(undefined, undefined, 7, 10)).toBe(7);
    expect(resolveMaxTurns(undefined, undefined, undefined, 10)).toBe(10);
    // `0` is falsy, exactly like the pre-Phase-81 `||` chain.
    expect(resolveMaxTurns(0, undefined, undefined, 10)).toBe(10);
  });

  it("abort messages are stable and actionable", () => {
    expect(noProgressError(3)).toContain("No progress detected");
    expect(maxTurnsError(8)).toContain("Exceeded maximum turn count (8)");
  });
});

// ── §9 progress detection ────────────────────────────────────────────────────

describe("Phase 81 §9 — deterministic progress detection", () => {
  it("the first turn counts as progress", () => {
    expect(detectProgress(null, emptySignals()).progressed).toBe(true);
  });

  it("a new tool call, mutation, command or diagnostic is progress", () => {
    const base = emptySignals();
    expect(detectProgress(base, { ...base, toolCalls: 1 }).reasons).toContain("new tool call");
    expect(detectProgress(base, { ...base, mutations: 1 }).reasons).toContain("new file mutation");
    expect(detectProgress(base, { ...base, commands: 1 }).reasons).toContain("new command result");
    expect(detectProgress(base, { ...base, diagnostics: 1 }).reasons).toContain(
      "new diagnostic/test state",
    );
  });

  it("a different response is progress; an identical one is not", () => {
    const base = { ...emptySignals(), responseFingerprint: fingerprintResponse("Done.") };
    expect(detectProgress(base, { ...base, responseFingerprint: fingerprintResponse("Other") }).progressed).toBe(true);
    expect(detectProgress(base, { ...base }).progressed).toBe(false);
  });

  it("whitespace and case do not create false progress", () => {
    expect(fingerprintResponse("Done.  ")).toBe(fingerprintResponse("done."));
    expect(fingerprintResponse("a  b")).toBe(fingerprintResponse("a b"));
  });

  it("a final response is always progress", () => {
    const base = emptySignals();
    expect(detectProgress(base, { ...base, finalResponse: true }).progressed).toBe(true);
  });

  it("tracks a streak and reports the bound", () => {
    const tracker = new ProgressTracker(CANONICAL_MAX_CONSECUTIVE_NO_PROGRESS_TURNS);
    const stalled = { ...emptySignals(), responseFingerprint: fingerprintResponse("same") };
    tracker.observe(stalled);
    expect(tracker.observe(stalled).noProgressTurns).toBe(1);
    expect(tracker.exceeded()).toBe(false);
    expect(tracker.observe(stalled).noProgressTurns).toBe(2);
    expect(tracker.exceeded()).toBe(false);
    expect(tracker.observe(stalled).noProgressTurns).toBe(3);
    expect(tracker.exceeded()).toBe(true);
  });

  it("progress resets the streak", () => {
    const tracker = new ProgressTracker(3);
    const stalled = emptySignals();
    tracker.observe(stalled);
    tracker.observe(stalled);
    expect(tracker.noProgressTurns).toBe(1);
    tracker.observe({ ...stalled, toolCalls: 1 });
    expect(tracker.noProgressTurns).toBe(0);
    expect(tracker.exceeded()).toBe(false);
  });

  it("a disabled tracker never reports the bound", () => {
    const tracker = new ProgressTracker(0);
    expect(tracker.enabled).toBe(false);
    for (let i = 0; i < 10; i++) tracker.observe(emptySignals());
    expect(tracker.exceeded()).toBe(false);
  });
});

// ── §10 context policy ───────────────────────────────────────────────────────

describe("Phase 81 §10 — context policy and permission retention", () => {
  it("default forwards the existing pipeline settings unchanged", () => {
    expect(prepareOptionsFor(defaultProfile.contextPolicy)).toEqual({
      autoPrune: true,
      forceCompact: false,
    });
  });

  it("a denial block names the tool and states the decision is final", () => {
    const block = permissionDecisionsBlock([{ toolName: "write_file", reason: "denied" }]);
    expect(block).toContain(PERMISSION_DECISIONS_MARKER);
    expect(block).toContain("write_file");
    expect(block).toContain("do not retry");
  });

  it("re-attaches decisions when the prepared window lost them", () => {
    const prepared = [{ role: "user", content: "hi" }];
    const result = ensureDenialsRetained(
      prepared,
      [{ toolName: "write_file", reason: "denied" }],
      defaultProfile.contextPolicy,
    );
    expect(result.appended).toContain(PERMISSION_DECISIONS_MARKER);
    expect(result.messages).toHaveLength(2);
  });

  it("does not duplicate a retained block", () => {
    const retained = [{ role: "user", content: permissionDecisionsBlock([]) }];
    const result = ensureDenialsRetained(
      retained,
      [{ toolName: "shell", reason: "denied" }],
      defaultProfile.contextPolicy,
    );
    expect(result.appended).toBeUndefined();
    expect(result.messages).toHaveLength(1);
  });

  it("does nothing when there were no denials", () => {
    const prepared = [{ role: "user", content: "hi" }];
    const result = ensureDenialsRetained(prepared, [], defaultProfile.contextPolicy);
    expect(result.appended).toBeUndefined();
    expect(result.messages).toBe(prepared);
  });

  it("a profile may opt out, and the default explicitly opts in", () => {
    const result = ensureDenialsRetained(
      [],
      [{ toolName: "shell", reason: "denied" }],
      { ...defaultProfile.contextPolicy, protectPermissionResults: false },
    );
    expect(result.appended).toBeUndefined();
    expect(defaultProfile.contextPolicy.protectPermissionResults).toBe(true);
  });
});

// ── §11 completion verdict ───────────────────────────────────────────────────

describe("Phase 81 §11 — completion verdict", () => {
  const requirements = {
    mutationRequired: false,
    executionRequired: false,
    verificationRequired: false,
    testRequired: false,
  };
  const verified = { mutations: 0, executions: 0, tests: 0, verifications: 0 };
  const policy = codingProfile.completionPolicy;

  function verdict(overrides: Partial<Parameters<typeof computeVerdict>[0]> = {}) {
    return computeVerdict({
      policy,
      requirements,
      verified,
      evidence: evidence(),
      runSucceeded: true,
      cancelled: false,
      timedOut: false,
      hasOutput: true,
      ...overrides,
    });
  }

  it("SUCCESS when nothing was required", () => {
    expect(verdict().verdict).toBe("SUCCESS");
  });

  it("CANCELLED and TIMEOUT are run states, not quality signals", () => {
    expect(verdict({ cancelled: true }).verdict).toBe("CANCELLED");
    expect(verdict({ timedOut: true }).verdict).toBe("TIMEOUT");
    // Cancellation outranks an unmet requirement.
    expect(
      verdict({ cancelled: true, requirements: { ...requirements, mutationRequired: true } }).verdict,
    ).toBe("CANCELLED");
  });

  it("FAILED when the loop itself failed", () => {
    const result = verdict({ runSucceeded: false });
    expect(result.verdict).toBe("FAILED");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("'Done.' with no file change is never SUCCESS", () => {
    const result = verdict({ requirements: { ...requirements, mutationRequired: true } });
    expect(result.verdict).not.toBe("SUCCESS");
    expect(result.verdict).toBe("FAILED");
    expect(result.reasons.join(" ")).toContain("never changed");
  });

  it("a narrated test pass with no test run is never SUCCESS", () => {
    const result = verdict({
      requirements: { ...requirements, testRequired: true, verificationRequired: true },
      verified: { ...verified, mutations: 1 },
    });
    expect(result.verdict).toBe("PARTIAL");
    expect(result.reasons.join(" ")).toContain("tests required");
  });

  it("PARTIAL when real work happened but a requirement is outstanding", () => {
    const result = verdict({
      requirements: { ...requirements, testRequired: true },
      verified: { ...verified, mutations: 1 },
    });
    expect(result.verdict).toBe("PARTIAL");
  });

  it("SUCCESS when every required step has verified evidence", () => {
    const result = verdict({
      requirements: {
        mutationRequired: true,
        executionRequired: true,
        verificationRequired: true,
        testRequired: true,
      },
      verified: { mutations: 2, executions: 3, tests: 1, verifications: 1 },
    });
    expect(result.verdict).toBe("SUCCESS");
    expect(result.reasons).toEqual([]);
  });

  it("a profile that does not enforce evidence still grades its own requirements", () => {
    const result = verdict({
      policy: { ...policy, requireEvidenceForSuccess: false },
      requirements: { ...requirements, mutationRequired: true },
    });
    expect(result.verdict).toBe("SUCCESS");
  });
});
