import { A, theme } from "../term";
import {
  classifyToolAction,
  classifyCommand,
  resolveDefaultTimeout,
  clampTimeout,
  type CommandCategory,
  type ToolCategory,
  type ClassifiedCommand,
} from "./commandClassifier";

export {
  classifyToolAction,
  classifyCommand,
  resolveDefaultTimeout,
  clampTimeout,
  type CommandCategory,
  type ToolCategory,
  type ClassifiedCommand,
};

export function isVerboseMode(): boolean {
  return process.env.TOOLNET_DEBUG === "1" || process.argv.includes("--verbose");
}

export function prettyToolName(name: string): string {
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

export function prettyToolTarget(name: string, args: any): string {
  if (!args || typeof args !== "object") return "";
  const lowerName = name.toLowerCase();

  if (lowerName === "shell" || lowerName === "run_command" || lowerName === "bash") {
    let cmd = args.command || args.cmd || args.CommandLine || "";
    if (typeof cmd !== "string") cmd = JSON.stringify(cmd);
    cmd = cmd.replace(/[\r\n]+/g, " ").trim();
    if (cmd.length > 60) cmd = cmd.substring(0, 57) + "...";
    return cmd;
  }

  if (lowerName === "find_path") {
    const root = args.root || "";
    const q = args.query || "";
    const type = args.type ? ` -type ${args.type}` : "";
    return root ? `${root} -iname '*${q}*'${type}` : `*${q}*${type}`;
  }

  if (lowerName === "grep_search" || lowerName === "grep") {
    const pat = args.pattern || "";
    const p = args.path ? ` in ${args.path}` : "";
    return `${pat}${p}`;
  }

  if (
    lowerName === "audit_url" ||
    lowerName === "web_fetch" ||
    lowerName === "crawl_url" ||
    lowerName === "browser_fetch"
  ) {
    return args.url || args.link || "";
  }

  // File path tools
  let target =
    args.path ||
    args.url ||
    args.pattern ||
    args.directory ||
    args.file ||
    args.absolutePath ||
    args.directoryPath ||
    args.targetFile ||
    "";
  if (typeof target !== "string") target = JSON.stringify(target);
  target = target.replace(/[\r\n]+/g, " ").trim();
  if (target.length > 60) target = target.substring(0, 57) + "...";
  return target;
}

export interface RenderToolLineOptions {
  action?: string;
  target?: string;
  name?: string;
  args?: any;
  status: "running" | "success" | "error" | "cancelled";
  elapsedMs?: number;
  durationMs?: number;
}

export function formatDuration(ms: number): string {
  if (ms < 0) return "0s";
  if (ms >= 60_000) {
    const mins = Math.floor(ms / 60_000);
    const secs = Math.round((ms % 60_000) / 1000);
    return `${mins}m ${secs}s`;
  }
  if (ms >= 10_000) {
    return `${Math.round(ms / 1000)}s`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

export function renderToolLine(
  optsOrName: RenderToolLineOptions | string,
  args?: any,
  statusArg?: "running" | "success" | "error" | "cancelled",
  durationMsArg?: number,
): string {
  let action = "";
  let target = "";
  let color = theme.running;
  let status: "running" | "success" | "error" | "cancelled" = "running";
  let durationMs: number | undefined = undefined;

  if (typeof optsOrName === "object" && optsOrName !== null) {
    status = optsOrName.status;
    durationMs = optsOrName.elapsedMs !== undefined ? optsOrName.elapsedMs : optsOrName.durationMs;
    if (optsOrName.action) {
      action = optsOrName.action;
    } else if (optsOrName.name) {
      const info = classifyToolAction(optsOrName.name, optsOrName.args);
      action = info.actionLabel || prettyToolName(optsOrName.name);
      color = info.color;
    }
    if (optsOrName.target !== undefined) {
      target = optsOrName.target;
    } else if (optsOrName.name) {
      target = prettyToolTarget(optsOrName.name, optsOrName.args);
    }
  } else {
    const name = optsOrName;
    status = statusArg || "running";
    durationMs = durationMsArg;
    const info = classifyToolAction(name, args);
    action = info.actionLabel || prettyToolName(name);
    color = info.color;
    target = prettyToolTarget(name, args);
  }

  const targetFormatted = target ? ` ${A.dim}${A.fgSubtext}${target}${A.reset}` : "";
  const durStr = durationMs !== undefined ? formatDuration(durationMs) : "";

  if (status === "running") {
    const durFormatted = durStr ? ` ${A.dim}${A.fgMuted}· ${durStr}${A.reset}` : "";
    return `  ${A.fgAmber}●${A.reset} ${A.bold}${A.fgAmber}${action}${A.reset}${targetFormatted}${durFormatted}`;
  }

  if (status === "cancelled") {
    const durFormatted = durStr ? ` · ${durStr}` : "";
    return `  ${A.fgMuted}■${A.reset} ${A.fgMuted}${action}${A.reset}${targetFormatted} ${A.fgMuted}· cancelled${durFormatted}${A.reset}`;
  }

  if (status === "success") {
    const durFormatted = durStr ? ` ${A.dim}${A.fgMuted}· ${durStr}${A.reset}` : "";
    return `  ${A.fgGreen}✓${A.reset} ${color}${action}${A.reset}${targetFormatted}${durFormatted}`;
  }

  const durFormatted = durStr ? ` ${A.dim}${A.fgMuted}· ${durStr}${A.reset}` : "";
  return `  ${A.fgRed}✗${A.reset} ${A.fgRed}${action}${A.reset}${targetFormatted}${durFormatted}`;
}

/**
 * The full-screen TUI re-renders its entire transcript on every state update.
 * Keeping the assistant's pending tool_call row in that transcript causes the
 * same action to appear twice after completion: once as `…` and once as `✓`.
 *
 * The lightweight --simple REPL also uses raw terminal mode, but it has no
 * persistent status bar and therefore still needs the start row. Keep the
 * decision explicit and testable instead of treating raw mode alone as proof
 * that the full-screen transcript renderer is active.
 */
export function shouldRenderToolStart(
  argv: readonly string[] = process.argv.slice(2),
  isRaw: boolean = process.stdin.isRaw === true,
): boolean {
  const isSimpleRepl = argv.includes("--simple") || argv.includes("-s");
  if (isSimpleRepl) return true;
  return !isRaw;
}

export function printToolStart(toolName: string, args: any): string {
  if (!shouldRenderToolStart()) return "";
  return renderToolLine(toolName, args, "running");
}

export function printToolEnd(
  toolName: string,
  args: any,
  success: boolean,
  durationMs?: number,
): string {
  return renderToolLine(toolName, args, success ? "success" : "error", durationMs);
}
