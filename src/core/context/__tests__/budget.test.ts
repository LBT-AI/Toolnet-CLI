import { describe, test, expect } from "bun:test";
import { ModelCatalog } from "../../models/catalog";
import type { ModelDefinition } from "../../models/types";
import { TokenEstimator, tokenEstimator } from "../estimator";
import { COMPACTION_BUFFER, resolveModelLimits, resolveUsableInput } from "../limits";
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

  test("a declared input limit is used only when it is smaller than the window", () => {
    const catalog = catalogWith({
      id: "acme/split",
      providerId: "acme",
      apiModelId: "split",
      contextWindow: 200_000,
      maxOutputTokens: 8_000,
      limits: { input: 150_000 },
    });
    expect(resolveModelLimits("acme/split", catalog).inputLimit).toBe(150_000);

    // A value at or above the window says nothing new and is not an input limit.
    const contradictory = catalogWith({
      id: "acme/odd",
      providerId: "acme",
      apiModelId: "odd",
      contextWindow: 100_000,
      maxOutputTokens: 8_000,
      limits: { input: 100_000 },
    });
    expect(resolveModelLimits("acme/odd", contradictory).inputLimit).toBeUndefined();
  });

  test("usable input follows the model's own metadata, not a global threshold", () => {
    // No input limit: the window minus the model's output allowance.
    const plain = resolveUsableInput({ contextWindow: 128_000, maxOutputTokens: 4_096 });
    expect(plain.rule).toBe("context_minus_output");
    expect(plain.usable).toBe(123_904);

    // An input limit: the limit minus the withheld answer capacity.
    const split = resolveUsableInput({ contextWindow: 200_000, maxOutputTokens: 8_000, inputLimit: 150_000 });
    expect(split.rule).toBe("input_minus_reserved");
    expect(split.reserved).toBe(8_000);
    expect(split.usable).toBe(142_000);
    expect(split.usable + split.reserved).toBe(150_000);
  });

  test("the withheld capacity is capped so a large output allowance cannot starve input", () => {
    const split = resolveUsableInput({ contextWindow: 400_000, maxOutputTokens: 100_000, inputLimit: 300_000 });
    expect(split.reserved).toBe(COMPACTION_BUFFER);
    expect(split.usable).toBe(280_000);

    // A configured reservation wins, and can never widen capacity past the limit.
    const configured = resolveUsableInput(
      { contextWindow: 400_000, maxOutputTokens: 100_000, inputLimit: 300_000 },
      50_000,
    );
    expect(configured.reserved).toBe(50_000);
    expect(configured.usable).toBe(250_000);
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
    // No declared input limit: the window minus this model's output allowance is
    // what input may use, so the answer keeps 32k of room.
    expect(budget.usableRule).toBe("context_minus_output");
    expect(budget.reservedOutput).toBe(32_000);
    expect(budget.usableInput).toBe(96_000);
    expect(budget.usableInput).toBeLessThan(128_000);
    expect(budget.usableInput + budget.reservedOutput).toBeLessThanOrEqual(128_000);
  });

  test("a declared input limit withholds only the capped reserve, not the whole output allowance", () => {
    const catalog = catalogWith({
      id: "acme/split",
      providerId: "acme",
      apiModelId: "split",
      contextWindow: 400_000,
      maxOutputTokens: 100_000,
      limits: { input: 300_000 },
    });
    const budget = computeContextBudget({ messages: [{ role: "user", content: "hi" }], model: "acme/split", catalog });
    expect(budget.reservedOutput).toBe(COMPACTION_BUFFER);
    expect(budget.reservedOutput).toBeLessThan(100_000);
    expect(budget.usableInput).toBe(280_000);
    expect(budget.usableInput + budget.reservedOutput).toBe(300_000);
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

  test("the compaction trigger is the usable capacity itself", () => {
    const budget = computeContextBudget({ messages: [{ role: "user", content: "x" }], model: "openai/gpt-4o" });
    // gpt-4o declares 128k window and 4096 output, so usable is 123,904.
    expect(budget.usableInput).toBe(123_904);
    expect(budget.usableRule).toBe("context_minus_output");
    expect(budget.threshold).toBe(budget.usableInput);
    expect(budget.overThreshold).toBe(false);
    expect(budget.overflow).toBe(false);
    // usedInput is the whole request, and that is what the trigger compares.
    expect(budget.usedInput).toBe(budget.reservedSystem + budget.reservedTools + budget.estimatedInput);
  });

  test("a model that declares an input limit gets a smaller, per-model trigger", () => {
    const catalog = catalogWith({
      id: "acme/split",
      providerId: "acme",
      apiModelId: "split",
      contextWindow: 200_000,
      maxOutputTokens: 8_000,
      limits: { input: 150_000 },
    });
    const budget = computeContextBudget({ messages: [{ role: "user", content: "x" }], model: "acme/split", catalog });
    expect(budget.usableRule).toBe("input_minus_reserved");
    expect(budget.usableInput).toBe(142_000);
    expect(budget.usableInput).toBeLessThan(budget.contextWindow);
    expect(budget.overThreshold).toBe(false);
  });

  test("the trigger compares the WHOLE request against usable capacity", () => {
    const catalog = catalogWith({
      id: "acme/tiny",
      providerId: "acme",
      apiModelId: "tiny",
      contextWindow: 4_000,
      maxOutputTokens: 1_000,
      limits: { input: 3_000 },
    });

    const small = computeContextBudget({ messages: [{ role: "user", content: "hi" }], model: "acme/tiny", catalog });
    expect(small.usableInput).toBe(2_000);
    expect(small.overThreshold).toBe(false);
    expect(small.overflow).toBe(false);

    const large = computeContextBudget({
      messages: [{ role: "user", content: "word ".repeat(4_000) }],
      model: "acme/tiny",
      catalog,
    });
    expect(large.usedInput).toBeGreaterThan(large.usableInput);
    expect(large.overThreshold).toBe(true);
    expect(large.overflow).toBe(true);

    // Tool schemas count towards the request, so they can push it over on their
    // own even when the transcript is small.
    const withTools = computeContextBudget({
      messages: [{ role: "user", content: "word ".repeat(1_200) }],
      model: "acme/tiny",
      catalog,
      tools: [{ name: "read_file", description: "read a file", parameters: { type: "object" } }],
    });
    expect(withTools.usedInput).toBe(withTools.reservedSystem + withTools.reservedTools + withTools.estimatedInput);
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
