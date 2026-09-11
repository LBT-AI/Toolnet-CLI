/**
 * Phase 74 — Language identification.
 *
 * Maps a file extension to the LSP `languageId` used in `textDocument/didOpen`.
 * The table is intentionally a curated subset of the languages ToolNet detects
 * in projects; unknown extensions return `undefined` so callers can fall back
 * to grep/read_file instead of guessing.
 */

/** Extension (with leading dot) → LSP language identifier. */
export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".mtsx": "typescriptreact",
  ".ctsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".java": "java",
  ".php": "php",
  ".rb": "ruby",
  ".cs": "csharp",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".dart": "dart",
  ".scala": "scala",
  ".lua": "lua",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".sql": "sql",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".md": "markdown",
  ".vue": "vue",
  ".svelte": "svelte",
};

/** Lower-cased extension including the leading dot, or "" when none. */
export function extensionOf(filePath: string): string {
  const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

/** LSP language id for a file path, when known. */
export function detectLanguageId(filePath: string): string | undefined {
  if (!filePath) return undefined;
  return LANGUAGE_BY_EXTENSION[extensionOf(filePath)];
}
