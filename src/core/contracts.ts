/**
 * Unified Contracts
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

  /**
   * Structured file mutations produced by this tool (write/edit/replace/patch).
   * The tool layer already knows before/after, so it emits this ONCE here and
   * the TUI renders diffs from it — never from assistant prose. Absent for
   * non-mutating tools.
   */
  fileMutations?: FileMutation[];
}

// ── File Mutations (structured diff payload) ────────────────────────────────

/** What happened to the file, independent of how it is presented. */
export type FileMutationOperation = "create" | "update" | "delete";

/** One unified-diff line: added, deleted, or unchanged context. */
export type FileMutationLineKind = "add" | "del" | "context";

export interface FileMutationLine {
  kind: FileMutationLineKind;
  text: string;
  /** 1-based pre-image line number (absent for pure additions). */
  oldLine?: number;
  /** 1-based post-image line number (absent for pure deletions). */
  newLine?: number;
}

/** One changed region, with the unified-diff header ranges. */
export interface FileMutationHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: FileMutationLine[];
}

/**
 * The one structured shape the TUI renders a file change from. Designed to map
 * directly onto a future `FileMutationPart` without translating ANSI text.
 */
export interface FileMutation {
  path: string;
  operation: FileMutationOperation;
  additions: number;
  deletions: number;
  hunks: FileMutationHunk[];
  /** Reserved for renames: the previous path, when the tool reported one. */
  fromPath?: string;
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
  | { type: "reasoning-start"; id?: string; turn?: number; timestamp?: number; sessionId?: string; runId?: string }
  | { type: "reasoning-delta"; text: string; turn?: number; timestamp?: number; sessionId?: string; runId?: string }
  | { type: "reasoning-end"; id?: string; durationMs?: number; turn?: number; timestamp?: number; sessionId?: string; runId?: string }
  | { type: "tool-input-start"; callId: string; name: string }
  | { type: "tool-input-delta"; callId: string; delta: string }
  | { type: "tool-call"; callId: string; name: string; input: unknown }
  | { type: "permission-required"; callId: string; resource: string }
  | { type: "tool-running"; callId: string }
  | {
      type: "tool-progress";
      callId: string;
      name?: string;
      elapsedMs?: number;
      tail?: string[];
      stdoutDelta?: string;
      stderrDelta?: string;
      command?: string;
      timestamp?: number;
    }
  | { type: "tool-result"; callId: string; result: ToolResult }
  | { type: "tool-error"; callId: string; error: string }
  | { type: "verification-start"; callId: string }
  | { type: "verification-result"; callId: string; ok: boolean }
  | { type: "text-delta"; text: string }
  | { type: "notification"; text: string; jobId?: string }
  | { type: "step-finish" }
  | { type: "agent-complete" }
  | { type: "cancelled" }
  | { type: "error"; error: string }
 // ── background job lifecycle. UIs render these; they never
  // drive the scheduler. `parentSessionId` lets a front-end filter to its own
  // session without knowing the job internals.
  | { type: "background-job-started"; jobId: string; jobType: string; title: string; parentSessionId: string }
  | { type: "background-job-queued"; jobId: string; jobType: string; title: string; parentSessionId: string }
  | { type: "background-job-progress"; jobId: string; progress?: unknown }
  | {
      type: "background-job-completed";
      jobId: string;
      parentSessionId: string;
      childSessionId?: string;
      result?: unknown;
    }
  | { type: "background-job-error"; jobId: string; error: string; errorKind?: string }
  | { type: "background-job-cancelled"; jobId: string; reason?: string };

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
  /** Tool executions performed during the run (from verified tool results). */
  toolCalls?: number;
  /** Full post-run transcript (assistant turns + tool results). */
  messages?: AgentMessage[];
  error?: string;
 /** evidence-derived outcome (never "the model said it finished"). */
  verdict?: "SUCCESS" | "PARTIAL" | "FAILED" | "CANCELLED" | "TIMEOUT";
 /** which harness profile policy produced this run. */
  harnessId?: string;
  harnessVersion?: string;
 /** every unmet requirement behind a non-SUCCESS verdict. */
  completionReasons?: string[];
 /** observed side effects (files, commands, denials). */
  executionEvidence?: import("./harness/evidence").ExecutionEvidence;
  /** The run stopped for a user/security decision rather than task completion. */
  approvalRequired?: boolean;
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