/**
 * Phase 75 — Scoped Subagents
 *
 * Public surface of the subagent subsystem. Import from here rather than deep
 * paths so the module can be reorganised without touching every consumer.
 *
 *   registry        → the ONE agent registry (built-in + custom)
 *   permissions     → parent ∩ agent ∩ requested, never escalating
 *   sessions        → child sessions (isolation + resume)
 *   manager         → the ONLY way a child run is created
 *   taskTool        → the canonical `task` tool implementation
 */

export * from "./types";
export * from "./permissions";
export * from "./prompt";
export * from "./registry";
export * from "./sessions";
export * from "./manager";
export * from "./taskTool";
