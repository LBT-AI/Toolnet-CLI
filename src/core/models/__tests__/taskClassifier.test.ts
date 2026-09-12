import { describe, expect, it } from "bun:test";
import {
  LONG_CONTEXT_THRESHOLD,
  classificationToRoutingRequest,
  classifyTask,
} from "../taskClassifier";

describe("Phase 80 — TaskClassifier", () => {
  it("classifies a fix-and-test prompt as coding with debugging and tool use", () => {
    const result = classifyTask({ prompt: "fix TypeScript error and run tests" });

    expect(result.primaryType).toBe("coding");
    expect(result.secondaryTypes).toContain("debugging");
    expect(result.secondaryTypes).toContain("tool_heavy");
    expect(result.requiredCapabilities.tools).toBe(true);
    expect(result.preferredCapabilities.reasoning).toBe(true);
    expect(result.profile).toBe("coding");
  });

  it("requires tools for an editing task", () => {
    const result = classifyTask({ prompt: "refactor the auth module and update its unit test" });
    expect(result.primaryType).toBe("coding");
    expect(result.requiredCapabilities.tools).toBe(true);
  });

  it("classifies an analysis prompt as reasoning and requires reasoning capability", () => {
    const result = classifyTask({ prompt: "Prove that this algorithm's complexity is logarithmic and analyze the trade-offs" });
    expect(result.primaryType).toBe("reasoning");
    expect(result.requiredCapabilities.reasoning).toBe(true);
    expect(result.profile).toBe("reasoning");
  });

  it("requires vision when an image attachment is present", () => {
    const result = classifyTask({
      prompt: "What does this show?",
      attachments: [{ mimeType: "image/png" }],
    });
    expect(result.primaryType).toBe("vision");
    expect(result.requiredCapabilities.vision).toBe(true);
    expect(result.profile).toBe("quality");
  });

  it("treats a large context size as long-context", () => {
    const result = classifyTask({
      prompt: "Summarise the meeting notes",
      contextSize: LONG_CONTEXT_THRESHOLD + 1,
    });
    expect(result.primaryType).toBe("long_context");
    expect(result.profile).toBe("long-context");
  });

  it("treats many requested tools as tool-heavy", () => {
    const result = classifyTask({
      prompt: "Do the work",
      requestedTools: ["read_file", "write_file", "bash", "grep"],
    });
    expect(result.primaryType).toBe("tool_heavy");
    expect(result.profile).toBe("tool-heavy");
  });

  it("maps background execution to the cheap profile", () => {
    const result = classifyTask({ prompt: "run the scheduled job", executionMode: "background" });
    expect(result.primaryType).toBe("background");
    expect(result.profile).toBe("cheap");
  });

  it("falls back to general for an empty prompt without crashing", () => {
    const result = classifyTask({ prompt: "" });
    expect(result.primaryType).toBe("general");
    expect(result.profile).toBe("auto");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("never derives a task type from a model name", () => {
    // Mentioning a model id must not change classification: routing is
    // capability-driven, and the classifier must not encode a model preference.
    const baseline = classifyTask({ prompt: "summarise this text" });
    const withModelName = classifyTask({ prompt: "summarise this text using claude-sonnet or gpt-4o" });
    expect(withModelName.primaryType).toBe(baseline.primaryType);
    expect(withModelName.profile).toBe(baseline.profile);
  });

  it("is deterministic across repeated calls", () => {
    const prompt = "Debug the failing TypeScript test and run the build";
    const first = classifyTask({ prompt });
    for (let i = 0; i < 5; i++) {
      expect(classifyTask({ prompt })).toEqual(first);
    }
  });

  it("reports confidence inside the documented bounds", () => {
    const result = classifyTask({ prompt: "fix this bug" });
    expect(result.confidence).toBeGreaterThanOrEqual(0.3);
    expect(result.confidence).toBeLessThanOrEqual(0.95);
  });

  it("converts a classification into routing request fields", () => {
    const request = classificationToRoutingRequest(
      classifyTask({ prompt: "refactor the module and run the tests" }),
    );
    expect(request.taskType).toBe("coding");
    expect(request.profile).toBe("coding");
    expect(request.requiredCapabilities.tools).toBe(true);
  });
});
