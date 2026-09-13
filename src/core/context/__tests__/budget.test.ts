import { describe, test, expect } from "bun:test";
import { ModelCatalog } from "../../models/catalog";
import type { ModelDefinition } from "../../models/types";
import { TokenEstimator, tokenEstimator } from "../estimator";
import { resolveModelLimits } from "../limits";
import { computeContextBudget, estimateToolOverhead, projectedRequestTokens } from "../budget";
import { planContext, carriesPermissionDecision } from "../planner";
import { PERMISSION_DECISIONS_MARKER } from "../../harness/context";

function catalogWith(model: Partial<ModelDefinition> & { id: string; providerId: string; apiModelId: string }) {
  const catalog = new ModelCatalog();
  catalog.replaceProviderModels(model.providerId, [{ capabilities: {}, status: "active", ...model } as ModelDefinition]);
  return catalog;
}

describe("token estimation provenance", () => {
  test("an estimate is never labelled exact", () => {
    const estimate = tokenEstimator.estimateText("some ordinary text");
    expect(estimate.source).toBe("estimated");
    expect(estimate.confidence).not.toBe("exact");
    expect(estimate.tokens).toBeGreaterThan(0);
  });

  test("provider usage is the only exact source and does not overwrite history", () => {
    const estimator = new TokenEstimator();
    const before = estimator.estimateText("hello world").tokens;
    estimator.observeProviderUsage({ model: "m", estimatedInputTokens: 1000, actualPromptTokens: 1400 });
    const exact = estimator.fromProviderUsage(1400);
    expect(exact.source).toBe("provider_usage");
    expect(exact.confidence).toBe("exact");
    // Calibration applies to FUTURE estimates; the recorded measurement is intact.
    expect(exact.tokens).toBe(1400);
    expect(estimator.estimateText("hello world").tokens).toBeGreaterThanOrEqual(before);
  });

  test("a single odd measurement cannot distort future estimates", () => {
    const estimator = new TokenEstimator();
    estimator.observeProviderUsage({ model: "m", estimatedInputTokens: 1, actualPromptTokens: 1_000_000 });
    expect(estimator.factorFor("m")).toBeLessThanOrEqual(1.6);
    estimator.observeProviderUsage({ model: "m", estimatedInputTokens: 1_000_000, actualPromptTokens: 1 });
    expect(estimator.factorFor("m")).toBeGreaterThanOrEqual(0.6);
  });

  test("a provider that reports nothing is ignored rather than treated as an empty prompt", () => {
    const estimator = new TokenEstimator();
    estimator.observeProviderUsage({ model: "m", estimatedInputTokens: 100, actualPromptTokens: 0 });
    estimator.observeProviderUsage({ model: "m", estimatedInputTokens: 0, actualPromptTokens: 100 });
    expect(estimator.factorFor("m")).toBe(1);
  });

  test("multibyte scripts are estimated tighter than latin text of the same length", () => {
    const estimator = new TokenEstimator();
    const latin = estimator.estimateText("a".repeat(400)).tokens;
    const vietnamese = estimator.estimateText("ử".repeat(400)).tokens;
    expect(vietnamese).toBeGreaterThan(latin);
  });
});

describe("model limits", () => {
  test("the catalog is authoritative when it declares a window", () => {
    const catalog = catalogWith({
      id: "acme/big-model",
      providerId: "acme",
      apiModelId: "big-model",
      contextWindow: 555_000,
      maxOutputTokens: 12_000,
    });
    const limits = resolveModelLimits("acme/big-model", catalog);
    expect(limits).toEqual({ contextWindow: 555_000, maxOutputTokens: 12_000, source: "catalog" });
  });

  test("a catalog entry that declares one value still supplies it and falls back for the other", () => {
    const catalog = catalogWith({ id: "acme/half", providerId: "acme", apiModelId: "half", contextWindow: 90_000 });
    const limits = resolveModelLimits("acme/half", catalog);
    expect(limits.contextWindow).toBe(90_000);
    expect(limits.maxOutputTokens).toBeGreaterThan(0);
    expect(limits.source).toBe("catalog");
  });

  test("an unknown model is treated as narrow and marked, never guessed high", () => {
    const limits = resolveModelLimits("totally-unknown-xyz");
    expect(limits.source).toBe("fallback");
    expect(limits.contextWindow).toBeLessThanOrEqual(32_000);
  });

  test("limits.source distinguishes catalog from compatibility table from fallback", () => {
    expect(resolveModelLimits("openai/gpt-4o").source).toBe("legacy_table");
    expect(resolveModelLimits("closed-weight-9000").source).toBe("fallback");
  });

  test("a pre-catalog identity keeps the compaction trigger it already had", () => {
    // Regression: deriving a uniform threshold silently moved these identities'
    // cadence, so a transcript that used to compact no longer did.
    expect(resolveModelLimits("openai/gpt-4o").compactionThreshold).toBe(96_000);
    expect(resolveModelLimits("anthropic/claude-3-5-sonnet").compactionThreshold).toBe(150_000);
    expect(resolveModelLimits("default").compactionThreshold).toBe(8_000);
    expect(resolveModelLimits(undefined).compactionThreshold).toBe(8_000);
    // A catalog model carries no compatibility threshold — the budget derives it.
    expect(resolveModelLimits("acme/big-model", catalogWith({ id: "acme/big-model", providerId: "acme", apiModelId: "big-model", contextWindow: 555_000 })).compactionThreshold).toBeUndefined();
  });
});

describe("context budgeting", () => {
  test("output capacity is reserved so input cannot consume the whole window", () => {
    const catalog = catalogWith({
      id: "acme/wide",
      providerId: "acme",
      apiModelId: "wide",
      contextWindow: 128_000,
      maxOutputTokens: 32_000,
    });
    const budget = computeContextBudget({
      messages: [{ role: "user", content: "hi" }],
      model: "acme/wide",
      catalog,
    });
    // Only the capped reserve is withheld, not the full 32k output allowance.
    expect(budget.reservedOutput).toBeGreaterThan(0);
    expect(budget.reservedOutput).toBeLessThan(32_000);
    expect(budget.usableInput).toBeLessThan(128_000);
    expect(budget.usableInput + budget.reservedOutput).toBeLessThanOrEqual(128_000);
  });

  test("system instructions and tool schemas are withheld rather than double-charged", () => {
    const system = "You are a careful agent. ".repeat(20);
    const budget = computeContextBudget({
      messages: [
        { role: "system", content: system },
        { role: "user", content: "do the thing" },
      ],
      model: "openai/gpt-4o",
      tools: [{ name: "read_file", description: "read", parameters: { type: "object" } }],
    });
    expect(budget.reservedSystem).toBeGreaterThan(0);
    expect(budget.reservedTools).toBeGreaterThan(0);
    // estimatedInput covers the transcript only.
    expect(budget.estimatedInput).toBeLessThan(budget.reservedSystem + budget.estimatedInput);
    expect(projectedRequestTokens(budget)).toBe(budget.reservedSystem + budget.reservedTools + budget.estimatedInput);
    expect(projectedRequestTokens(budget)).toBeLessThanOrEqual(budget.contextWindow);
  });

  test("a tool schema that cannot be serialized is charged a small amount instead of zero", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(estimateToolOverhead([circular])).toBeGreaterThan(0);
    expect(estimateToolOverhead([])).toBe(0);
  });

  test("the compaction threshold sits strictly below usable capacity", () => {
    const budget = computeContextBudget({ messages: [{ role: "user", content: "x" }], model: "openai/gpt-4o" });
    expect(budget.threshold).toBeLessThan(budget.usableInput);
    expect(budget.overThreshold).toBe(false);
    expect(budget.overflow).toBe(false);
  });

  test("an unknown model still produces a usable, conservative budget", () => {
    const budget = computeContextBudget({ messages: [{ role: "user", content: "x" }], model: "who-knows" });
    expect(budget.contextWindow).toBeLessThanOrEqual(32_000);
    expect(budget.usableInput).toBeGreaterThan(0);
    expect(budget.source).toBe("fallback");
  });
});

describe("context planning", () => {
  test("a permission denial is protected and recognised in the shapes tools emit", () => {
    const messages = [
      { role: "system", content: "instructions" },
      { role: "user", content: "delete the repo" },
      { role: "tool", name: "shell", content: JSON.stringify({ decision: "DENY", reason: "destructive" }) },
      { role: "assistant", content: "I cannot do that." },
      { role: "user", content: "then list files" },
      { role: "user", content: `${PERMISSION_DECISIONS_MARKER}\n- shell: DENIED (destructive).` },
    ];
    const budget = computeContextBudget({ messages, model: "openai/gpt-4o" });
    const plan = planContext({ messages, budget });
    const denial = plan.included.find((item) => item.category === "permission_decisions");
    expect(denial).toBeDefined();
    expect(denial?.protected).toBe(true);
    expect(carriesPermissionDecision(messages[2])).toBe(true);
  });

  test("the latest task and an unresolved failure stay protected", () => {
    const messages = [
      { role: "system", content: "instructions" },
      { role: "user", content: "fix the failing test" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "shell", arguments: "{}" } }] },
      { role: "tool", name: "shell", content: JSON.stringify({ stdout: "", stderr: "boom", exitCode: 1 }) },
    ];
    const budget = computeContextBudget({ messages, model: "openai/gpt-4o" });
    const plan = planContext({ messages, budget });
    const task = plan.included.find((item) => item.category === "current_task");
    const failure = plan.included.find((item) => item.category === "active_error");
    expect(task?.protected).toBe(true);
    expect(failure?.protected).toBe(true);
  });

  test("a tool result identical to a newer one is redundant rather than counted twice", () => {
    const payload = JSON.stringify({ stdout: "same output ".repeat(40), exitCode: 0 });
    const messages = [
      { role: "user", content: "go" },
      { role: "tool", name: "shell", content: payload },
      { role: "tool", name: "shell", content: payload },
      { role: "tool", name: "shell", content: payload },
      { role: "tool", name: "shell", content: payload },
    ];
    const budget = computeContextBudget({ messages, model: "openai/gpt-4o" });
    const plan = planContext({ messages, budget, keepRecentToolResults: 0 });
    const redundant = plan.included.filter((item) => item.reason.includes("identical to a newer"));
    expect(redundant.length).toBe(3);
    expect(redundant.every((item) => item.protected === false)).toBe(true);
    expect(plan.prunableTokens).toBeGreaterThan(0);
  });

  test("planning describes a window without mutating the transcript", () => {
    const messages = [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ];
    const snapshot = JSON.stringify(messages);
    const budget = computeContextBudget({ messages, model: "openai/gpt-4o" });
    planContext({ messages, budget });
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
});
