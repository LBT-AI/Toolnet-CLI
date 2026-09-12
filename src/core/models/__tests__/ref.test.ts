import { describe, expect, it } from "bun:test";
import { formatModelRef, isQualified, parseModelRef, tryParseModelRef } from "../ref";
import { InvalidModelReferenceError } from "../errors";

const KNOWN = ["openrouter", "toolnet", "openai"];

describe("Phase 79 — model reference parser", () => {
  it("parses provider/model without splitting on the model's own slashes", () => {
    const ref = parseModelRef("openrouter/anthropic/claude-sonnet", { knownProviders: KNOWN });
    expect(ref.providerId).toBe("openrouter");
    // NOT "anthropic" — that is the whole point of the parser.
    expect(ref.modelId).toBe("anthropic/claude-sonnet");
  });

  it("parses a simple provider/model pair", () => {
    const ref = parseModelRef("toolnet/gpt-x", { knownProviders: KNOWN });
    expect(ref.providerId).toBe("toolnet");
    expect(ref.modelId).toBe("gpt-x");
  });

  it("treats an unknown first segment as part of the model id", () => {
    const ref = parseModelRef("anthropic/claude-3-5-sonnet", { knownProviders: KNOWN });
    expect(ref.providerId).toBeUndefined();
    expect(ref.modelId).toBe("anthropic/claude-3-5-sonnet");
  });

  it("leaves a bare model id unqualified", () => {
    const ref = parseModelRef("gpt-4o", { knownProviders: KNOWN });
    expect(ref.providerId).toBeUndefined();
    expect(ref.modelId).toBe("gpt-4o");
  });

  it("applies the default provider to an unqualified reference", () => {
    const ref = parseModelRef("gpt-4o", { knownProviders: KNOWN, defaultProvider: "openai" });
    expect(ref.providerId).toBe("openai");
    expect(ref.modelId).toBe("gpt-4o");
  });

  it("matches provider ids case-insensitively and lowercases the qualifier", () => {
    const ref = parseModelRef("OpenRouter/anthropic/claude", { knownProviders: KNOWN });
    expect(ref.providerId).toBe("openrouter");
    expect(ref.modelId).toBe("anthropic/claude");
  });

  it("rejects malformed references", () => {
    const malformed = ["", "   ", "/", "openrouter/", "/model", "a//b", "openrouter/ /x", "two words"];
    for (const input of malformed) {
      expect(() => parseModelRef(input, { knownProviders: KNOWN })).toThrow(InvalidModelReferenceError);
    }
  });

  it("throws a structured invalid-reference error carrying the code", () => {
    const result = tryParseModelRef("", { knownProviders: KNOWN });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_MODEL_REFERENCE");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("reports qualification and formats canonical ids", () => {
    expect(isQualified(parseModelRef("toolnet/x", { knownProviders: KNOWN }))).toBe(true);
    expect(isQualified(parseModelRef("x", { knownProviders: KNOWN }))).toBe(false);
    expect(formatModelRef("OpenRouter", "anthropic/claude")).toBe("openrouter/anthropic/claude");
  });
});
