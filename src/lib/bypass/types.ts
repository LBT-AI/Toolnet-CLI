/**
 * Bypass mode types — ONE mode, honest semantics.
 *
 * Bypass NEVER changes what the runtime permits. Sandbox mode, SecurityEngine,
 * the harness permission scope and interactive approvals all stay exactly as
 * they are. What bypass changes is the MODEL'S DISPOSITION:
 *
 *   - fewer spurious refusals on legitimate engineering requests;
 *   - direct technical answers without lecturing or disclaimers;
 *   - full, working implementations instead of placeholder sketches.
 *
 * What it explicitly does NOT do:
 *   - no "clearance level" / "root admin" roleplay (false to the user and the
 *     model — ToolNet has no authority to lift a provider's usage policy);
 *   - no automatic escalation with forged system messages;
 *   - no weakening of any permission gate, ever.
 */

/** One bypass mode. `off` is the absence of the mode. */
export type BypassMode = "off" | "on";

export const ALL_BYPASS_MODES: BypassMode[] = ["off", "on"];

export interface BypassConfig {
  enabled: boolean;
  /** Retried once, honestly, when a spurious refusal is detected. */
  autoRetry: boolean;
  /**
   * Optional user-supplied addition to the cooperative directive (their own
   * emphasis). It is advice to the model, never a permission grant.
   */
  customPrompt?: string;
}

export type BypassContext = BypassConfig;

export interface RefusalCheckResult {
  isRefusal: boolean;
  reason?: string;
  matchedPattern?: string;
}

export interface BypassTurnResult {
  promptInjected: string;
  systemPromptInjected: string;
}
