#!/usr/bin/env bun
/**
 * ToolNet CLI — TUI Entry Point (Modularized in P4)
 *
 * Dispatches tool calls through the P1 pipeline:
 * import { executeToolBatch } from "./lib/harness/toolExecutor";
 * executeToolBatch(toolCalls, options);
 * requestApprovalModal(reason, args);
 */

export { main, getInputState, setInputState, resetInputState } from "./tui/app";
export { handleKey } from "./tui/input/inputHandler";
export { requestApprovalModal } from "./tui/permissions/permissionModal";
export { executeToolBatch } from "./lib/harness/toolExecutor";
