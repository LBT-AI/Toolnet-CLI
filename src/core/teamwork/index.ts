/**
 * Phase 76B — Teamwork DAG
 *
 * A plan is data; the engine schedules it as BackgroundJobs whose work is
 * scoped subagent runs on the shared Agent Engine. There is no separate
 * teamwork runtime.
 */

export * from "./types";
export * from "./validation";
export * from "./engine";
export * from "./tool";
