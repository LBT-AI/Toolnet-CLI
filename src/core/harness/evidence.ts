/**
 * Phase 81 §12 — execution evidence.
 *
 * Evidence is DERIVED from the harness event stream, not from a parallel
 * bookkeeping system: the collector is just an observer on the existing bus, so
 * a front-end sees the same facts the verdict is computed from. Nothing here
 * writes files, spawns processes or touches the network.
 *
 * This module also owns the canonical tool classification (what counts as a
 * mutation / shell / read, and what command text looks like a test or a
 * verification run). The harness imports these instead of keeping private
 * copies, so "did the file actually change?" has exactly one answer.
 */

import type { PermissionDenialRecord } from "./context";

/** Tools whose success means the workspace changed. */
export const MUTATION_TOOLS = new Set([
  "write_file",
  "edit_file",
  "replace_all",
  "apply_patch",
  "create_artifact",
  "update_artifact",
]);

/** Tools that run a command. */
export const SHELL_TOOLS = new Set(["shell", "bash", "run_command"]);

/** Tools that only read. */
export const READ_TOOLS = new Set([
  "read_file",
  "view_file",
  "list_files",
  "glob",
  "grep",
  "search",
  "get_cwd",
]);

export function isMutationTool(name: string): boolean {
  return MUTATION_TOOLS.has(name);
}

export function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name);
}

export function isReadTool(name: string): boolean {
  return READ_TOOLS.has(name);
}

export function commandFromArgs(name: string, args: unknown): string {
  if (!isShellTool(name)) return "";
  const record = (args ?? {}) as Record<string, unknown>;
  return String(record.command ?? record.cmd ?? "");
}

export function looksLikeTestCommand(name: string, args: unknown): boolean {
  const command = commandFromArgs(name, args);
  return /\b(bun test|npm test|yarn test|pnpm test|pytest|jest|vitest|go test|cargo test|mvn test|dotnet test|gradlew test|rspec|phpunit)\b/i.test(
    command,
  );
}

export function looksLikeVerificationCommand(name: string, args: unknown): boolean {
  const command = commandFromArgs(name, args);
  return /\b(typecheck|tsc --noEmit|tsc -b|lint|build|go vet|ruff check|mypy|shellcheck)\b/i.test(
    command,
  );
}

/** File target named by a tool call, when the schema carries one. */
export function toolFileTarget(args: unknown): string | undefined {
  const record = (args ?? {}) as Record<string, unknown>;
  const target = record.path ?? record.file ?? record.filePath ?? record.filename;
  return typeof target === "string" && target ? target : undefined;
}

export interface ExecutionEvidence {
  filesRead: string[];
  filesChanged: string[];
  commandsRun: number;
  testsRun: number;
  toolCalls: number;
  failedToolCalls: number;
  permissionDenials: number;
  diagnostics: number;
  verificationResults: number;
  /** Turns observed from `agent:thinking` boundaries. */
  turns: number;
}

export function emptyExecutionEvidence(): ExecutionEvidence {
  return {
    filesRead: [],
    filesChanged: [],
    commandsRun: 0,
    testsRun: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    permissionDenials: 0,
    diagnostics: 0,
    verificationResults: 0,
    turns: 0,
  };
}

interface ObservableEvent {
  type: string;
  payload?: Record<string, unknown>;
}

/**
 * Interpret a normalized tool result. `ok: false`, a non-zero exit code, or a
 * `success: false` / `error` payload all mean the execution failed.
 */
function resultIndicatesFailure(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.ok === false || record.success === false) return true;
  if (typeof record.exitCode === "number" && record.exitCode !== 0) return true;
  return false;
}

function denialFromEvent(event: ObservableEvent): PermissionDenialRecord | null {
  const payload = event.payload ?? {};
  const reason = String(payload.reason ?? "");
  if (!reason) return null;
  if (!/denied|permission|not permitted|forbidden|approval/i.test(reason)) return null;
  return { toolName: String(payload.toolName ?? "tool"), reason };
}

/**
 * Observes harness events. Idempotent per event, and tolerant: an unknown event
 * type is ignored rather than throwing mid-run.
 */
export class ExecutionEvidenceCollector {
  private readonly evidence = emptyExecutionEvidence();
  private readonly denialRecords: PermissionDenialRecord[] = [];
  private readonly seenToolCallIds = new Set<string>();
  private readonly seenOutcomeIds = new Set<string>();

  observe(event: ObservableEvent): void {
    switch (event.type) {
      case "tool:start": {
        const id = String(event.payload?.id ?? "");
        // De-duplicate by call id: a retry that re-dispatches the same id must
        // not be counted as a second tool call.
        if (id && this.seenToolCallIds.has(id)) return;
        if (id) this.seenToolCallIds.add(id);
        this.recordToolStart(event);
        return;
      }
      case "tool:complete": {
        // A tool that ran and FAILED is still a failed tool call. The harness
        // emits `tool:complete` when the call was permitted, so an executor
        // error arrives here (as a non-zero exit code or `ok: false`) rather
        // than on `tool:error`.
        this.recordToolOutcome(event);
        this.recordFileChange(event, true);
        return;
      }
      case "tool:error": {
        this.evidence.failedToolCalls += 1;
        const denial = denialFromEvent(event);
        if (denial) {
          this.evidence.permissionDenials += 1;
          this.denialRecords.push(denial);
        }
        return;
      }
      case "agent:thinking":
        this.evidence.turns += 1;
        return;
      case "verification-result":
        this.evidence.verificationResults += 1;
        return;
      case "agent:diagnostics":
      case "lsp:diagnostics":
        this.evidence.diagnostics += 1;
        return;
      default:
        return;
    }
  }

  private recordToolStart(event: ObservableEvent): void {
    const payload = event.payload ?? {};
    const name = String(payload.toolName ?? "");
    this.evidence.toolCalls += 1;

    const target = toolFileTarget(payload.toolArgs);
    if (target && isReadTool(name) && !this.evidence.filesRead.includes(target)) {
      this.evidence.filesRead.push(target);
    }
    if (isShellTool(name)) {
      this.evidence.commandsRun += 1;
      if (looksLikeTestCommand(name, payload.toolArgs)) this.evidence.testsRun += 1;
    }
  }

  /** Count one execution failure per call id, whatever shape the result takes. */
  private recordToolOutcome(event: ObservableEvent): void {
    const payload = event.payload ?? {};
    const id = String(payload.id ?? "");
    if (id) {
      if (this.seenOutcomeIds.has(id)) return;
      this.seenOutcomeIds.add(id);
    }
    if (!resultIndicatesFailure(payload.result)) return;
    this.evidence.failedToolCalls += 1;
  }

  private recordFileChange(event: ObservableEvent, ok: boolean): void {
    if (!ok) return;
    const payload = event.payload ?? {};
    const name = String(payload.toolName ?? "");
    if (!isMutationTool(name)) return;
    const target = toolFileTarget(payload.toolArgs);
    if (target && !this.evidence.filesChanged.includes(target)) {
      this.evidence.filesChanged.push(target);
    }
  }

  snapshot(): ExecutionEvidence {
    return {
      ...this.evidence,
      filesRead: [...this.evidence.filesRead],
      filesChanged: [...this.evidence.filesChanged],
    };
  }

  /** Denials seen so far, for the context-retention guarantee. */
  denials(): PermissionDenialRecord[] {
    return [...this.denialRecords];
  }
}
