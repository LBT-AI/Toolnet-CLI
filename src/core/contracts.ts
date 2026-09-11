/**
 * Phase 73.1 — Unified Contracts
 *
 * Single source of truth for every cross-cutting type in the agent core.
 * The TUI, Simple REPL, headless runner, harness, providers and tools all
 * speak these shapes — nothing else. Provider-specific fields exist only
 * inside protocol adapters (see core/llm/protocols).
 */

// ── Tool Result ─────────────────────────────────────────────────────────────

/**
 * Normalized result of one tool execution. Every tool returns this shape —
 * never a bespoke JSON blob. The model always receives the result bound to
 * its original tool_call_id.
 */
export interface ToolResult {
  ok: boolean;

  stdout?: string;
  stderr?: string;
  exitCode?: number;

  data?: unknown;

  truncated?: boolean;
  /** When output was truncated, the full output may be preserved here. */
  outputPath?: string;

  /** Verification outcome when the tool declared a verify() hook. */
  verification?: VerificationResult;

  metadata?: Record<string, unknown>;
}

export interface VerificationResult {
  ok: boolean;
  /** e.g. "file does not exist", "content unchanged" */
  reason?: string;
}

// ── Tool Call State ─────────────────────────────────────────────────────────

export type ToolCallStatus =
  | "pending"
  | "running"
  | "completed"
  | "error"
  | "cancelled";

export interface ToolCallState {
  callId: string;
  name: string;
  input: unknown;

  status: ToolCallStatus;

  startedAt?: number;
  endedAt?: number;

  output?: ToolResult;
  error?: string;

  permission?: PermissionDecision;
  verification?: VerificationResult;
}

export type PermissionDecision = "ALLOW" | "ASK" | "DENY";

// ── Agent Events ────────────────────────────────────────────────────────────

/**
 * The one event contract all UIs and integrations consume. Provider-specific
 * streaming deltas are translated into these events by the LLM protocol layer.
 */
export type AgentEvent =
  | { type: "agent-start"; sessionId: string }
  | { type: "thinking-start" }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-input-start"; callId: string; name: string }
  | { type: "tool-input-delta"; callId: string; delta: string }
  | { type: "tool-call"; callId: string; name: string; input: unknown }
  | { type: "permission-required"; callId: string; resource: string }
  | { type: "tool-running"; callId: string }
  | { type: "tool-result"; callId: string; result: ToolResult }
  | { type: "tool-error"; callId: string; error: string }
  | { type: "verification-start"; callId: string }
  | { type: "verification-result"; callId: string; ok: boolean }
  | { type: "text-delta"; text: string }
  | { type: "step-finish" }
  | { type: "agent-complete" }
  | { type: "cancelled" }
  | { type: "error"; error: string };

// ── Task Requirements / Completion Gate ─────────────────────────────────────

export interface TaskRequirement {
  mutationRequired: boolean;
  executionRequired: boolean;
  verificationRequired: boolean;
  testRequired: boolean;
}

export type CompletionDecision = "complete" | "continue";

/**
 * Live counters accumulated from VERIFIED tool results during a run.
 * A counter increments only after the tool returned ok AND (when present)
 * its verification passed — never from assistant prose.
 */
export interface CompletionEvidence {
  successfulMutations: number;
  successfulExecutions: number;
  verificationsPassed: number;
  testsPassed: number;
}

// ── Model Capabilities ──────────────────────────────────────────────────────

export type ToolCallingMode = "native" | "structured" | "none";

export interface ModelCapabilities {
  reasoning: boolean;
  reasoningStream: boolean;
  reasoningEffort: boolean;
  streaming: boolean;
  vision: boolean;
  /**
   * How this model performs tool use:
   *  - native:     provider emits real function/tool calls
   *  - structured: model emits JSON action blocks parsed by the adapter
   *  - none:       model cannot use tools at all — never hand it tool schemas
   */
  toolCalling: ToolCallingMode;
}// ── Result envelope ─────────────────────────────────────────────────────────

/**
 * Minimal transcript message shape the core guarantees. Structurally
 * compatible with the harness ContextMessage, so front-ends can persist the
 * returned transcript without depending on harness internals.
 */
export interface AgentMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
}

export interface AgentResult {
  success: boolean;
  output: string;
  /** Proven, verified mutations/executions — the basis for any success claim. */
  evidence: CompletionEvidence;
  sessionId?: string;
  turnsUsed?: number;
  tokensUsed?: number;
  durationMs?: number;
  /** Full post-run transcript (assistant turns + tool results). */
  messages?: AgentMessage[];
  error?: string;
}

// ── Guard: helpful builders ─────────────────────────────────────────────────

export function okToolResult(partial: Omit<ToolResult, "ok"> = {}): ToolResult {
  return { ok: true, ...partial };
}

export function errToolResult(
  error: string,
  partial: Omit<ToolResult, "ok" | "stderr"> = {}
): ToolResult {
  return { ok: false, stderr: error, exitCode: 1, ...partial };
}