/**
 * Phase 77.7/77.9 — Canonical Hook Registry
 *
 * One registry owns every hook. Execution is strictly SEQUENTIAL in
 * registration order (stable-sorted by priority), because hooks may mutate the
 * same payload and a `Promise.all` would make the resulting payload
 * non-deterministic. There is deliberately no parallelism here.
 *
 * Failure handling is per-registration:
 *   - observe hooks that throw degrade to a warning;
 *   - pre-execution (block-class) hooks fail CLOSED by default, so a broken
 *     security hook can never silently become a no-op.
 */

import {
  DEFAULT_FAILURE_POLICY,
  HOOK_CLASS,
  HOOK_TIMEOUT_MS,
  isHookName,
  type HookDecision,
  type HookFailurePolicy,
  type HookHandler,
  type HookName,
  type HookRegistration,
  type HookRunReport,
} from "./types";

/** Raised internally when a hook exceeds its timeout. */
class HookTimeoutError extends Error {
  constructor(name: HookName, owner: string, timeoutMs: number) {
    super(`hook '${name}' from '${owner}' timed out after ${timeoutMs}ms`);
    this.name = "HookTimeoutError";
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Race a promise against a timer without leaking the timer. `onTimeout` builds
 * the rejection so callers can shape the error.
 */
function withTimeout<T>(work: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs);
    // Do not keep the process alive purely for a hook timeout.
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isDecision(value: unknown): value is HookDecision {
  if (!value || typeof value !== "object") return false;
  const action = (value as { action?: unknown }).action;
  return action === "continue" || action === "deny" || action === "transform";
}

export interface HookRegistryOptions {
  /** Structured sink for hook failures/warnings. Defaults to a no-op. */
  onWarning?: (message: string, meta: Record<string, unknown>) => void;
}

export class HookRegistry {
  private readonly hooks: HookRegistration[] = [];
  private readonly options: HookRegistryOptions;
  private sequence = 0;
  private disposed = false;

  constructor(options: HookRegistryOptions = {}) {
    this.options = options;
  }

  /**
   * Register a hook. Unknown names are rejected loudly so a typo in a plugin
   * never becomes a silently dead integration.
   */
  register(registration: HookRegistration): void {
    if (this.disposed) throw new Error("HookRegistry is disposed");
    if (!isHookName(registration.name)) {
      throw new Error(`Unknown hook name: ${String(registration.name)}`);
    }
    if (typeof registration.handler !== "function") {
      throw new Error(`Hook '${registration.name}' handler must be a function`);
    }
    this.hooks.push({ ...registration });
  }

  /** All registrations, in execution order. */
  list(): HookRegistration[] {
    return [...this.hooks];
  }

  /** Registrations owned by a specific plugin/runtime. */
  listByOwner(owner: string): HookRegistration[] {
    return this.hooks.filter((h) => h.owner === owner);
  }

  /** True when at least one hook is registered for this lifecycle edge. */
  has(name: HookName): boolean {
    return this.hooks.some((h) => h.name === name);
  }

  /** Remove every hook owned by `owner`. Returns the number removed. */
  unregisterOwner(owner: string): number {
    let removed = 0;
    for (let i = this.hooks.length - 1; i >= 0; i--) {
      if (this.hooks[i].owner !== owner) continue;
      this.hooks.splice(i, 1);
      removed++;
    }
    return removed;
  }

  /**
   * Run every hook registered for `name`, in order.
   *
   * The returned report carries the final (possibly transformed) output — the
   * caller must use `report.output`, never its own local variable, or a
   * transform hook would be ignored.
   */
  async run<Input, Output>(
    name: HookName,
    input: Input,
    output: Output,
    metadata: { sessionId?: string; signal?: AbortSignal } = {},
  ): Promise<HookRunReport> {
    const report: HookRunReport = {
      name,
      invoked: 0,
      completed: [],
      failures: [],
      skipped: [],
      output,
    };

    const applicable = this.executionOrder(name);
    if (applicable.length === 0) return report;

    let current = output;
    for (const registration of applicable) {
      if (metadata.signal?.aborted) break;

      report.invoked++;
      this.sequence++;

      const timeoutMs = registration.timeoutMs ?? HOOK_TIMEOUT_MS;
      const invocation = {
        name,
        input,
        output: current,
        sequence: this.sequence,
        sessionId: metadata.sessionId,
        owner: registration.owner,
      };

      let decision: HookDecision | void;
      try {
        decision = await withTimeout(
          Promise.resolve(registration.handler(invocation)),
          timeoutMs,
          () => new HookTimeoutError(name, registration.owner, timeoutMs),
        );
      } catch (error) {
        const policy = this.policyFor(registration);
        report.failures.push({
          owner: registration.owner,
          policy,
          error: describeError(error),
        });
        if (policy !== "block") {
          this.warn(`hook '${name}' failed`, {
            owner: registration.owner,
            policy,
            error: describeError(error),
          });
          continue;
        }
        // Fail closed: a block-class hook that cannot run denies the operation.
        report.deniedBy = {
          owner: registration.owner,
          reason: `hook '${name}' failed: ${describeError(error)}`,
        };
        return report;
      }

      if (!isDecision(decision) || decision.action === "continue") {
        report.skipped.push(registration.owner);
        continue;
      }

      const hookClass = HOOK_CLASS[name];

      if (decision.action === "deny") {
        // Only block-class hooks may veto; transform/observe cannot.
        if (hookClass === "block") {
          report.deniedBy = { owner: registration.owner, reason: decision.reason };
          return report;
        }
        this.warn(`hook '${name}' returned deny but is not a blocking hook — ignored`, {
          owner: registration.owner,
          hookClass,
        });
        report.skipped.push(registration.owner);
        continue;
      }

      // decision.action === "transform"
      if (hookClass === "observe") {
        this.warn(`hook '${name}' returned transform but is observe-only — ignored`, {
          owner: registration.owner,
        });
        report.skipped.push(registration.owner);
        continue;
      }
      current = decision.args as typeof current;
      report.completed.push(registration.owner);
    }

    report.output = current;
    return report;
  }

  /** Drop every registration and mark the registry disposed (idempotent). */
  dispose(): void {
    this.hooks.length = 0;
    this.disposed = true;
  }

  /** Reset disposal state — test/CLI re-init support. */
  reset(): void {
    this.hooks.length = 0;
    this.disposed = false;
    this.sequence = 0;
  }

  /**
   * Stable ordering: priority ascending, then registration order. `Array.sort`
   * is stable in every supported runtime, so equal priorities keep load order —
   * exactly the determinism §77.7 requires.
   */
  private executionOrder(name: HookName): HookRegistration[] {
    return this.hooks
      .filter((h) => h.name === name)
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  }

  private policyFor(registration: HookRegistration): HookFailurePolicy {
    if (registration.failurePolicy) return registration.failurePolicy;
    return DEFAULT_FAILURE_POLICY[registration.name] ?? "warn";
  }

  private warn(message: string, meta: Record<string, unknown>): void {
    try {
      this.options.onWarning?.(message, meta);
    } catch {
      // A broken warning sink must never break hook execution.
    }
  }
}

/**
 * Process-wide registry. Plugins and the runtime share this instance so there
 * is exactly one hook table.
 */
export const hookRegistry = new HookRegistry();

/** Convenience: expose the handler type for plugin authors. */
export type { HookHandler };
