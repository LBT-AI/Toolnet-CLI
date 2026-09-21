import path from "node:path";
import { theme, A } from "../term";

export type CommandCategory = "test" | "build" | "install" | "search" | "inspect" | "shell";

export type ToolCategory =
  | "test"
  | "build"
  | "install"
  | "search"
  | "inspect"
  | "shell"
  | "read"
  | "write"
  | "edit"
  | "subagent"
  | "other";

export interface ClassifiedCommand {
  category: CommandCategory;
  actionLabel: string;
  rawCommand: string;
  cleanCommand: string;
  isLongRunningCandidate: boolean;
  defaultTimeoutMs: number;
}

export interface ToolActionInfo {
  category: ToolCategory;
  actionLabel: string;
  color: string;
  isLongRunningCandidate: boolean;
}

export const DEFAULT_SHELL_TIMEOUT_MS = 60_000;
export const DEFAULT_TEST_BUILD_TIMEOUT_MS = 300_000;
export const MAX_COMMAND_TIMEOUT_MS = 1_800_000; // 30 minutes max
export const MIN_COMMAND_TIMEOUT_MS = 100;

/**
 * Strips leading environment assignments and common command wrappers
 * (sudo, time, nohup, exec) to reveal the substantive executable.
 */
function extractSubstantiveCommand(segment: string): { exeName: string; fullTokens: string[] } {
  const trimmed = segment.trim();
  if (!trimmed) return { exeName: "", fullTokens: [] };

  // Split by whitespace respecting quotes
  const rawTokens = trimmed.split(/\s+/).filter(Boolean);
  const cleanTokens: string[] = [];

  for (let i = 0; i < rawTokens.length; i++) {
    const tok = rawTokens[i];
    // Skip inline env vars (e.g. FOO=bar, CI=true)
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      continue;
    }
    // Skip wrapper commands
    if (tok === "sudo" || tok === "time" || tok === "nohup" || tok === "exec" || tok === "env") {
      continue;
    }
    cleanTokens.push(...rawTokens.slice(i));
    break;
  }

  if (cleanTokens.length === 0) return { exeName: "", fullTokens: [] };

  const exePath = cleanTokens[0];
  const exeBase = path.basename(exePath).toLowerCase();
  return { exeName: exeBase, fullTokens: cleanTokens };
}

/**
 * Single centralized command classifier for ToolNet CLI.
 * Inspects commands, paths (such as .venv/bin/pytest or node_modules/.bin/jest),
 * and chained expressions (cd dir && pytest) to classify action and timeout.
 */
export function classifyCommand(command: string): ClassifiedCommand {
  const rawCommand = command || "";
  const trimmed = rawCommand.trim();

  if (!trimmed) {
    return {
      category: "shell",
      actionLabel: "Run",
      rawCommand,
      cleanCommand: "",
      isLongRunningCandidate: false,
      defaultTimeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
    };
  }

  // Handle chained expressions: inspect substantive segments (skipping cd, export, mkdir, etc.)
  const segments = trimmed.split(/&&|\|\||;/).map((s) => s.trim()).filter(Boolean);
  let targetSegment = segments[0] || trimmed;

  // If the first segment is just a prelude (cd, export, mkdir, pwd, echo, source, set, true), look for substantive command
  for (const seg of segments) {
    const { exeName } = extractSubstantiveCommand(seg);
    if (["cd", "export", "mkdir", "pwd", "echo", "source", "set", "true", "sleep"].includes(exeName)) {
      continue;
    }
    targetSegment = seg;
    break;
  }

  const { exeName, fullTokens } = extractSubstantiveCommand(targetSegment);
  const fullLower = fullTokens.map((t) => t.toLowerCase()).join(" ");

  // 1. Test commands
  const isTestExe = [
    "pytest",
    "py.test",
    "pytest-3",
    "jest",
    "vitest",
    "mocha",
    "ava",
    "playwright",
    "cypress",
    "ctest",
    "cargo-test",
  ].includes(exeName);

  const isTestSubcommand =
    fullLower.startsWith("bun test") ||
    fullLower.startsWith("npm test") ||
    fullLower.startsWith("npm t ") ||
    fullLower === "npm t" ||
    fullLower.startsWith("npm run test") ||
    fullLower.startsWith("pnpm test") ||
    fullLower.startsWith("pnpm t ") ||
    fullLower === "pnpm t" ||
    fullLower.startsWith("pnpm run test") ||
    fullLower.startsWith("yarn test") ||
    fullLower.startsWith("cargo test") ||
    fullLower.startsWith("go test") ||
    fullLower.startsWith("dotnet test") ||
    fullLower.startsWith("python -m pytest") ||
    fullLower.startsWith("python3 -m pytest") ||
    fullLower.startsWith("python -m unittest") ||
    fullLower.startsWith("python3 -m unittest");

  if (isTestExe || isTestSubcommand) {
    return {
      category: "test",
      actionLabel: "Test",
      rawCommand,
      cleanCommand: targetSegment,
      isLongRunningCandidate: true,
      defaultTimeoutMs: DEFAULT_TEST_BUILD_TIMEOUT_MS,
    };
  }

  // 2. Build commands
  const isBuildExe = [
    "tsc",
    "esbuild",
    "rollup",
    "webpack",
    "vite",
    "turbo",
    "next",
    "make",
    "ninja",
    "cmake",
    "cargo-build",
    "gcc",
    "g++",
    "clang",
    "rustc",
    "gradle",
    "mvn",
  ].includes(exeName);

  const isBuildSubcommand =
    fullLower.startsWith("bun run build") ||
    fullLower.startsWith("npm run build") ||
    fullLower.startsWith("pnpm build") ||
    fullLower.startsWith("pnpm run build") ||
    fullLower.startsWith("yarn build") ||
    fullLower.startsWith("cargo build") ||
    fullLower.startsWith("go build") ||
    fullLower.startsWith("dotnet build");

  if (isBuildExe || isBuildSubcommand) {
    return {
      category: "build",
      actionLabel: "Build",
      rawCommand,
      cleanCommand: targetSegment,
      isLongRunningCandidate: true,
      defaultTimeoutMs: DEFAULT_TEST_BUILD_TIMEOUT_MS,
    };
  }

  // 3. Install commands
  const isInstallSubcommand =
    fullLower.startsWith("npm install") ||
    fullLower.startsWith("npm i ") ||
    fullLower === "npm i" ||
    fullLower.startsWith("npm add") ||
    fullLower.startsWith("bun install") ||
    fullLower.startsWith("bun i ") ||
    fullLower === "bun i" ||
    fullLower.startsWith("bun add") ||
    fullLower.startsWith("pnpm install") ||
    fullLower.startsWith("pnpm i ") ||
    fullLower === "pnpm i" ||
    fullLower.startsWith("pnpm add") ||
    fullLower.startsWith("yarn install") ||
    fullLower.startsWith("yarn add") ||
    fullLower.startsWith("cargo fetch") ||
    fullLower.startsWith("pip install") ||
    fullLower.startsWith("pip3 install") ||
    fullLower.startsWith("poetry install") ||
    fullLower.startsWith("pipenv install") ||
    fullLower.startsWith("composer install") ||
    fullLower.startsWith("apt-get install") ||
    fullLower.startsWith("brew install");

  if (isInstallSubcommand) {
    return {
      category: "install",
      actionLabel: "Install",
      rawCommand,
      cleanCommand: targetSegment,
      isLongRunningCandidate: true,
      defaultTimeoutMs: DEFAULT_TEST_BUILD_TIMEOUT_MS,
    };
  }

  // 4. Search commands
  const isSearchExe = [
    "grep",
    "rg",
    "ripgrep",
    "find",
    "fd",
    "ag",
    "ack",
  ].includes(exeName);

  if (isSearchExe) {
    return {
      category: "search",
      actionLabel: "Search",
      rawCommand,
      cleanCommand: targetSegment,
      isLongRunningCandidate: false,
      defaultTimeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
    };
  }

  // 5. Inspect commands
  const isInspectCommand =
    fullLower.startsWith("git status") ||
    fullLower.startsWith("git diff") ||
    fullLower.startsWith("git log") ||
    fullLower.startsWith("git show") ||
    fullLower.startsWith("git branch") ||
    exeName === "stat";

  if (isInspectCommand) {
    return {
      category: "inspect",
      actionLabel: "Inspect",
      rawCommand,
      cleanCommand: targetSegment,
      isLongRunningCandidate: false,
      defaultTimeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
    };
  }

  // 6. Fallback generic shell
  return {
    category: "shell",
    actionLabel: "Run",
    rawCommand,
    cleanCommand: targetSegment,
    isLongRunningCandidate: false,
    defaultTimeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
  };
}

/**
 * Returns the default timeout in ms for a given command based on its classification.
 */
export function resolveDefaultTimeout(command: string): number {
  return classifyCommand(command).defaultTimeoutMs;
}

/**
 * Safely clamps an optional timeoutMs bounded between MIN_COMMAND_TIMEOUT_MS and MAX_COMMAND_TIMEOUT_MS (30 min).
 * If undefined or invalid, falls back to the classification default.
 */
export function clampTimeout(timeoutMs?: number | unknown, command?: string): number {
  if (timeoutMs !== undefined && timeoutMs !== null) {
    const n = Number(timeoutMs);
    if (!isNaN(n) && n > 0) {
      return Math.min(Math.max(MIN_COMMAND_TIMEOUT_MS, n), MAX_COMMAND_TIMEOUT_MS);
    }
  }
  return command ? resolveDefaultTimeout(command) : DEFAULT_SHELL_TIMEOUT_MS;
}

/**
 * Classifies any tool (shell, filesystem, search, subagent) into a canonical UI action.
 */
export function classifyToolAction(toolName: string, args?: any): ToolActionInfo {
  const name = (toolName || "").toLowerCase().trim();

  // Shell / command tools
  if (
    name === "shell" ||
    name === "bash" ||
    name === "run_command" ||
    name === "exec" ||
    name === "terminal" ||
    name === "sh" ||
    name === "cmd"
  ) {
    const cmd = String(args?.command || args?.cmd || args?.CommandLine || "");
    const classified = classifyCommand(cmd);
    const color =
      classified.category === "test" ||
      classified.category === "build" ||
      classified.category === "install"
        ? theme.running
        : theme.read;

    return {
      category: classified.category,
      actionLabel: classified.actionLabel,
      color,
      isLongRunningCandidate: classified.isLongRunningCandidate,
    };
  }

  // Read tools
  if (
    name === "read_file" ||
    name === "read" ||
    name === "cat" ||
    name === "view_file" ||
    name === "get_file" ||
    name === "file_exists" ||
    name === "read_url_content" ||
    name === "list_dir" ||
    name === "tree" ||
    name === "get_cwd" ||
    name === "stat_path" ||
    name === "detect_project" ||
    name === "web_fetch" ||
    name === "audit_url" ||
    name === "crawl_url" ||
    name === "browser_fetch" ||
    name.startsWith("lsp_")
  ) {
    return {
      category: "read",
      actionLabel: prettyToolNameHelper(name),
      color: theme.read,
      isLongRunningCandidate: false,
    };
  }

  // Search tools
  if (
    name === "grep" ||
    name === "grep_search" ||
    name === "glob" ||
    name === "glob_search" ||
    name === "find_path" ||
    name === "find_by_name" ||
    name === "search" ||
    name === "search_web"
  ) {
    return {
      category: "search",
      actionLabel: prettyToolNameHelper(name),
      color: theme.search,
      isLongRunningCandidate: false,
    };
  }

  // Write tools
  if (
    name === "write_file" ||
    name === "create_file" ||
    name === "save_file" ||
    name === "write" ||
    name === "save_plan" ||
    name === "create_artifact"
  ) {
    return {
      category: "write",
      actionLabel: prettyToolNameHelper(name),
      color: theme.write,
      isLongRunningCandidate: false,
    };
  }

  // Edit / mutation tools
  if (
    name === "edit" ||
    name === "patch" ||
    name === "replace_file_content" ||
    name === "edit_file" ||
    name === "apply_diff" ||
    name === "apply_patch" ||
    name === "replace_all" ||
    name === "modify" ||
    name === "update_artifact"
  ) {
    return {
      category: "edit",
      actionLabel: prettyToolNameHelper(name),
      color: theme.edit,
      isLongRunningCandidate: false,
    };
  }

  // Subagent tools
  if (name === "task" || name === "spawn_subagent" || name === "delegate_task") {
    return {
      category: "subagent",
      actionLabel: "Subagent",
      color: theme.subagent,
      isLongRunningCandidate: true,
    };
  }

  // Inspect tools
  if (name === "git_status" || name === "git_diff") {
    return {
      category: "inspect",
      actionLabel: prettyToolNameHelper(name),
      color: theme.read,
      isLongRunningCandidate: false,
    };
  }

  return {
    category: "other",
    actionLabel: prettyToolNameHelper(name),
    color: theme.text,
    isLongRunningCandidate: false,
  };
}

function prettyToolNameHelper(name: string): string {
  const map: Record<string, string> = {
    get_cwd: "GetCwd",
    list_dir: "ListDir",
    read_file: "Read",
    write_file: "Write",
    edit_file: "Edit",
    replace_all: "Replace",
    grep_search: "Grep",
    grep: "Grep",
    glob_search: "Glob",
    glob: "Glob",
    find_path: "Find",
    shell: "Run",
    run_command: "Run",
    bash: "Run",
    web_fetch: "Fetch",
    audit_url: "Audit",
    crawl_url: "Crawl",
    file_exists: "Exists",
    stat_path: "Stat",
    tree: "Tree",
    detect_project: "DetectProject",
    browser_fetch: "Browser",
    parse_html: "ParseHtml",
    apply_patch: "Patch",
    patch: "Patch",
    git_status: "GitStatus",
    git_diff: "GitDiff",
    task: "Subagent",
    spawn_subagent: "Subagent",
    delegate_task: "Subagent",
  };
  return map[name.toLowerCase()] || name;
}
