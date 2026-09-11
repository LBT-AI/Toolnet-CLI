/**
 * Phase 74 — LSP / Code Intelligence public API.
 */

export * from "./types";
export { LANGUAGE_BY_EXTENSION, detectLanguageId, extensionOf } from "./languages";
export {
  LSP_SERVERS,
  findServerRoot,
  pickProbeFile,
  resolveServerBinary,
  selectServerForFile,
} from "./servers";
export { LspMessageReader, encodeLspMessage, createStdioTransport, createMemoryTransportPair, spawnStdioServer } from "./transport";
export { LspClient } from "./client";
export {
  getLspManager,
  managerForContext,
  shutdownLspManagers,
  resetLspManagers,
  setLspManagerForTesting,
  LspManager,
} from "./manager";
export {
  formatDiagnostic,
  formatDiagnosticsReport,
  countBySeverity,
  normalizeDiagnostics,
  severityName,
} from "./diagnostics";
export { LSP_TOOL_PARAMETERS, runLspOperation } from "./tool";
export type { LspToolInput } from "./tool";
