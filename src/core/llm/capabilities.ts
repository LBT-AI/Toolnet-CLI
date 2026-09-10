/**
 * Phase 73.7 — Model Capability Normalization
 *
 * Replaces ambiguous booleans with an explicit toolCalling mode:
 *
 *   native     → provider emits real function/tool calls
 *   structured → model emits JSON action blocks (parsed by the adapter)
 *   none       → model cannot use tools; never expose tool schemas
 *
 * The core never guesses capability from model-id substrings. When metadata is
 * absent the resolver is conservative: assume the model CAN follow a structured
 * protocol (so it may still drive real execution) but never claim native calls.
 */

import type {
  ModelCapabilities,
  ToolCallingMode,
} from "../contracts";

export interface CapabilityMetadata {
  reasoning?: boolean;
  reasoningStream?: boolean;
  reasoningEffort?: boolean;
  streaming?: boolean;
  vision?: boolean;
  tools?: boolean;
  nativeToolCalls?: boolean;
  /** Explicit mode wins over derived booleans. */
  toolCalling?: ToolCallingMode;
}

export function resolveToolCalling(meta: CapabilityMetadata): ToolCallingMode {
  if (meta.toolCalling) return meta.toolCalling;

  if (meta.tools === false) return "none";
  if (meta.nativeToolCalls === true) return "native";
  if (meta.nativeToolCalls === false) return "structured";

  // Unknown: be conservative — allow structured protocol, never assume native.
  return "structured";
}

export function normalizeCapabilities(
  meta: CapabilityMetadata
): ModelCapabilities {
  const reasoning = Boolean(meta.reasoning);
  return {
    reasoning,
    reasoningStream: meta.reasoningStream ?? reasoning,
    reasoningEffort: Boolean(meta.reasoningEffort),
    streaming: meta.streaming ?? true,
    vision: Boolean(meta.vision),
    toolCalling: resolveToolCalling(meta),
  };
}

/**
 * Backward-compat: derive a ToolCallingMode from the legacy provider fields
 * used by existing providers (tools/nativeToolCalls).
 */
export function toolCallingFromLegacy(
  tools: boolean | undefined,
  nativeToolCalls: boolean | undefined
): ToolCallingMode {
  if (tools === false) return "none";
  if (nativeToolCalls === false) return "structured";
  if (nativeToolCalls === true) return "native";
  return "structured";
}

/**
 * Whether tool schemas may be handed to a model with this capability.
 */
export function shouldExposeTools(mode: ToolCallingMode): boolean {
  return mode !== "none";
}