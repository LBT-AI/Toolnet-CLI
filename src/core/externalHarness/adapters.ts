/**
 * Phase 83 §9/§10/§11 — Built-in external harness adapters.
 *
 * All harness-specific behavior lives here: invocation shape, event parsing,
 * terminal-verdict semantics. The runner contains none of it.
 *
 * Source-study notes (references actually read for this phase):
 *
 *  - Codex (`codex-rs/exec/src/exec_events.rs`): JSONL `ThreadEvent`s tagged
 *    `type`: thread.started, turn.started, turn.completed (usage),
 *    turn.failed (error), item.started/updated/completed (item types:
 *    agent_message, reasoning, command_execution, file_change, mcp_tool_call,
 *    error). Terminal semantics: turn.completed ⇒ success evidence,
 *    turn.failed / `error` ⇒ structured failure — exit code alone is never
 *    trusted (§8: exit 0 + structured failure must stay FAILED).
 *
 *  - OpenCode (`packages/opencode/src/cli/cmd/run.ts`): non-interactive
 *    `opencode run [message..]`, `--format json` (raw JSON events),
 *    `--model provider/model`, `--session <id>` / `--continue`, `--fork`,
 *    `--dir`. Model id format `providerID/modelID` where modelID may contain
 *    slashes — same parsing rule as ToolNet's ref parser (first segment is the
 *    provider only when it names one).
 *
 *  - Claude / Hermes (§11): conservative definitions. Only capabilities that
 *    can be verified from the installed CLI's `--help`/`--version` are marked
 *    true; everything else stays `false`/`unknown` and result parsing is
 *    text-only. No invented JSON schemas.
 *
 * Capabilities marked here are ADAPTER CLAIMS; `detect()` verifies binary
 * presence and version. Deeper verification happens per-run.
 */

import { execFile } from "node:child_process";
import type {
  ExternalHarnessDefinition,
  HarnessEvent,
  HarnessStatus,
  HarnessRunContext,
  HarnessInvocation,
} from "./types";

// ── Detection helper (bounded, offline, side-effect-free) ───────────────────

const DETECT_TIMEOUT_MS = 5_000;

/** Run `--version`-style detection with a hard timeout; never throws. */
function probeVersion(executable: string, args: string[]): Promise<{ available: boolean; version?: string; detail?: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(executable, args, { timeout: DETECT_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
        const text = `${stdout}${stderr}`.trim();
        if (error && !stdout) {
          const code = (error as NodeJS.ErrnoException).code;
          resolve({
            available: false,
            ...(code ? { detail: code === "ENOENT" ? "executable not found on PATH" : `probe failed: ${code}` } : { detail: text.slice(0, 200) }),
          });
          return;
        }
        const version = text.split(/\r?\n/)[0]?.slice(0, 80);
        resolve({ available: true, ...(version ? { version } : {}) });
      });
    } catch (error) {
      resolve({ available: false, detail: error instanceof Error ? error.message : String(error) });
    }
    child?.on("error", () => {
      /* handled in callback */
    });
  });
}

// ── Shared parsing helpers ──────────────────────────────────────────────────

/** Try to parse a JSON object; null when the line is not JSON. */
function tryParse(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{") && !line.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// ── OpenCode adapter (§9) ───────────────────────────────────────────────────

export function createOpenCodeAdapter(): ExternalHarnessDefinition {
  return {
    id: "opencode",
    displayName: "OpenCode",
    executable: "opencode",
    executionTrust: "external_managed",
    // §14 — operational env only. Deliberately NO credential-bearing names
    // (Phase 84 owns a safe credential profile mechanism); the runner's
    // secret deny-list would filter them anyway.
    envAllowlist: ["NO_COLOR", "CI"],
    capabilities: {
      structuredOutput: true,
      streaming: true,
      modelOverride: true,
      providerOverride: true,
      sessionResume: true,
      sessionFork: true,
      workingDirectory: true,
      stdinPrompt: true,
      fileAttachments: true,
      nonInteractive: true,
      abort: true,
      nativePermissions: "unknown",
    },

    async detect() {
      return probeVersion("opencode", ["--version"]);
    },

    buildInvocation(context: HarnessRunContext): HarnessInvocation {
      const argv = ["run", "--format", "json"];

      // Model override: OpenCode expects `provider/model` where the model id
      // may itself contain slashes. Compose from the resolved selection.
      if (context.model) {
        const ref = context.model.provider
          ? `${context.model.provider}/${context.model.apiModelId ?? context.model.logicalModel}`
          : context.model.apiModelId ?? context.model.logicalModel;
        argv.push("--model", ref);
      }

      // Session resume/fork (§15 — identity already validated by the runner).
      if (context.resume) {
        argv.push("--session", context.resume.externalSessionId);
        if (context.forkSession) argv.push("--fork");
      }

      // Prompt goes last as positional words — NEVER through a shell.
      argv.push(context.prompt);

      return { argv };
    },

    parseEvent(line: string): HarnessEvent[] {
      const json = tryParse(line);
      if (!json) return [];

      const type = str(json.type) ?? "";
      const events: HarnessEvent[] = [];
      // OpenCode attaches the session id to most events (top-level `sessionID`);
      // capture it wherever it appears so session identity survives even an
      // early failure. Verified live against opencode 1.18.30.
      const topLevelSession = str(json.sessionID ?? json.sessionId);

      switch (type) {
        // Verified against OpenCode's run --format json event surface; unknown
        // types are recorded as opaque output rather than fabricated.
        case "session.id": {
          const sessionId = str(json.sessionID ?? json.id);
          if (sessionId) events.push({ kind: "started", sessionId, raw: json });
          break;
        }
        case "error": {
          // Top-level error event (e.g. provider auth failure) — a structured
          // terminal failure. Found in live smoke: the harness exits 0 after
          // emitting this, so exit code alone would misclassify the run.
          const error = (json.error ?? {}) as Record<string, unknown>;
          const data = (error.data ?? {}) as Record<string, unknown>;
          events.push({
            kind: "failed",
            terminalFailure: true,
            ...(topLevelSession ? { sessionId: topLevelSession } : {}),
            text: str(data.message) ?? str(error.message) ?? str(json.message) ?? "opencode error",
            raw: json,
          });
          break;
        }
        case "message.part.updated": {
          const part = (json.part ?? {}) as Record<string, unknown>;
          const partType = str(part.type);
          if (partType === "text") {
            const text = str(part.text);
            if (text) events.push({ kind: "output", text, raw: json });
          } else if (partType === "reasoning") {
            const text = str(part.text);
            if (text) events.push({ kind: "reasoning", text, raw: json });
          } else if (partType === "tool") {
            const partState = part.state as Record<string, unknown> | undefined;
            const state = str(partState?.status);
            const toolName = str(part.tool);
            if (toolName) {
              events.push({
                kind: state === "completed" || state === "done" ? "tool_completed" : "tool_started",
                tool: toolName,
                raw: json,
              });
            }
          } else {
            events.push({ kind: "output", raw: json });
          }
          break;
        }
        case "session.idle":
        case "session.error": {
          const failed = type === "session.error";
          events.push({
            kind: failed ? "failed" : "completed",
            ...(failed ? { terminalFailure: true } : { terminalSuccess: true }),
            ...(topLevelSession ? { sessionId: topLevelSession } : {}),
            ...(failed ? { text: str(json.error) ?? "session error" } : {}),
            raw: json,
          });
          break;
        }
        default:
          // Unknown additive event: keep as debug evidence, do not invent semantics.
          events.push({ kind: "output", ...(topLevelSession ? { sessionId: topLevelSession } : {}), raw: json });
      }
      return events;
    },

    normalizeResult({ events, exitCode, killed, timedOut }) {
      const completed = events.some((event) => event.terminalSuccess);
      const failed = events.some((event) => event.terminalFailure);

      let status: HarnessStatus;
      if (timedOut) status = "TIMEOUT";
      else if (killed) status = "CANCELLED";
      else if (failed) status = "FAILED";
      else if (completed) status = "SUCCESS";
      else status = exitCode === 0 ? "PARTIAL" : "FAILED";

      return {
        status,
        ...(status === "FAILED" ? { failureClass: failed ? ("HARNESS_PROTOCOL" as const) : ("HARNESS_PROTOCOL" as const) } : {}),
      };
    },
  };
}

// ── Codex adapter (§10) ─────────────────────────────────────────────────────

export function createCodexAdapter(): ExternalHarnessDefinition {
  return {
    id: "codex",
    displayName: "Codex",
    executable: "codex",
    executionTrust: "external_managed",
    envAllowlist: ["NO_COLOR", "CI", "CODEX_HOME"],
    capabilities: {
      structuredOutput: true,
      streaming: true,
      modelOverride: true,
      providerOverride: false,
      sessionResume: true,
      sessionFork: false,
      workingDirectory: true,
      stdinPrompt: true,
      fileAttachments: false,
      nonInteractive: true,
      abort: true,
      nativePermissions: true,
    },

    async detect() {
      return probeVersion("codex", ["--version"]);
    },

    buildInvocation(context: HarnessRunContext): HarnessInvocation {
      const argv = ["exec", "--json"];

      if (context.model) {
        const modelRef = context.model.apiModelId ?? context.model.logicalModel;
        argv.push("--model", modelRef);
      }

      if (context.resume) {
        argv.push("resume", context.resume.externalSessionId);
      }

      // Codex `exec` reads the prompt from the remaining positional args;
      // `--` closes option parsing so a prompt that looks like a flag stays data.
      argv.push("--", context.prompt);

      return { argv };
    },

    parseEvent(line: string): HarnessEvent[] {
      const json = tryParse(line);
      if (!json) return [];

      const events: HarnessEvent[] = [];
      const type = str(json.type) ?? "";

      switch (type) {
        case "thread.started": {
          const threadId = str(json.thread_id);
          if (threadId) events.push({ kind: "started", sessionId: threadId, raw: json });
          break;
        }
        case "turn.started":
          break;
        case "turn.completed": {
          const usage = (json.usage ?? {}) as Record<string, unknown>;
          events.push({
            kind: "usage",
            terminalSuccess: true,
            usage: {
              ...(num(usage.input_tokens) !== undefined ? { inputTokens: num(usage.input_tokens) } : {}),
              ...(num(usage.output_tokens) !== undefined ? { outputTokens: num(usage.output_tokens) } : {}),
              ...(num(usage.reasoning_output_tokens) !== undefined
                ? { reasoningTokens: num(usage.reasoning_output_tokens) }
                : {}),
              ...(num(usage.cached_input_tokens) !== undefined
                ? { cachedInputTokens: num(usage.cached_input_tokens) }
                : {}),
            },
            raw: json,
          });
          break;
        }
        case "turn.failed":
        case "error": {
          const error = (json.error ?? {}) as Record<string, unknown>;
          events.push({
            kind: "failed",
            terminalFailure: true,
            text: str(error.message) ?? str(json.message) ?? "codex error",
            raw: json,
          });
          break;
        }
        case "item.completed":
        case "item.started":
        case "item.updated": {
          const item = (json.item ?? {}) as Record<string, unknown>;
          const itemType = str(item.type);
          const completed = type === "item.completed";

          if (itemType === "agent_message") {
            const text = str((item as Record<string, unknown>).text);
            if (completed && text) events.push({ kind: "output", text, raw: json });
          } else if (itemType === "reasoning") {
            const text = str((item as Record<string, unknown>).text);
            if (completed && text) events.push({ kind: "reasoning", text, raw: json });
          } else if (itemType === "command_execution") {
            events.push({
              kind: completed ? "tool_completed" : "tool_started",
              tool: "command",
              command: str((item as Record<string, unknown>).command),
              exitCode: num((item as Record<string, unknown>).exit_code),
              raw: json,
            });
          } else if (itemType === "file_change") {
            const changes = Array.isArray(item.changes) ? item.changes : [];
            for (const change of changes) {
              const entry = change as Record<string, unknown>;
              events.push({
                kind: "file_changed",
                path: str(entry.path),
                change: str(entry.kind) === "add" ? "add" : str(entry.kind) === "delete" ? "delete" : "update",
                raw: completed ? json : undefined,
              });
            }
          } else if (itemType === "mcp_tool_call") {
            events.push({
              kind: completed ? "tool_completed" : "tool_started",
              tool: str(item.tool) ?? "mcp",
              raw: json,
            });
          } else if (itemType === "error") {
            events.push({
              kind: "failed",
              ...(completed ? { terminalFailure: true } : {}),
              text: str(item.message) ?? "item error",
              raw: json,
            });
          } else {
            events.push({ kind: "output", raw: json });
          }
          break;
        }
        default:
          events.push({ kind: "output", raw: json });
      }
      return events;
    },

    normalizeResult({ events, exitCode, killed, timedOut }) {
      const completed = events.some((event) => event.terminalSuccess);
      const failed = events.some((event) => event.terminalFailure);

      let status: HarnessStatus;
      if (timedOut) status = "TIMEOUT";
      else if (killed) status = "CANCELLED";
      else if (failed) status = "FAILED";
      else if (completed) status = "SUCCESS";
      else status = exitCode === 0 ? "PARTIAL" : "FAILED";

      return {
        status,
        ...(status === "FAILED" ? { failureClass: "HARNESS_PROTOCOL" as const } : {}),
      };
    },
  };
}

// ── Conservative Claude adapter (§11) ───────────────────────────────────────

/**
 * Claude Code supports `-p` (print/non-interactive) and `--output-format json`
 * in practice, but §11 says: only what is verifiable from the installed CLI.
 * The adapter is conservative — structured output stays `unknown` until
 * verified, so the runner falls back to text-only parsing.
 */
export function createClaudeAdapter(): ExternalHarnessDefinition {
  return {
    id: "claude",
    displayName: "Claude Code",
    executable: "claude",
    executionTrust: "external_managed",
    envAllowlist: ["NO_COLOR", "CI"],
    capabilities: {
      structuredOutput: "unknown",
      streaming: "unknown",
      modelOverride: "unknown",
      providerOverride: false,
      sessionResume: "unknown",
      sessionFork: "unknown",
      workingDirectory: true,
      stdinPrompt: true,
      fileAttachments: "unknown",
      nonInteractive: true,
      abort: "unknown",
      nativePermissions: "unknown",
    },

    async detect() {
      return probeVersion("claude", ["--version"]);
    },

    buildInvocation(context: HarnessRunContext): HarnessInvocation {
      // Conservative non-interactive invocation: print mode + prompt. The
      // `--model` flag exists across Claude Code versions in the wild, but the
      // capability tri-state keeps this honest — the runner's capability gate
      // (modelOverride === true required) already blocks override requests
      // until this adapter's capability is upgraded to a verified `true`.
      const argv = ["-p", context.prompt];
      return { argv };
    },

    parseEvent(line: string): HarnessEvent[] {
      // Text protocol: the full stdout becomes the final output event.
      const text = line.trim();
      return text ? [{ kind: "output", text }] : [];
    },

    normalizeResult({ exitCode, killed, timedOut }) {
      let status: HarnessStatus;
      if (timedOut) status = "TIMEOUT";
      else if (killed) status = "CANCELLED";
      else status = exitCode === 0 ? "SUCCESS" : "FAILED";
      return {
        status,
        ...(status === "FAILED" ? { failureClass: "HARNESS_PROTOCOL" as const } : {}),
      };
    },
  };
}

// ── Conservative Hermes adapter (§11) ───────────────────────────────────────

export function createHermesAdapter(): ExternalHarnessDefinition {
  return {
    id: "hermes",
    displayName: "Hermes",
    executable: "hermes",
    executionTrust: "external_managed",
    envAllowlist: ["NO_COLOR", "CI"],
    capabilities: {
      structuredOutput: false,
      streaming: false,
      modelOverride: "unknown",
      providerOverride: false,
      sessionResume: false,
      sessionFork: false,
      workingDirectory: true,
      stdinPrompt: true,
      fileAttachments: false,
      nonInteractive: "unknown",
      abort: "unknown",
      nativePermissions: "unknown",
    },

    async detect() {
      return probeVersion("hermes", ["--version"]);
    },

    buildInvocation(context: HarnessRunContext): HarnessInvocation {
      return { argv: [context.prompt] };
    },

    parseEvent(line: string): HarnessEvent[] {
      const text = line.trim();
      return text ? [{ kind: "output", text }] : [];
    },

    normalizeResult({ exitCode, killed, timedOut }) {
      let status: HarnessStatus;
      if (timedOut) status = "TIMEOUT";
      else if (killed) status = "CANCELLED";
      else status = exitCode === 0 ? "SUCCESS" : "FAILED";
      return {
        status,
        ...(status === "FAILED" ? { failureClass: "HARNESS_PROTOCOL" as const } : {}),
      };
    },
  };
}

/** Register every built-in adapter on a registry. */
export function registerBuiltinAdapters(registry: {
  register: (definition: ExternalHarnessDefinition) => void;
}): void {
  registry.register(createOpenCodeAdapter());
  registry.register(createCodexAdapter());
  registry.register(createClaudeAdapter());
  registry.register(createHermesAdapter());
}
