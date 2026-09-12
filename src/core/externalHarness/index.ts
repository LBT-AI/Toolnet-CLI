/**
 * Phase 83 — External harness interoperability (barrel).
 *
 * Import from here. The external harness layer is an INTEROPERABILITY
 * boundary: external harnesses are independent executables, not ToolNet
 * agent loops. Nothing in this layer imports ToolGateway, Permission, or
 * provider adapters (architecture-guarded).
 */

export * from "./types";
export * from "./errors";
export {
  ExternalHarnessRegistry,
  externalHarnessRegistry,
  HARNESS_DETECT_TTL_MS,
  isSupported,
  type HarnessDetectionState,
  type HarnessStatusView,
} from "./registry";
export {
  ExternalHarnessRunner,
  externalHarnessRunner,
  namespacedSession,
  parseNamespacedSession,
  parseAll,
  DEFAULT_EXTERNAL_TIMEOUT_MS,
  type ExternalRunRequest,
} from "./runner";
export {
  HarnessExecutionService,
  harnessExecutionService,
  type ExecutionTarget,
  type ExecutionRequest,
  type ExecutionOutcome,
  type HarnessExecutionServiceOptions,
} from "./service";
export {
  createOpenCodeAdapter,
  createCodexAdapter,
  createClaudeAdapter,
  createHermesAdapter,
  registerBuiltinAdapters,
} from "./adapters";
export { MAX_STREAM_BYTES, normalizeCwd, safeSpawn, harnessChildEnv } from "./process";

import { externalHarnessRegistry } from "./registry";
import { registerBuiltinAdapters } from "./adapters";

let bootstrapped = false;

/** Idempotently register the built-in adapters (OpenCode, Codex, Claude, Hermes). */
export function ensureExternalHarnessesRegistered(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  try {
    registerBuiltinAdapters(externalHarnessRegistry);
  } catch {
    // A duplicate registration would mean double bootstrap — keep the first.
  }
}

ensureExternalHarnessesRegistered();
