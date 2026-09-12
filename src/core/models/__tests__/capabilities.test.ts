import { describe, expect, it } from "bun:test";
import {
  mergeCapabilities,
  missingCapabilities,
  normalizeCapabilities,
  toLegacyCapabilities,
} from "../capabilities";

describe("Phase 79 — capability normalization", () => {
  it("keeps undeclared capabilities unknown (never guesses true)", () => {
    expect(normalizeCapabilities({})).toEqual({});
    expect(normalizeCapabilities(undefined)).toEqual({});
    expect(normalizeCapabilities(null)).toEqual({});
    expect(normalizeCapabilities({ someUnknownField: true })).toEqual({});
  });

  it("preserves tools and nativeToolCalls — the historical loss this phase fixes", () => {
    const caps = normalizeCapabilities({ tools: true, nativeToolCalls: true });
    expect(caps.tools).toBe(true);
    expect(caps.nativeToolCalls).toBe(true);

    const disabled = normalizeCapabilities({ tools: false, nativeToolCalls: false });
    expect(disabled.tools).toBe(false);
    expect(disabled.nativeToolCalls).toBe(false);
  });

  it("keeps tools=true with nativeToolCalls=false as structured-only", () => {
    const caps = normalizeCapabilities({ tools: true, nativeToolCalls: false });
    expect(caps.tools).toBe(true);
    expect(caps.nativeToolCalls).toBe(false);
  });

  it("never promotes a missing tool capability from another field", () => {
    // A model with reasoning declared but no tool metadata stays unknown.
    const caps = normalizeCapabilities({ reasoning: true });
    expect(caps.tools).toBeUndefined();
    expect(caps.nativeToolCalls).toBeUndefined();
  });

  it("derives tools from an explicit nativeToolCalls=true declaration only", () => {
    expect(normalizeCapabilities({ nativeToolCalls: true }).tools).toBe(true);
    // ... and the reverse: tools=false implies no native calls.
    expect(normalizeCapabilities({ tools: false }).nativeToolCalls).toBe(false);
  });

  it("maps documented aliases without guessing", () => {
    const caps = normalizeCapabilities({
      supports_vision: true,
      structured_output: true,
      json_mode: true,
      embeddings: true,
      image_generation: true,
      streaming: true,
    });
    expect(caps.vision).toBe(true);
    expect(caps.structuredOutput).toBe(true);
    expect(caps.jsonMode).toBe(true);
    expect(caps.embeddings).toBe(true);
    expect(caps.imageGeneration).toBe(true);
    expect(caps.streaming).toBe(true);
  });

  it("reads OpenRouter supported_parameters", () => {
    const caps = normalizeCapabilities({
      supported_parameters: ["tools", "tool_choice", "reasoning", "response_format", "structured_outputs"],
    });
    expect(caps.tools).toBe(true);
    expect(caps.nativeToolCalls).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.jsonMode).toBe(true);
    expect(caps.structuredOutput).toBe(true);
    // Not declared → still unknown.
    expect(caps.vision).toBeUndefined();
  });

  it("merges layers with explicit values winning", () => {
    const merged = mergeCapabilities(
      { streaming: true, tools: true },
      { tools: false },
      undefined,
    );
    expect(merged.streaming).toBe(true);
    expect(merged.tools).toBe(false);
  });

  it("lists missing requirements without inventing them", () => {
    expect(missingCapabilities({ tools: true }, { tools: true, reasoning: true })).toEqual(["reasoning"]);
    expect(missingCapabilities({ tools: undefined }, { tools: true })).toEqual(["tools"]);
    expect(missingCapabilities({ tools: true }, undefined)).toEqual([]);
  });

  it("bridges to the legacy adapter shape without dropping tools", () => {
    const legacy = toLegacyCapabilities({ reasoning: true, vision: true, tools: true, nativeToolCalls: false, streaming: true });
    expect(legacy.reasoning).toBe(true);
    expect(legacy.tools).toBe(true);
    expect(legacy.nativeToolCalls).toBe(false);
    expect(legacy.streaming).toBe(true);

    const unknown = toLegacyCapabilities({});
    expect(unknown.tools).toBeUndefined();
    expect(unknown.nativeToolCalls).toBeUndefined();
  });
});
