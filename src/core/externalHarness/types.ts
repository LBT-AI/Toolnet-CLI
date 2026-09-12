/**
 * Phase 83 §2 — Canonical external harness types.
 *
 * An external harness is an INDEPENDENT EXECUTABLE (OpenCode, Codex, …). It is
 * not a ToolNet agent loop, and ToolNet's permission engine does NOT govern the
 * tools an external harness runs inside its own process. Every definition is
 * therefore explicit about trust (§6) and about what ToolNet actually knows
 * (tri-state capabilities — §2: never assume support).
 *
 * This module is POLICY AND CONTRACT ONLY: no process spawning, no provider
 * calls, no ToolGateway, no ModelRouter imports.
 */

import type { ModelCapabilities } from "../models/types";

/** Tri-state capability: true (verified), false (verified absent), unknown (not verified). */
export type TriState = true | false | "unknown";

/** §6 — who governs what the harness executes. */
export type ExecutionTrust = "external_managed" | "toolnet_managed";

/** §2 — what ToolNet has verified (or not) about an external harness. */
export interface ExternalHarnessCapabilities {
  /** Machine-readable structured output (JSON events / JSONL). */
  structuredOutput: TriState;
  /** Streaming event output while running. */
  streaming: TriState;
  /** `--model`-style override of the harness' own model selection. */
  modelOverride: TriState;
  /** Express a provider as well as a model id. */
  providerOverride: TriState;
  /** Resume a previous external session by id. */
  sessionResume: TriState;
  /** Fork a session before continuing. */
  sessionFork: TriState;
  /** Run in an explicit working directory. */
  workingDirectory: TriState;
  /** Accept the prompt on stdin instead of argv. */
  stdinPrompt: TriState;
  /** Attach files to the prompt. */
  fileAttachments: TriState;
  /** Non-interactive single-shot execution (no TUI). */
  nonInteractive: TriState;
  /** Abort a run mid-flight (SIGINT/SIGTERM handling). */
  abort: TriState;
  /** The harness enforces its own permission/approval system. */
  nativePermissions: TriState;
}

/** §7 — normalized events. Not every harness emits every event. */
export type HarnessEventKind =
  | "started"
  | "output"
  | "reasoning"
  | "tool_started"
  | "tool_completed"
  | "file_changed"
  | "usage"
  | "completed"
  | "failed"
  | "cancelled";

export interface HarnessEvent {
  kind: HarnessEventKind;
  /** Adapter-assigned, when the harness reports one. */
  sessionId?: string;
  /** Final/assistant text (kind=output), reasoning text (kind=reasoning). */
  text?: string;
  /** Tool/command name for tool events. */
  tool?: string;
  /** Command argv/string as the harness reported it (already secret-redacted). */
  command?: string;
  /** Exit code of a harness-internal command. */
  exitCode?: number;
  /** File path for file_changed. */
  path?: string;
  /** add/update/delete for file_changed. */
  change?: "add" | "update" | "delete";
  /** Normalized token usage (kind=usage). Unknown fields omitted. */
  usage?: NormalizedUsage;
  /** True when this event terminates the run with a failure. */
  terminalFailure?: boolean;
  /** True when this event terminates the run with success. */
  terminalSuccess?: boolean;
  /** Secret-redacted raw event for debuggability. */
  raw?: unknown;
}

export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
}

/** §8 — normalized terminal statuses. */
export type HarnessStatus = "SUCCESS" | "PARTIAL" | "FAILED" | "CANCELLED" | "TIMEOUT";

/** Failure classes for external runs (§29 classification, harness subset). */
export type HarnessFailureClass =
  | "CORE_RUNTIME"
  | "HARNESS_PROTOCOL"
  | "HARNESS_UNAVAILABLE"
  | "TIMEOUT"
  | "CANCELLED"
  | "ENVIRONMENT";

/** §13 — a model selection resolved by the ModelRouter, handed to the adapter. */
export interface ExternalModelSelection {
  /** Logical model (provider-native id or canonical `provider/model`). */
  logicalModel: string;
  provider?: string;
  /** Provider-native model id to pass to the harness, when it differs. */
  apiModelId?: string;
}

/** §15 — namespaced external session identity. */
export interface ExternalHarnessSession {
  harnessId: string;
  externalSessionId: string;
}

/** §8 — normalized execution result. */
export interface ExternalHarnessResult {
  harnessId: string;
  harnessVersion?: string;
  status: HarnessStatus;
  finalText?: string;
  exitCode?: number;
  /** Namespaced: `external:<harnessId>:<id>` — never a native session id. */
  sessionId?: string;
  durationMs: number;
  usage?: NormalizedUsage;
  /** Model the harness was asked to use (when an override was requested). */
  model?: string;
  provider?: string;
  events: HarnessEvent[];
  failureClass?: HarnessFailureClass;
  /** Secret-redacted stderr tail, when the harness wrote any. */
  stderr?: string;
  /** Structured-output integrity signal: prose arrived where JSON was expected. */
  protocolWarning?: string;
  metadata: {
    argv: string[];
    cwd: string;
    truncated: boolean;
    /** Detection-time version string, when known. */
    detectedVersion?: string;
  };
}

/** Invocation the adapter builds; the runner only adds process mechanics. */
export interface HarnessInvocation {
  argv: string[];
  /** Non-secret operational env vars, from the adapter's declared allowlist. */
  env?: Record<string, string>;
  /** Feed the prompt via stdin instead of argv (capability: stdinPrompt). */
  stdin?: string;
}

/** Context handed to the adapter for one execution. */
export interface HarnessRunContext {
  prompt: string;
  cwd: string;
  /** Detection-time version, when known. */
  version?: string;
  model?: ExternalModelSelection;
  /** §15 — resume/fork a previously captured external session. */
  resume?: ExternalHarnessSession;
  forkSession?: boolean;
  /** Extra harness-native args, forwarded verbatim as argv elements. */
  extraArgs?: string[];
  signal?: AbortSignal;
}

/** §2 — the adapter contract. Harness-specific behavior lives ONLY here. */
export interface ExternalHarnessDefinition {
  id: string;
  displayName: string;
  /** Executable name resolved on PATH (never a shell string). */
  executable: string;
  capabilities: ExternalHarnessCapabilities;
  /** §6 — all Phase 83 adapters are `external_managed`. */
  executionTrust: ExecutionTrust;
  /**
   * §14 — env var names the runner MAY pass through if present in the parent
   * environment. Operational vars only; secret-looking names are rejected by
   * the runner regardless of this list. Values are never logged.
   */
  envAllowlist: string[];
  /**
   * §12 — verify availability. Bounded, offline, side-effect-free; may be
   * cached by the registry. Returns the version string when determinable.
   */
  detect: () => Promise<{ available: boolean; version?: string; detail?: string }>;
  /** Build the argv/env for one run. Never shells out. */
  buildInvocation: (context: HarnessRunContext) => HarnessInvocation;
  /** Parse one line/chunk of harness stdout into zero or more events. */
  parseEvent: (chunk: string) => HarnessEvent[];
  /** True when the chunk completes a JSONL/JSON-event frame. */
  isFrameComplete?: (buffer: string) => boolean;
  /**
   * §8 — terminal verdict from STRUCTURED events + process outcome. Exit code
   * alone must not produce SUCCESS when a terminal event reported failure.
   */
  normalizeResult: (input: {
    events: HarnessEvent[];
    exitCode: number | null;
    killed: boolean;
    timedOut: boolean;
    stderrTail?: string;
    protocolWarning?: string;
  }) => { status: HarnessStatus; failureClass?: HarnessFailureClass };
}

/** Maps a failed external run to its failure class. */
export function defaultFailureClassification(input: {
  killed: boolean;
  timedOut: boolean;
  exitCode: number | null;
}): HarnessFailureClass {
  if (input.timedOut) return "TIMEOUT";
  if (input.killed) return "CANCELLED";
  if (input.exitCode === null) return "HARNESS_PROTOCOL";
  return "HARNESS_PROTOCOL";
}

/** Capability view for diagnostics (CLI/TUI). */
export interface HarnessCapabilityView {
  structuredOutput: boolean;
  modelOverride: boolean;
  sessionResume: boolean;
  nonInteractive: boolean;
}

/** Only verified-true counts as supported for diagnostics/UX. */
export function supports(capability: TriState): boolean {
  return capability === true;
}

/** Re-exported for adapter typing convenience. */
export type { ModelCapabilities };
