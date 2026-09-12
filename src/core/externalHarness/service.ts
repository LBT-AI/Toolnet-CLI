/**
 * Phase 83 §16 — HarnessExecutionService: THE dispatch owner.
 *
 * One entry point that can execute a task on the NATIVE ToolNet harness or on
 * an EXTERNAL harness. Dispatch only:
 *
 *   native   → the existing AgentHarness (untouched — no loop lives here)
 *   external → ExternalHarnessRunner (independent executables)
 *
 * It contains no model routing policy (native routing stays inside the
 * AgentHarness; external model selection is resolved by the ModelRouter
 * beforehand), no tool execution, and no harness-specific if/else chains.
 * The native AgentHarness loop is NOT moved into this service.
 *
 * §6 trust boundary: external execution is `external_managed` — ToolNet never
 * claims its permission system protected an external harness's tools, and a
 * normal ToolNet task is never silently auto-routed to an external binary.
 */

import { externalHarnessRunner, ExternalHarnessRunner, namespacedSession } from "./runner";
import { ExternalHarnessRegistry, externalHarnessRegistry } from "./registry";
import { HarnessCapabilityError, HarnessNotFoundError, HarnessUnavailableError } from "./errors";
import type { ExternalHarnessResult, ExternalModelSelection } from "./types";

export type ExecutionTarget = "native" | string; // string form: "external:<harnessId>" or bare harness id

export interface ExecutionRequest {
  target: ExecutionTarget;
  prompt: string;
  cwd?: string;
  /** Optional pre-resolved model selection (external runs). */
  model?: ExternalModelSelection;
  resume?: { harnessId: string; externalSessionId: string };
  forkSession?: boolean;
  extraArgs?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ExecutionOutcome {
  target: "native" | "external";
  harnessId: "toolnet" | string;
  /** Present for external runs — native runs return their own result shape. */
  external?: ExternalHarnessResult;
  /** Trust statement the CALLER must respect when describing the run. */
  executionTrust: "external_managed" | "toolnet_managed";
}

export interface HarnessExecutionServiceOptions {
  registry?: ExternalHarnessRegistry;
  runner?: ExternalHarnessRunner;
  /** Native executor hook — wired to the AgentHarness at the call site. */
  runNative?: (request: ExecutionRequest) => Promise<unknown>;
}

export class HarnessExecutionService {
  private readonly registry: ExternalHarnessRegistry;
  private readonly runner: ExternalHarnessRunner;
  private readonly runNative?: (request: ExecutionRequest) => Promise<unknown>;

  constructor(options: HarnessExecutionServiceOptions = {}) {
    this.registry = options.registry ?? externalHarnessRegistry;
    this.runner = options.runner ?? externalHarnessRunner;
    this.runNative = options.runNative;
  }

  /** Registered external harness ids (diagnostics/CLI/TUI). */
  externalIds(): string[] {
    return this.registry.ids();
  }

  /**
   * Normalize a target string into its dispatch decision. Native stays the
   * default; external targets must be explicit (`external:opencode`, `codex`
   * via the external CLI surface, etc.).
   */
  resolveTarget(target: ExecutionTarget): { kind: "native" } | { kind: "external"; harnessId: string } {
    const value = target.trim().toLowerCase();
    if (!value || value === "native" || value === "toolnet") return { kind: "native" };
    const bare = value.replace(/^external:/, "");
    if (this.registry.has(bare)) return { kind: "external", harnessId: bare };
    throw new HarnessNotFoundError(bare);
  }

  /**
   * Execute on the requested target.
   *
   * External path: verify availability, honor capability tri-states (no
   * silent downgrades — an unsupported resume/model request is a typed error,
   * never a quiet fallback to another behavior), then run.
   */
  async run(request: ExecutionRequest): Promise<ExecutionOutcome> {
    const target = this.resolveTarget(request.target);

    if (target.kind === "native") {
      if (!this.runNative) {
        throw new HarnessCapabilityError("toolnet", "native execution (no native executor wired)");
      }
      await this.runNative(request);
      return { target: "native", harnessId: "toolnet", executionTrust: "toolnet_managed" };
    }

    const definition = this.registry.resolve(target.harnessId);
    const detection = await this.registry.detect(definition.id);
    if (!detection.available) {
      throw new HarnessUnavailableError(definition.id, detection.detail);
    }

    // Capability gate — explicit errors instead of silent behavior changes.
    if (request.resume && definition.capabilities.sessionResume !== true) {
      throw new HarnessCapabilityError(definition.id, "session resume");
    }
    if (request.forkSession && definition.capabilities.sessionFork !== true) {
      throw new HarnessCapabilityError(definition.id, "session fork");
    }
    if (request.model && definition.capabilities.modelOverride !== true) {
      throw new HarnessCapabilityError(definition.id, "model override");
    }

    const result = await this.runner.run({
      harnessId: definition.id,
      prompt: request.prompt,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.resume ? { resume: request.resume } : {}),
      ...(request.forkSession !== undefined ? { forkSession: request.forkSession } : {}),
      ...(request.extraArgs ? { extraArgs: request.extraArgs } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    });

    return {
      target: "external",
      harnessId: definition.id,
      external: result,
      // §6 — always surfaced: ToolNet permissions do NOT govern this run.
      executionTrust: definition.executionTrust,
    };
  }

  /** Namespace a freshly observed external session id (§15). */
  captureSession(harnessId: string, result: ExternalHarnessResult): string | undefined {
    if (!result.sessionId) return undefined;
    const parsed = /^external:[^:]+:(.+)$/.exec(result.sessionId);
    return parsed ? namespacedSession(harnessId, parsed[1]) : undefined;
  }
}

/** Process-wide canonical service. */
export const harnessExecutionService = new HarnessExecutionService();
