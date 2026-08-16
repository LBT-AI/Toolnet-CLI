/**
 * Direct 1-agent Turbo Execution Engine for ToolNet Teamwork v2
 * Target File: cli/src/teamwork/turboExecutor.ts
 */

import { getHarness } from "../lib/harness";
import type { TurboExecutionResult, TurboExecutionOptions } from "./types";

/**
 * Direct 1-agent execution engine for tiny tasks.
 * Bypasses Smart Planner DAG generation and QA review rounds for minimal latency.
 */
export async function executeTurboTask(
  userPrompt: string,
  options: TurboExecutionOptions = {}
): Promise<TurboExecutionResult> {
  const startTime = Date.now();
  const sessionId = options.sessionId || `turbo-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const eventBus = options.eventBus;

  if (eventBus) {
    try {
      await eventBus.emit("SESSION_START", { sessionId, mode: "TURBO", prompt: userPrompt });
      await eventBus.emit("TURBO_EXECUTION_STARTED", { sessionId, maxIterations: options.maxIterations ?? 5 });
    } catch {}
  }

  const harness = getHarness({
    gatewayUrl: options.gatewayUrl,
    model: options.model || "default",
    sessionId,
  });

  const res = await harness.runTurbo(userPrompt, {
    gatewayUrl: options.gatewayUrl,
    model: options.model || "default",
    maxTurns: options.maxIterations ?? 5,
    timeoutMs: options.timeoutMs ?? 30000,
    sessionId,
  });

  const durationMs = Date.now() - startTime;

  if (res.success) {
    if (eventBus) {
      try {
        await eventBus.emit("TURBO_EXECUTION_COMPLETED", { sessionId, durationMs, tokensUsed: res.tokensUsed });
        await eventBus.emit("SESSION_END", { sessionId, status: "COMPLETED", durationMs });
      } catch {}
    }

    return {
      sessionId,
      success: true,
      output: res.output,
      toolCallsCount: res.toolCallsCount,
      tokensUsed: res.tokensUsed,
      durationMs,
    };
  } else {
    if (eventBus) {
      try {
        await eventBus.emit("TURBO_EXECUTION_FAILED", { sessionId, error: res.error, durationMs });
        await eventBus.emit("SESSION_END", { sessionId, status: "FAILED", error: res.error });
      } catch {}
    }

    return {
      sessionId,
      success: false,
      output: "",
      toolCallsCount: res.toolCallsCount,
      tokensUsed: res.tokensUsed,
      durationMs,
      error: res.error || "Turbo execution failed",
    };
  }
}
