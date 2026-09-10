/**
 * Reasoning / thinking capability handling for ToolNet CLI.
 *
 * Capability-aware: the provider API's model metadata is the source of truth.
 * No model-id substring guessing, no fabricated thinking for models that do
 * not reason.
 */

import type { ModelCapabilities } from "../providers/types";
import type { ChatRequest } from "../providers/types";

export type ReasoningEffort = "low" | "medium" | "high";

export interface ReasoningSettings {
  /** Master switch — `/reasoning off` disables even supported models. */
  enabled: boolean;
  /** "auto" lets the adapter choose; low/medium/high are explicit. */
  effort: ReasoningEffort | "auto";
}

export const DEFAULT_REASONING_SETTINGS: ReasoningSettings = {
  enabled: true,
  effort: "auto",
};

/** Agent lifecycle phases surfaced in the TUI. */
export type AgentPhase =
  | "idle"
  | "thinking"
  | "working"
  | "streaming"
  | "done"
  | "cancelled"
  | "error";

// ---------------------------------------------------------------------------
// Capability cache — populated by provider.listModels() results.
// ---------------------------------------------------------------------------

const capabilityCache: Record<string, ModelCapabilities> = {};

/** Index provider model metadata so the TUI can look capabilities up by id. */
export function setModelCapabilities(models: Array<{ id: string; capabilities?: ModelCapabilities }>): void {
  for (const m of models) {
    if (m.capabilities) capabilityCache[m.id] = m.capabilities;
  }
}

export function getModelCapabilities(modelId: string): ModelCapabilities | undefined {
  return capabilityCache[modelId];
}

export function supportsReasoning(modelId: string): boolean {
  return Boolean(capabilityCache[modelId]?.reasoning);
}

export function supportsReasoningEffort(modelId: string): boolean {
  return Boolean(capabilityCache[modelId]?.reasoningEffort);
}

// ---------------------------------------------------------------------------
// Request builder — guard-clause chain, never sends params unsupported by the
// model. Provider-specific translation lives inside each adapter.
// ---------------------------------------------------------------------------

export function applyReasoningOptions(
  request: ChatRequest,
  modelId: string,
  settings: ReasoningSettings
): ChatRequest {
  const caps = capabilityCache[modelId];
  if (!caps?.reasoning) return request;
  if (!settings.enabled) return request;
  if (!caps.reasoningEffort) return request;
  if (settings.effort === "auto") return request;
  return { ...request, reasoningEffort: settings.effort };
}

/** Human label for the effort in status lines ("high", "auto", "off"...). */
export function reasoningEffortLabel(settings: ReasoningSettings): string {
  if (!settings.enabled) return "off";
  return settings.effort;
}