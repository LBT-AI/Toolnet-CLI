/**
 * Agent Loop — §1  Lifecycle wrapper around AgentHarness.
 *
 * The AgentHarness owns the execution logic (executeLoop). AgentLoop is the
 * lightweight lifecycle manager: start/stop, event framing, abort propagation.
 */

import { AgentHarness } from "./agentHarness";
import type { ExecutionOptions } from "./types";

export class AgentLoop {
  private harness: AgentHarness;
  private isRunning: boolean = false;

  constructor(harness: AgentHarness) {
    this.harness = harness;
  }

  async start(options: ExecutionOptions = {}): Promise<void> {
    if (this.isRunning) {
      throw new Error("Agent loop is already running");
    }

    this.isRunning = true;
    const mode = options.mode || "HEADLESS";
    this.harness.emitEvent("loop:start", mode);

    try {
      await this.harness.execute(options);
    } catch (error) {
      this.harness.emitEvent("loop:error", mode, { error });
      throw error;
    } finally {
      this.isRunning = false;
      this.harness.emitEvent("loop:end", mode);
    }
  }

  stop(): void {
    this.isRunning = false;
    this.harness.cancel();
  }
}
