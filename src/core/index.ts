/**
 * Phase 73 — Core layer public surface.
 *
 * Everything outside `src/core` imports from here (or from the specific
 * module) rather than reaching into internals. The core owns contracts, the
 * shared agent engine, the completion gate, tool-call state, and capability
 * normalization — the pieces that make model-independent execution possible.
 */

export * from "./contracts";
export * from "./agent/agentEngine";
export * from "./agent/completionGate";
export * from "./agent/toolCallState";
export * from "./llm/capabilities";
