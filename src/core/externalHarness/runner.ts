/**
 * Phase 83 §4 — THE ExternalHarnessRunner.
 *
 * Exactly one. Owns the process lifecycle for external harness execution:
 * resolve adapter → detect → build invocation → spawn → consume output →
 * normalize events → normalized result. It contains NO harness-specific
 * logic (that lives in adapters) and NO model-routing policy (routing happens
 * before the runner; the adapter receives an already-resolved selection).
 *
 * It never calls provider.chat, never executes ToolNet tools, never touches
 * ToolRegistry/Permission/ModelCatalog.
 */

import { ExternalHarnessRegistry, externalHarnessRegistry } from "./registry";
import { normalizeCwd, safeSpawn, spawnErrorOf } from "./process";
import {
  HarnessCancelledError,
  HarnessProtocolError,
  HarnessTimeoutError,
  HarnessUnavailableError,
} from "./errors";
import { redactSecret } from "../models/errors";
import type { ExternalHarnessDefinition, ExternalHarnessResult, HarnessEvent } from "./types";
import { defaultFailureClassification } from "./types";

export interface ExternalRunRequest {
  harnessId: string;
  prompt: string;
  /** Explicit cwd; validated before spawn. Defaults to process.cwd(). */
  cwd?: string;
  model?: { logicalModel: string; provider?: string; apiModelId?: string };
  resume?: { harnessId: string; externalSessionId: string };
  forkSession?: boolean;
  extraArgs?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Registry override for tests. */
  registry?: ExternalHarnessRegistry;
}

/** Default bounded timeout — explicit per request when the caller knows better. */
export const DEFAULT_EXTERNAL_TIMEOUT_MS = 10 * 60_000;

export class ExternalHarnessRunner {
  constructor(private readonly registry: ExternalHarnessRegistry = externalHarnessRegistry) {}

  /** Detect without running (bounded, cached). Structured result, never throws. */
  async detect(harnessId: string, options: { force?: boolean } = {}) {
    return this.registry.detect(harnessId, options);
  }

  /**
   * Execute one external harness run and normalize the result.
   * Deterministic error mapping; no shell, no secrets in errors.
   */
  async run(request: ExternalRunRequest): Promise<ExternalHarnessResult> {
    const definition = this.registry.resolve(request.harnessId);
    const detection = await this.registry.detect(definition.id);
    if (!detection.available) {
      throw new HarnessUnavailableError(definition.id, detection.detail);
    }

    const cwd = normalizeCwd(request.cwd ?? process.cwd());

    if (request.resume) {
      this.assertSameHarness(definition, request.resume.harnessId);
    }

    const context = {
      prompt: request.prompt,
      cwd,
      ...(detection.version !== undefined ? { version: detection.version } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.resume ? { resume: request.resume } : {}),
      ...(request.forkSession !== undefined ? { forkSession: request.forkSession } : {}),
      ...(request.extraArgs ? { extraArgs: request.extraArgs } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    };
    const invocation = definition.buildInvocation(context);

    const timeoutMs = request.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS;
    const outcome = await safeSpawn({
      executable: definition.executable,
      args: invocation.argv,
      cwd,
      envAllowlist: definition.envAllowlist,
      ...(invocation.env ? { env: invocation.env } : {}),
      ...(invocation.stdin !== undefined ? { stdin: invocation.stdin } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      timeoutMs,
    });

    const spawnError = spawnErrorOf(definition.id, outcome);
    if (spawnError) throw spawnError;

    // Parse stdout into normalized events (line-buffered for JSONL protocols).
    // Provider error payloads embed credential material (masked keys, request
    // ids, raw response bodies) — every string field is redacted at this
    // boundary so events/results/debug metadata can never leak a secret.
    const parsed = parseAll(definition, outcome.stdout);
    const events = parsed.map(redactEvent);

    const verdict = definition.normalizeResult({
      events,
      exitCode: outcome.exitCode,
      killed: outcome.killed,
      timedOut: outcome.timedOut,
      ...(outcome.stderrTail ? { stderrTail: redactSecret(outcome.stderrTail) } : {}),
    });

    const lastSession = [...events].reverse().find((event) => event.sessionId)?.sessionId;
    const usageEvent = [...events].reverse().find((event) => event.usage)?.usage;
    const finalTextEvent = [...events].reverse().find((event) => event.kind === "output" && event.text)?.text;
    const failureClass =
      verdict.failureClass ??
      (outcome.timedOut
        ? "TIMEOUT"
        : outcome.killed
          ? "CANCELLED"
          : defaultFailureClassification({
              killed: outcome.killed,
              timedOut: outcome.timedOut,
              exitCode: outcome.exitCode,
            }));

    const result: ExternalHarnessResult = {
      harnessId: definition.id,
      ...(detection.version !== undefined ? { harnessVersion: detection.version } : {}),
      status: verdict.status,
      ...(finalTextEvent !== undefined ? { finalText: finalTextEvent } : {}),
      ...(outcome.exitCode !== null ? { exitCode: outcome.exitCode } : {}),
      ...(lastSession ? { sessionId: namespacedSession(definition.id, lastSession) } : {}),
      durationMs: outcome.durationMs,
      ...(usageEvent ? { usage: usageEvent } : {}),
      ...(request.model ? { model: request.model.apiModelId ?? request.model.logicalModel } : {}),
      ...(request.model?.provider ? { provider: request.model.provider } : {}),
      events,
      ...(failureClass ? { failureClass } : {}),
      ...(outcome.stderrTail ? { stderr: redactSecret(outcome.stderrTail).slice(-2000) } : {}),
      ...(outcome.truncated ? { protocolWarning: "stdout truncated" } : {}),
      metadata: {
        argv: invocation.argv,
        cwd,
        truncated: outcome.truncated,
        ...(detection.version !== undefined ? { detectedVersion: detection.version } : {}),
      },
    };

    return result;
  }

  /** §15 — resume must target the same harness it came from. */
  assertSameHarness(definition: ExternalHarnessDefinition, resumeHarnessId: string): void {
    if (definition.id !== resumeHarnessId.trim().toLowerCase().replace(/^external:/, "")) {
      throw new HarnessProtocolError(
        definition.id,
        `session '${resumeHarnessId}' belongs to a different harness — cross-harness resume is not permitted`,
      );
    }
  }

  /** Throw the canonical cancellation error when the caller aborted. */
  assertNotAborted(harnessId: string, signal?: AbortSignal): void {
    if (signal?.aborted) throw new HarnessCancelledError(harnessId);
  }

  /** Bounded-timeout helper for callers that want the typed error. */
  timeoutError(harnessId: string, timeoutMs: number): HarnessTimeoutError {
    return new HarnessTimeoutError(harnessId, timeoutMs);
  }
}

/** Namespaced external session identity (§15). */
export function namespacedSession(harnessId: string, externalSessionId: string): string {
  return `external:${harnessId}:${externalSessionId}`;
}

/** Secret-free string fields for one parsed event (raw included). */
function redactEvent(event: HarnessEvent): HarnessEvent {
  const clean: HarnessEvent = {
    ...event,
    ...(event.text !== undefined ? { text: redactSecret(event.text) } : {}),
    ...(event.command !== undefined ? { command: redactSecret(event.command) } : {}),
    ...(event.raw !== undefined ? { raw: redactSecret(JSON.stringify(event.raw)) } : {}),
  };
  return clean;
}

/** Strip the namespace; returns null when the id is not external. */
export function parseNamespacedSession(sessionId: string): { harnessId: string; externalSessionId: string } | null {
  const match = /^external:([a-z0-9-]+):(.+)$/i.exec(sessionId.trim());
  if (!match) return null;
  return { harnessId: match[1], externalSessionId: match[2] };
}

/**
 * Parse the full stdout of a harness via its adapter. Line-buffered: a
 * partial trailing JSON line is kept, but never fabricated into an event.
 */
export function parseAll(definition: ExternalHarnessDefinition, stdout: string): HarnessEvent[] {
  const events: HarnessEvent[] = [];
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(...definition.parseEvent(trimmed));
    } catch {
      // A malformed line is evidence (protocol warning), never a crash.
    }
  }
  return events;
}

/** Process-wide canonical runner. */
export const externalHarnessRunner = new ExternalHarnessRunner();
