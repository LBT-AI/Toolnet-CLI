/**
 * Boundary Timing Instrumentation for Reasoning Streams
 *
 * Tracks timestamps across every stage of the reasoning pipeline:
 *   Provider (upstream chunk)
 *     ↓
 *   ModelAdapter (normalized reasoningDelta)
 *     ↓
 *   AgentHarness (agent:reasoning_chunk event)
 *     ↓
 *   AgentEngine (canonical reasoning-delta event)
 *     ↓
 *   TUI State (activeReasoningDraft append)
 *     ↓
 *   TUI Render (coalesced frame commit)
 *
 * Used to verify zero artificial buffering and identify where delays occur.
 */

export type ReasoningStage =
  | "provider"
  | "adapter"
  | "harness"
  | "engine"
  | "tui_draft"
  | "tui_render";

export interface ReasoningBoundaryRecord {
  stage: ReasoningStage;
  timestamp: number;
  chunkId?: string;
  deltaLength?: number;
  turnId?: number;
  sessionId?: string;
  runId?: string;
}

export interface ReasoningTraceSummary {
  totalDeltas: number;
  stages: Record<ReasoningStage, number>;
  averageLagMs: {
    adapterToHarness: number;
    harnessToEngine: number;
    engineToTui: number;
    tuiToRender: number;
  };
}

class ReasoningTracer {
  private records: ReasoningBoundaryRecord[] = [];
  private maxRecords = 500;

  record(stage: ReasoningStage, info: Omit<ReasoningBoundaryRecord, "stage" | "timestamp"> & { timestamp?: number }): void {
    const rec: ReasoningBoundaryRecord = {
      stage,
      timestamp: info.timestamp ?? Date.now(),
      chunkId: info.chunkId,
      deltaLength: info.deltaLength,
      turnId: info.turnId,
      sessionId: info.sessionId,
      runId: info.runId,
    };
    this.records.push(rec);
    if (this.records.length > this.maxRecords) {
      this.records.shift();
    }
  }

  getRecords(): readonly ReasoningBoundaryRecord[] {
    return this.records;
  }

  clear(): void {
    this.records = [];
  }

  getSummary(): ReasoningTraceSummary {
    const counts: Record<ReasoningStage, number> = {
      provider: 0,
      adapter: 0,
      harness: 0,
      engine: 0,
      tui_draft: 0,
      tui_render: 0,
    };
    for (const r of this.records) {
      counts[r.stage] = (counts[r.stage] || 0) + 1;
    }
    return {
      totalDeltas: counts.tui_draft,
      stages: counts,
      averageLagMs: {
        adapterToHarness: 0,
        harnessToEngine: 0,
        engineToTui: 0,
        tuiToRender: 0,
      },
    };
  }
}

export const reasoningTracer = new ReasoningTracer();
