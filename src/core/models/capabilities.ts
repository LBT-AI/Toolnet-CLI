/**
 * Phase 79 §5 — Capability normalization.
 *
 * One direction only: provider metadata → canonical `ModelCapabilities`.
 *
 * Two rules that this module exists to enforce:
 *
 *  1. TRI-STATE IS PRESERVED. A field the provider omits stays `undefined`
 *     ("unknown"), it is never promoted to `true`. The historical bug this
 *     guards against is dropping / fabricating `tools` and `nativeToolCalls`,
 *     which makes a model that cannot call tools look capable and produces
 *     fabricated "I ran the command" answers.
 *
 *  2. Only DOCUMENTED provider fields are read. Aliases below are real field
 *     names published by providers (OpenAI-compatible payloads, OpenRouter's
 *     `supported_parameters`, gateway capability objects). Nothing is inferred
 *     from a model id substring.
 */

import { CAPABILITY_KEYS, type CapabilityKey, type ModelCapabilities } from "./types";

/** Read a boolean only when the provider actually said so. */
function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Read `source[key]` as a boolean, falling back through aliases. */
function aliasBool(source: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const direct = bool(source[key]);
    if (direct !== undefined) return direct;
  }
  return undefined;
}

/** True when `value` is an array of strings containing `needle`. */
function listHas(value: unknown, needle: string): boolean | undefined {
  if (!Array.isArray(value)) return undefined;
  const lowered = value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.toLowerCase());
  if (lowered.length === 0) return undefined;
  return lowered.includes(needle);
}

/** True when `value` mentions any of `needles`. */
function listHasAny(value: unknown, needles: string[]): boolean | undefined {
  for (const needle of needles) {
    const hit = listHas(value, needle);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Alias table: canonical key → provider field names that explicitly declare it.
 * These are declaration surfaces, not heuristics.
 */
const ALIASES: Record<CapabilityKey, string[]> = {
  tools: ["tools", "function_calling", "functionCalling", "functions", "tool_use", "toolUse"],
  nativeToolCalls: ["nativeToolCalls", "native_tool_calls", "parallel_tool_calls", "tool_choice", "toolChoice"],
  streaming: ["streaming", "stream", "supports_streaming"],
  reasoning: ["reasoning", "thinking", "include_reasoning", "reasoning_content"],
  vision: ["vision", "supports_vision", "multimodal", "image_input", "imageInput"],
  structuredOutput: ["structuredOutput", "structured_output", "structured_outputs", "response_schema"],
  jsonMode: ["jsonMode", "json_mode", "response_format", "json_object"],
  embeddings: ["embeddings", "embedding", "embeddings_only"],
  imageGeneration: ["imageGeneration", "image_generation", "image_output"],
};

/**
 * Normalize arbitrary provider metadata into the canonical capability shape.
 * Unknown fields → `undefined`.
 */
export function normalizeCapabilities(raw: unknown): ModelCapabilities {
  if (!raw || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;
  const supported = source.supported_parameters ?? source.supportedParameters;

  const caps: ModelCapabilities = {};

  for (const key of CAPABILITY_KEYS) {
    let value = aliasBool(source, ALIASES[key]);

    // OpenRouter publishes capability declarations in `supported_parameters`.
    if (value === undefined && supported !== undefined) {
      if (key === "tools" || key === "nativeToolCalls") value = listHas(supported, "tools");
      else if (key === "reasoning") value = listHasAny(supported, ["reasoning", "include_reasoning"]);
      else if (key === "structuredOutput") value = listHas(supported, "structured_outputs");
      else if (key === "jsonMode") value = listHas(supported, "response_format");
    }

    if (value !== undefined) caps[key] = value;
  }

  // Derived (never fabricated): a model that emits native tool calls also
  // accepts tool schemas. Only applied when `tools` itself was not declared.
  if (caps.tools === undefined && caps.nativeToolCalls === true) {
    caps.tools = true;
  }
  // A model explicitly unable to accept tool schemas cannot emit native calls.
  if (caps.nativeToolCalls === undefined && caps.tools === false) {
    caps.nativeToolCalls = false;
  }

  return caps;
}

/**
 * Merge capability layers with explicit values winning.
 * Later layers only override when they hold a *declared* value.
 */
export function mergeCapabilities(...layers: Array<ModelCapabilities | undefined>): ModelCapabilities {
  const merged: ModelCapabilities = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const key of CAPABILITY_KEYS) {
      if (layer[key] !== undefined) merged[key] = layer[key];
    }
  }
  return merged;
}

/** Capability keys present-and-not-true, for error messages. */
export function missingCapabilities(
  caps: ModelCapabilities,
  required: Partial<ModelCapabilities> | undefined,
): string[] {
  if (!required) return [];
  const missing: string[] = [];
  for (const key of CAPABILITY_KEYS) {
    if (required[key] === true && caps[key] !== true) missing.push(key);
  }
  return missing;
}

/** Bridge to the Phase 73 legacy shape used by the adapter/reasoning cache. */
export function toLegacyCapabilities(caps: ModelCapabilities): {
  reasoning: boolean;
  reasoningStream: boolean;
  reasoningEffort: boolean;
  streaming: boolean;
  vision: boolean;
  tools?: boolean;
  nativeToolCalls?: boolean;
} {
  const reasoning = caps.reasoning === true;
  return {
    reasoning,
    reasoningStream: reasoning,
    reasoningEffort: false,
    streaming: caps.streaming === true,
    vision: caps.vision === true,
    ...(caps.tools !== undefined ? { tools: caps.tools } : {}),
    ...(caps.nativeToolCalls !== undefined ? { nativeToolCalls: caps.nativeToolCalls } : {}),
  };
}
