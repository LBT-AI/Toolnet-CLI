const ANSI = {
  reset: "\x1b[0m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
}

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
  }
  return map[name.toLowerCase()] || name
}

export function prettyToolTarget(name: string, args: any): string {
  if (!args || typeof args !== "object") return ""
  const lowerName = name.toLowerCase()

  if (lowerName === "shell" || lowerName === "run_command") {
    let cmd = args.command || args.cmd || ""
    if (typeof cmd !== "string") cmd = JSON.stringify(cmd)
    cmd = cmd.replace(/[\r\n]+/g, " ").trim()
    if (cmd.length > 60) cmd = cmd.substring(0, 57) + "..."
    return cmd
  }

  if (lowerName === "find_path") {
    const root = args.root || ""
    const q = args.query || ""
    const type = args.type ? ` -type ${args.type}` : ""
    return root ? `${root} -iname '*${q}*'${type}` : `*${q}*${type}`
  }

  if (lowerName === "grep_search" || lowerName === "grep") {
    const pat = args.pattern || ""
    const p = args.path ? ` in ${args.path}` : ""
    return `${pat}${p}`
  }

  if (lowerName === "audit_url" || lowerName === "web_fetch" || lowerName === "crawl_url" || lowerName === "browser_fetch") {
    return args.url || args.link || ""
  }

  // file path tools
  let target = args.path || args.url || args.pattern || args.directory || args.file || args.url || args.absolutePath || args.directoryPath || args.targetFile || ""
  if (typeof target !== "string") target = JSON.stringify(target)
  target = target.replace(/[\r\n]+/g, " ").trim()
  if (target.length > 60) target = target.substring(0, 57) + "..."
  return target
}

export function renderToolLine(
  name: string,
  args: any,
  status: "running" | "success" | "error",
): string {
  const action = prettyToolName(name)
  const target = prettyToolTarget(name, args)

  const suffix =
    status === "running"
      ? `${ANSI.dim}…${ANSI.reset}`
      : status === "success"
        ? `${ANSI.green}✓${ANSI.reset}`
        : `${ANSI.red}✗${ANSI.reset}`

  return `${ANSI.dim}◑${ANSI.reset} ${ANSI.yellow}${action}${ANSI.reset} ${ANSI.cyan}(${target})${ANSI.reset} ${suffix}`
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
  const isSimpleRepl = argv.includes("--simple") || argv.includes("-s")
  if (isSimpleRepl) return true
  return !isRaw
}

export function printToolStart(toolName: string, args: any): string {
  if (!shouldRenderToolStart()) return ""
  return renderToolLine(toolName, args, "running")
}

export function printToolEnd(toolName: string, args: any, success: boolean): string {
  return renderToolLine(toolName, args, success ? "success" : "error")
}
