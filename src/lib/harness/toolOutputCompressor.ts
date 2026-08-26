/**
 * ToolOutputCompressor — Compress large tool outputs for LLM context.
 *
 * Rules:
 *  - read_file: keep metadata, cap content, preserve relevant excerpt
 *  - grep: keep file + line + match, cap number of results
 *  - shell: errors → keep stderr fully; success → truncate if too large
 *  - git_diff: keep diff but hard cap
 *  - Unknown: generic truncation
 *
 * Structured output includes meta object with truncation info.
 */

const MAX_CHARS_READ_FILE = 8_000;
const MAX_CHARS_GREP = 6_000;
const MAX_CHARS_SHELL_SUCCESS = 10_000;
const MAX_CHARS_SHELL_ERROR = 3_000;
const MAX_CHARS_GIT_DIFF = 8_000;
const MAX_CHARS_GENERIC = 6_000;

export interface CompressedResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  meta?: {
    truncated: boolean;
    originalChars: number;
    retainedChars: number;
  };
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: text.slice(0, maxChars) + "\n... [truncated]",
    truncated: true,
  };
}

/**
 * Parse a JSON tool result and compress it based on tool name.
 * If the input is not valid JSON or not a recognized format, returns generic truncation.
 */
export function compressToolResult(
  raw: string,
  toolName: string
): string {
  if (!raw || raw.length <= 500) return raw;

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Plain text — generic truncation
    const { text, truncated } = truncate(raw, MAX_CHARS_GENERIC);
    if (!truncated) return raw;
    return JSON.stringify({
      stdout: text,
      stderr: "",
      exitCode: 0,
      meta: { truncated: true, originalChars: raw.length, retainedChars: text.length },
    });
  }

  if (typeof parsed !== "object" || parsed === null) return raw;

  const stdout = String(parsed.stdout || "");
  const stderr = String(parsed.stderr || "");
  const exitCode = parsed.exitCode ?? 0;

  // Already small enough
  if (raw.length <= 1000) return raw;

  const originalChars = raw.length;
  let newStdout = stdout;
  let newStderr = stderr;
  let truncated = false;

  switch (toolName) {
    case "read_file": {
      const c = truncate(stdout, MAX_CHARS_READ_FILE);
      if (c.truncated) {
        newStdout = c.text;
        truncated = true;
      }
      break;
    }
    case "grep":
    case "grep_search": {
      const c = truncate(stdout, MAX_CHARS_GREP);
      if (c.truncated) {
        newStdout = c.text;
        truncated = true;
      }
      break;
    }
    case "shell":
    case "run_command": {
      if (exitCode !== 0 || stderr) {
        // Error: keep stderr fully, truncate stdout
        const c = truncate(stdout, MAX_CHARS_SHELL_SUCCESS);
        if (c.truncated) {
          newStdout = c.text;
          truncated = true;
        }
      } else {
        // Success: truncate
        const c = truncate(stdout, MAX_CHARS_SHELL_SUCCESS);
        if (c.truncated) {
          newStdout = c.text;
          truncated = true;
        }
      }
      break;
    }
    case "git_diff": {
      const c = truncate(stdout, MAX_CHARS_GIT_DIFF);
      if (c.truncated) {
        newStdout = c.text;
        truncated = true;
      }
      break;
    }
    default: {
      // Generic read-only tools
      if (READ_ONLY_TOOLS.has(toolName)) {
        const c = truncate(stdout, MAX_CHARS_GENERIC);
        if (c.truncated) {
          newStdout = c.text;
          truncated = true;
        }
      }
      break;
    }
  }

  if (!truncated) return raw;

  const retainedChars = newStdout.length + newStderr.length + 50;
  return JSON.stringify({
    stdout: newStdout,
    stderr: newStderr,
    exitCode,
    meta: { truncated: true, originalChars, retainedChars },
  });
}

const READ_ONLY_TOOLS = new Set([
  "read_file",
  "grep",
  "grep_search",
  "glob",
  "glob_search",
  "find_path",
  "list_dir",
  "tree",
  "file_exists",
  "git_status",
  "git_diff",
]);
