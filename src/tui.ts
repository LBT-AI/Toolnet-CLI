#!/usr/bin/env bun
/**
 * ToolNet CLI — TUI Entry Point (Modularized in P4)
 *
 * This module is a pure UI surface: it renders and collects input. It does NOT
 * execute tools — tool routing lives exclusively in the shared Agent Engine
 * (src/core/agent/agentEngine.ts), which owns the AgentHarness loop.
 *
 * Phase 73.11 removed the historical `executeToolBatch` re-export so a UI module
 * can never be mistaken for an execution path.
 */

export { main, getInputState, setInputState, resetInputState } from "./tui/app";
export { handleKey, handlePaste } from "./tui/input/inputHandler";
export { requestApprovalModal } from "./tui/permissions/permissionModal";
