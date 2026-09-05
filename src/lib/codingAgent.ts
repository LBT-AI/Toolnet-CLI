import fs from "node:fs";
import path from "node:path";
import { pushSnapshot, commitSnapshot } from "./history";
import { evaluatePermission, isPathInsideWorkspace, getSandboxMode } from "./permissions";
import { applyStructuredPatch, generateDiff } from "./patchUtils";
import { redactSecrets } from "./security/secretGuard";

export interface ToolResult {
  success: boolean;
  data?: string;
  error?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  truncated?: boolean;
}

export let currentCwd = process.cwd();
export let workspaceRoot = process.cwd();
export let workspaceRoots: string[] = [process.cwd()];
export let bypassPolicy = false;

export function getWorkspaceRoots(): string[] {
  return [...workspaceRoots];
}

export function setWorkspaceRoots(roots: string[]): void {
  workspaceRoots = roots.map(r => path.resolve(r)).filter(r => fs.existsSync(r));
  if (workspaceRoots.length > 0) {
    workspaceRoot = workspaceRoots[0];
  }
}

export function initWorkspace(customPath?: string, customRoots?: string[]) {
  const detectedRoots: string[] = [];

  if (customRoots && customRoots.length > 0) {
    detectedRoots.push(...customRoots);
  } else if (customPath) {
    detectedRoots.push(customPath);
  } else {
    // Check CLI args for multiple --workspace flags
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if ((arg === "--cwd" || arg === "--workspace") && i + 1 < args.length) {
        detectedRoots.push(args[i + 1]);
        i++;
      } else if (arg.startsWith("--cwd=") || arg.startsWith("--workspace=")) {
        detectedRoots.push(arg.split("=")[1]);
      }
    }

    // Check for toolnet.workspace.json in current directory
    const workspaceConfigFile = path.join(process.cwd(), "toolnet.workspace.json");
    if (detectedRoots.length === 0 && fs.existsSync(workspaceConfigFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(workspaceConfigFile, "utf8"));
        if (Array.isArray(parsed.roots)) {
          for (const r of parsed.roots) {
            detectedRoots.push(path.resolve(process.cwd(), r));
          }
        }
      } catch {}
    }
  }

  const validRoots = detectedRoots
    .map((r) => path.resolve(process.cwd(), r))
    .filter((abs) => fs.existsSync(abs) && fs.statSync(abs).isDirectory());

  if (validRoots.length > 0) {
    workspaceRoots = validRoots;
    workspaceRoot = validRoots[0];
    currentCwd = validRoots[0];
    try {
      process.chdir(validRoots[0]);
    } catch {}
  } else {
    workspaceRoots = [process.cwd()];
    workspaceRoot = process.cwd();
    currentCwd = process.cwd();
  }
}

/**
 * DEPRECATED (Layer 4 Phase 1): kept for API compatibility only. Setting this
 * flag NO LONGER bypasses any filesystem invariant — workspace boundary checks
 * run regardless of its value (they were already keyed on sandboxMode).
 */
export function setBypassPolicy(enabled: boolean) {
  bypassPolicy = enabled;
}

/**
 * DEPRECATED (Layer 4 Phase 1): `bypassPolicy` is no longer a second security
 * state machine. File tool invariants (realpath + workspace boundary) are now
 * gated ONLY by sandboxMode via SecurityEngine. This flag purely reflects the
 * active sandbox mode for UI display and can never widen filesystem access.
 */
export function getCwdInfo() {
  const isFullAccess = getSandboxMode() === "full-access";
  return { currentCwd, workspaceRoot, workspaceRoots: [...workspaceRoots], bypassPolicy: isFullAccess };
}

export function setWorkspaceRoot(newPath: string): boolean {
  const abs = path.resolve(workspaceRoot, newPath);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    workspaceRoot = abs;
    currentCwd = abs;
    try {
      process.chdir(abs);
    } catch {}
    return true;
  }
  return false;
}

export function setCwd(newPath: string) {
  const abs = path.resolve(currentCwd, newPath);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    currentCwd = abs;
    return true;
  }
  return false;
}

export function resolvePath(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return path.normalize(filePath);
  }
  return path.resolve(currentCwd, filePath);
}

function checkPathTraversal(filePath: string, absPath: string, isReadAction = false): { allowed: boolean; error?: string } {
  if (bypassPolicy && getSandboxMode() === "full-access") return { allowed: true };
  const mode = getSandboxMode();
  if (mode === "full-access") return { allowed: true };

  const pathCheck = isPathInsideWorkspace(filePath, workspaceRoot, currentCwd);
  if (!pathCheck.isInside) {
    if (mode === "workspace") {
      return {
        allowed: false,
        error: `Path traversal blocked: "${filePath}" resolves outside workspace (${pathCheck.realWorkspaceRoot}). In 'workspace' mode, accessing files outside the workspace is strictly prohibited.`,
      };
    }
  }
  return { allowed: true };
}

const MAX_OUTPUT_LINES = 500;
const MAX_OUTPUT_CHARS = 50000;

function truncateOutput(text: string): { data: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { data: text, truncated: false };
  return { data: text.slice(0, MAX_OUTPUT_CHARS) + `\n... (truncated, ${text.length - MAX_OUTPUT_CHARS} more chars)`, truncated: true };
}

export function toolRead(filePath: string, offset = 0, limit = MAX_OUTPUT_LINES): ToolResult {
  try {
    const absPath = resolvePath(filePath);
    const access = checkPathTraversal(filePath, absPath, true);
    if (!access.allowed) return { success: false, error: access.error };
    if (!fs.existsSync(absPath)) return { success: false, error: `File not found: ${absPath}` };
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return { success: false, error: `Not a file: ${absPath}` };

    const content = fs.readFileSync(absPath, "utf8");
    const lines = content.split("\n");

    const startLine = Math.max(0, offset);
    const endLine = limit > 0 ? Math.min(lines.length, startLine + limit) : lines.length;
    const selected = lines.slice(startLine, endLine);

    let result = selected.join("\n");
    if (endLine < lines.length) {
      result += `\n... (${lines.length - endLine} more lines)`;
    }

    const { data, truncated } = truncateOutput(result);
    return { success: true, data, truncated };
  } catch (err: unknown) {
    return { success: false, error: `Read error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function toolGlob(pattern: string, searchPath = "."): ToolResult {
  try {
    const absPath = resolvePath(searchPath);
    const access = checkPathTraversal(searchPath, absPath, true);
    if (!access.allowed) return { success: false, error: access.error };
    if (!fs.existsSync(absPath)) return { success: false, error: `Path not found: ${absPath}` };

    const matches: string[] = [];
    let count = 0;

    // Build a proper glob → regex converter.
    // Order matters: escape regex specials FIRST, then handle glob wildcards.
    function globToRegex(glob: string): RegExp {
      // Strip trailing slash (treat dir patterns the same as name patterns)
      const g = glob.replace(/\/+$/, "");

      let src = "";
      let i = 0;
      while (i < g.length) {
        const ch = g[i];

        if (ch === "*" && g[i + 1] === "*") {
          // ** — match anything including path separators
          src += ".*";
          i += 2;
          // Skip optional surrounding slashes so **/ and /** don't leave bare /
          if (g[i] === "/") i++;
        } else if (ch === "*") {
          // * — match anything except /
          src += "[^/]*";
          i++;
        } else if (ch === "?") {
          // ? — match any single char except /
          src += "[^/]";
          i++;
        } else if (/[.+^${}()|[\]\\]/.test(ch)) {
          // Escape regex special characters
          src += "\\" + ch;
          i++;
        } else {
          src += ch;
          i++;
        }
      }

      // Validate before constructing — never let new RegExp throw
      try {
        return new RegExp(`(^|/)${src}(/|$)`, "i");
      } catch {
        throw new Error(`invalid pattern "${glob}"`);
      }
    }

    let regex: RegExp;
    try {
      regex = globToRegex(pattern);
    } catch (patternErr: any) {
      // Pattern is invalid — gracefully fallback to shell find
      const { spawnSync } = require("node:child_process");
      const nameHint = pattern.replace(/[\*\*\/]+/g, "").replace(/[^a-zA-Z0-9._-]/g, "") || pattern;
      const findResult = spawnSync("find", [
        absPath,
        "-maxdepth", "6",
        "-iname", `*${nameHint}*`,
      ], { encoding: "utf8", timeout: 10000 });
      const out = (findResult.stdout || "").trim();
      if (!out) return { success: false, error: `Glob error: invalid pattern "${pattern}". No results from fallback find.` };
      return {
        success: true,
        data: `[fallback find] ${out.split("\n").length} match(es):\n${out}`
      };
    }

    // Whether the pattern explicitly targets hidden dirs/files
    const patternWantsHidden = pattern.includes("/.");

    function walkDir(dir: string, relBase: string): void {
      if (count >= 1000) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (count >= 1000) return;

          // Skip hidden dirs/files unless pattern explicitly targets them
          if (!patternWantsHidden && entry.name.startsWith(".") && entry.name !== ".env") continue;
          // Skip node_modules unless pattern explicitly targets them
          if (entry.name === "node_modules" && !pattern.includes("node_modules")) continue;

          const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
          if (regex.test(relPath) || regex.test(entry.name)) {
            matches.push(relPath);
            count++;
          }

          if (entry.isDirectory()) {
            walkDir(path.join(dir, entry.name), relPath);
          }
        }
      } catch {}
    }
    
    walkDir(absPath, "");

    if (matches.length === 0) return { success: true, data: "No matches found." };
    const result = matches.join("\n");
    return { success: true, data: `${matches.length} match(es):\n${result}` };
  } catch (err: unknown) {
    return { success: false, error: `Glob error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function toolFindPath(query: string, root?: string, maxDepth: number = 6, type?: string): ToolResult {
  try {
    const searchRoot = root ? resolvePath(root) : workspaceRoot;
    const access = checkPathTraversal(root || ".", searchRoot, true);
    if (!access.allowed) return { success: false, error: access.error };
    
    if (!fs.existsSync(searchRoot)) return { success: false, error: `Directory not found: ${searchRoot}` };
    
    const { spawnSync } = require("node:child_process");
    const args = [searchRoot, "-maxdepth", String(maxDepth || 6), "-iname", `*${query}*`];
    
    if (type === "dir") {
      args.push("-type", "d");
    } else if (type === "file") {
      args.push("-type", "f");
    }
    
    const result = spawnSync("find", args, { encoding: "utf8", timeout: 10000 });
    
    if (result.error) {
      return { success: false, error: `find command error: ${result.error.message}` };
    }
    
    const out = (result.stdout || "").trim();
    if (!out) return { success: true, data: "No matches found." };
    
    const lines = out.split("\n");
    const { data, truncated } = truncateOutput(`${lines.length} match(es):\n${out}`);
    return { success: true, data, truncated };
  } catch (err: unknown) {
    return { success: false, error: `find path error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function toolGrep(pattern: string, searchPath = ".", include?: string): ToolResult {
  try {
    const absPath = resolvePath(searchPath);
    const access = checkPathTraversal(searchPath, absPath, true);
    if (!access.allowed) return { success: false, error: access.error };
    if (!fs.existsSync(absPath)) return { success: false, error: `Path not found: ${absPath}` };
    const stat = fs.statSync(absPath);
    if (!stat.isDirectory()) return { success: false, error: `Not a directory: ${absPath}` };

    const { spawnSync } = require("node:child_process");
    const args = ["-rnI"]; // recursive, line number, ignore binary
    // Emulate original exclusions: exclude hidden files and node_modules
    args.push("--exclude-dir=.*", "--exclude-dir=node_modules", "--exclude=.*");
    
    if (include) {
      args.push(`--include=${include}`);
    }
    args.push(pattern, ".");

    const result = spawnSync("grep", args, { cwd: absPath, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });

    if (result.error) {
      return { success: false, error: `Grep execution error: ${result.error.message}` };
    }

    if (result.status === 1) {
      return { success: true, data: "No matches found." };
    }

    if (result.status === 0) {
      const lines = result.stdout.trim().split("\n");
      const { data, truncated } = truncateOutput(`${lines.length} match(es):\n${result.stdout}`);
      return { success: true, data, truncated };
    }

    return { success: false, error: `Grep error: ${result.stderr}` };
  } catch (err: unknown) {
    return { success: false, error: `Grep error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
export function toolEdit(filePath: string, oldString: string, newString: string): ToolResult {
  try {
    const absPath = resolvePath(filePath);
    const access = checkPathTraversal(filePath, absPath);
    if (!access.allowed) return { success: false, error: access.error };
    if (!fs.existsSync(absPath)) return { success: false, error: `File not found: ${absPath}` };
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return { success: false, error: `Not a file: ${absPath}` };

    const content = fs.readFileSync(absPath, "utf8");
    const idx = content.indexOf(oldString);
    if (idx === -1) return { success: false, error: `"${oldString}" not found in file` };

    const newContent = content.replace(oldString, newString);
    if (newContent === content) return { success: false, error: "No changes made (oldString == newString?)" };

    pushSnapshot(absPath, `edit: replace "${oldString.substring(0, 40)}" in ${path.basename(absPath)}`);
    fs.writeFileSync(absPath, newContent, "utf8");
    commitSnapshot(absPath);
    const rel = path.relative(currentCwd, absPath);
    const diff = generateDiff(content, newContent, rel);
    return { success: true, data: `Edited ${rel}:\n${diff}` };
  } catch (err: unknown) {
    return { success: false, error: `Edit error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function toolReplaceAll(filePath: string, oldString: string, newString: string): ToolResult {
  try {
    const absPath = resolvePath(filePath);
    const access = checkPathTraversal(filePath, absPath);
    if (!access.allowed) return { success: false, error: access.error };
    if (!fs.existsSync(absPath)) return { success: false, error: `File not found: ${absPath}` };
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return { success: false, error: `Not a file: ${absPath}` };

    const content = fs.readFileSync(absPath, "utf8");
    const newContent = content.replaceAll(oldString, newString);
    if (newContent === content) return { success: false, error: "No matches found" };

    pushSnapshot(absPath, `replaceAll: "${oldString.substring(0, 40)}" in ${path.basename(absPath)}`);
    fs.writeFileSync(absPath, newContent, "utf8");
    commitSnapshot(absPath);
    const count = (content.match(new RegExp(oldString.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    const rel = path.relative(currentCwd, absPath);
    const diff = generateDiff(content, newContent, rel);
    return { success: true, data: `Replaced ${count} occurrence(s) in ${rel}:\n${diff}` };
  } catch (err: unknown) {
    return { success: false, error: `ReplaceAll error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function toolWrite(filePath: string, content: string): ToolResult {
  try {
    const absPath = resolvePath(filePath);
    const access = checkPathTraversal(filePath, absPath);
    if (!access.allowed) return { success: false, error: access.error };
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    let oldContent = "";
    if (fs.existsSync(absPath)) {
      try {
        oldContent = fs.readFileSync(absPath, "utf8");
      } catch {}
    }
    pushSnapshot(absPath, `write: ${path.basename(absPath)}`);
    fs.writeFileSync(absPath, content, "utf8");
    commitSnapshot(absPath);
    const rel = path.relative(currentCwd, absPath);
    const diff = oldContent ? generateDiff(oldContent, content, rel) : "";
    const msg = diff ? `Written ${content.length} bytes to ${rel}:\n${diff}` : `Written ${content.length} bytes to ${rel}`;
    return { success: true, data: msg };
  } catch (err: unknown) {
    return { success: false, error: `Write error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Explicit execution context for the raw shell executor (toolBash).
 * Provided by the ToolGateway execution layer; the executor MUST NOT fall back
 * to module-global state when a caller supplies a context.
 */
export interface ShellExecContext {
  cwd?: string;
  workspaceRoot?: string;
  sandboxMode?: "workspace" | "ask" | "full-access";
  env?: Record<string, string>;
  outputCapBytes?: number;
}

const DEFAULT_SHELL_OUTPUT_CAP = 512 * 1024; // hard byte cap per stream

/**
 * Resolve the effective cwd for a shell execution against explicit context.
 * Guard Clauses — each rule short-circuits to a rejection.
 * The resolved cwd is a REAL path (symlink escape resistant).
 *
 * Fallback chain when the caller passes NO context: explicit ctx.cwd → module
 * workspaceRoot (legacy default) → process.cwd(). A stale module root (e.g.
 * deleted by another test) self-heals to process.cwd() instead of failing.
 */
function resolveShellExecCwd(ctx: ShellExecContext): { ok: true; cwd: string } | { ok: false; error: string } {
  const mode = ctx.sandboxMode || getSandboxMode();

  const candidates: string[] = [];
  if (ctx.cwd) candidates.push(ctx.cwd);
  candidates.push(workspaceRoot, process.cwd());

  let requested: string | null = null;
  for (const c of candidates) {
    if (c && fs.existsSync(c) && fs.statSync(c).isDirectory()) {
      requested = c;
      break;
    }
  }
  if (!requested) {
    return { ok: false, error: "cwd does not exist or is not a directory (no valid fallback available)" };
  }

  // Realpath resolve (symlink escape resistant)
  let realCwd = requested;
  try { realCwd = fs.realpathSync(requested); } catch {}

  if (mode === "full-access") return { ok: true, cwd: realCwd };

  // workspace/ask: cwd MUST be inside an allowed workspace root
  const rootsToCheck = new Set<string>([ctx.workspaceRoot || workspaceRoot, ...workspaceRoots, process.cwd()]);
  for (const r of rootsToCheck) {
    let realR = r;
    try { realR = fs.realpathSync(r); } catch { realR = path.resolve(r); }
    const rRel = path.relative(realR, realCwd);
    if (rRel === "" || (!rRel.startsWith("..") && !path.isAbsolute(rRel))) {
      return { ok: true, cwd: realCwd };
    }
  }

  return { ok: false, error: `cwd '${requested}' is outside the allowed workspace roots (sandbox: ${mode})` };
}

/**
 * Kill a child process AND its entire process group.
 * POSIX: the child is spawned with `detached: true` so it leads its own
 * process group; killing -pid takes down grandchildren (sleep, daemons, etc.).
 * Windows: falls back to `taskkill /PID <pid> /T /F`.
 */
function killProcessTree(childPid: number): void {
  const { spawn } = require("node:child_process");
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(childPid), "/T", "/F"], { stdio: "ignore", detached: true });
      return;
    }
    try {
      process.kill(-childPid, "SIGKILL");
    } catch {
      // Group may have already exited; best-effort single kill as fallback
      process.kill(childPid, "SIGKILL");
    }
  } catch {}
}

export async function toolBash(command: string, timeoutMs = 30000, execCtx?: ShellExecContext): Promise<ToolResult> {
  const { spawn } = require("node:child_process");
  const { buildSandboxedCommandLine } = require("./security/sandboxExecutor");
  const { scrubChildEnv } = require("./security/childEnv");
  const { getSandboxMode } = require("./permissions");
  const { classifyShellCommand } = require("./security/commandClassifier");

  // ── ABSOLUTE VETO FLOOR (Layer 4 Phase 1) ────────────────────────────────
  // CRITICAL_DENY commands are permanently blocked at the executor level.
  // This is NOT an approval gate: no sandbox mode, session trust, or
  // userApproved flag can override it. The SecurityEngine (via ToolGateway)
  // makes the policy decision; the executor enforces this non-negotiable floor.
  const vetoAnalysis = classifyShellCommand(
    command,
    execCtx?.workspaceRoot || workspaceRoot,
    execCtx?.cwd || currentCwd,
  );
  if (vetoAnalysis.riskLevel === "CRITICAL_DENY") {
    const { auditLogger } = require("./security/auditLogger");
    auditLogger.logEvent({
      timestamp: Date.now(),
      toolName: "shell",
      args: { command },
      riskLevel: "CRITICAL_DENY",
      category: "SHELL_EXECUTE",
      capability: "EXECUTE",
      mode: execCtx?.sandboxMode || getSandboxMode(),
      decision: "VETO",
      allowed: false,
      reason: vetoAnalysis.reason || "Catastrophic command blocked by executor veto floor",
    });
    return {
      success: false,
      error: `Permission Denied: ${vetoAnalysis.reason || "Catastrophic command blocked permanently."} (executor veto floor — not overridable)`,
      data: `Permission Denied: ${vetoAnalysis.reason || "Catastrophic command blocked permanently."}`,
      exitCode: 1,
    };
  }

  // Guard 1: resolve cwd from explicit context (never silently use module globals)
  const ctx: ShellExecContext = execCtx || {};
  const cwdRes = resolveShellExecCwd(ctx);
  if (!cwdRes.ok) {
    return { success: false, error: cwdRes.error, data: cwdRes.error, exitCode: 1 };
  }
  const execCwd = cwdRes.cwd;
  const wsRoot = ctx.workspaceRoot || workspaceRoot;
  const mode = ctx.sandboxMode || getSandboxMode();
  const outputCap = ctx.outputCapBytes || DEFAULT_SHELL_OUTPUT_CAP;

  // Inject a trap to capture the final PWD after the command executes
  const wrappedCommand = `set -e\n${command}\necho "---CWD---"\npwd`;
  const sandboxed = buildSandboxedCommandLine(wrappedCommand, {
    workspaceRoot: wsRoot,
    cwd: execCwd,
    sandboxMode: mode,
    toolName: "shell",
    isMutation: true,
  });

  // Check if sandbox denied execution
  if (sandboxed.denied) {
    const { auditLogger } = require("./security/auditLogger");
    auditLogger.logEvent({
      timestamp: Date.now(),
      toolName: "shell",
      args: { command },
      riskLevel: "DANGEROUS",
      category: "SHELL_EXECUTE",
      capability: "EXECUTE",
      mode,
      decision: "SANDBOX_BLOCK",
      allowed: false,
      cwd: execCwd,
      reason: sandboxed.reason || "OS sandbox unavailable; mutation blocked",
    });
    return {
      success: false,
      error: sandboxed.reason || "OS sandbox unavailable; mutation blocked",
      data: sandboxed.reason || "OS sandbox unavailable; mutation blocked",
      exitCode: 1,
    };
  }

  // Hardened child env: allowlist only, secrets dropped, explicit env policy-merged
  const childEnv = scrubChildEnv(process.env, ctx.env);

  return new Promise((resolve) => {
    // Spawn with detached:true so the child leads a process group we can kill as a tree.
    let child: any;
    try {
      child = spawn(sandboxed.executable, sandboxed.args, {
        cwd: execCwd,
        env: childEnv,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      const msg = `Sandbox execution error: ${err?.message || String(err)}`;
      return resolve({ success: false, error: msg, data: msg, exitCode: 1 });
    }

    let stdoutBuf = "";
    let stderrBuf = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutCapped = false;
    let stderrCapped = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killProcessTree(child.pid);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      if (child.stdout) child.stdout.removeAllListeners();
      if (child.stderr) child.stderr.removeAllListeners();
      child.removeAllListeners();
    };

    // STREAMING output bounds: cap bytes as they arrive, never buffer unbounded.
    const wireStream = (stream: any, isStdout: boolean) => {
      if (!stream) return;
      stream.on("data", (d: Buffer) => {
        if (isStdout) {
          if (stdoutBytes >= outputCap) { stdoutCapped = true; return; }
          const remaining = outputCap - stdoutBytes;
          const chunk = d.length > remaining ? d.subarray(0, remaining) : d;
          stdoutBytes += chunk.length;
          stdoutBuf += chunk.toString("utf8");
          if (chunk.length < d.length) stdoutCapped = true;
        } else {
          if (stderrBytes >= outputCap) { stderrCapped = true; return; }
          const remaining = outputCap - stderrBytes;
          const chunk = d.length > remaining ? d.subarray(0, remaining) : d;
          stderrBytes += chunk.length;
          stderrBuf += chunk.toString("utf8");
          if (chunk.length < d.length) stderrCapped = true;
        }
      });
    };
    wireStream(child.stdout, true);
    wireStream(child.stderr, false);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();

      let finalStdout = stdoutBuf;
      const cwdMarkerIdx = finalStdout.lastIndexOf("---CWD---");
      if (cwdMarkerIdx !== -1) {
        const afterMarker = finalStdout.substring(cwdMarkerIdx + 9).trim();
        const newCwd = afterMarker.split("\n")[0].trim();
        if (newCwd && newCwd.startsWith("/") && fs.existsSync(newCwd)) {
          // Only follow the child's cd if it stayed within workspace policy
          const check = resolveShellExecCwd({ ...ctx, cwd: newCwd });
          if (check.ok) currentCwd = check.cwd;
        }
        finalStdout = finalStdout.substring(0, cwdMarkerIdx).trim();
      }

      const capMarker = "\n... [output truncated at byte cap]";
      if (stdoutCapped) finalStdout += capMarker;
      let finalStderr = stderrBuf;
      if (stderrCapped) finalStderr += capMarker;

      const exitCode = timedOut ? 124 : (code ?? 0);
      const { data: stdoutData, truncated: stdoutTrunc } = truncateOutput(finalStdout);
      const { data: stderrData, truncated: stderrTrunc } = truncateOutput(finalStderr);

      if (exitCode !== 0 || timedOut) {
        const combined = [stderrData, stdoutData].filter(Boolean).join("\n").trim();
        resolve({
          success: false,
          error: combined || (timedOut ? "Command timed out" : `Exited with code ${exitCode}`),
          data: combined || (timedOut ? "Command timed out" : `Exited with code ${exitCode}`),
          stdout: stdoutData,
          stderr: stderrData,
          exitCode,
          truncated: stdoutTrunc || stderrTrunc || stdoutCapped || stderrCapped,
        });
      } else {
        const combined = [stderrData, stdoutData].filter(Boolean).join("\n").trim();
        resolve({
          success: true,
          data: combined || "(no output)",
          stdout: stdoutData,
          stderr: stderrData,
          exitCode: 0,
          truncated: stdoutTrunc || stderrTrunc || stdoutCapped || stderrCapped,
        });
      }
    };

    child.on("close", (code: number | null) => finish(code));

    child.on("error", (err: Error) => {
      if (settled) return;
      const msg = `Sandbox execution error: ${err.message}`;
      settled = true;
      cleanup();
      resolve({ success: false, error: msg, data: msg, exitCode: 1 });
    });
  });
}

export function toolGetCwd(): ToolResult {
  const { currentCwd, workspaceRoot, bypassPolicy } = getCwdInfo();
  return {
    success: true,
    data: JSON.stringify({ workspaceRoot, currentCwd, bypassPolicy }),
  };
}

export function toolListDir(dirPath = "."): ToolResult {
  try {
    const absPath = resolvePath(dirPath);
    const access = checkPathTraversal(dirPath, absPath, true);
    if (!access.allowed) return { success: false, error: access.error };
    if (!fs.existsSync(absPath)) return { success: false, error: `Directory not found: ${absPath}` };
    const stat = fs.statSync(absPath);
    if (!stat.isDirectory()) return { success: false, error: `Not a directory: ${absPath}` };

    const entries = fs.readdirSync(absPath, { withFileTypes: true });
    const formatted = entries.map((entry) => {
      const typeStr = entry.isDirectory() ? "[DIR]" : entry.isFile() ? "[FILE]" : "[OTHER]";
      return `${typeStr} ${entry.name}`;
    });
    return { success: true, data: formatted.join("\n") || "(empty directory)" };
  } catch (err: unknown) {
    return { success: false, error: `List directory error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function toolTree(dirPath = ".", maxDepth = 3): ToolResult {
  try {
    const absPath = resolvePath(dirPath);
    const access = checkPathTraversal(dirPath, absPath, true);
    if (!access.allowed) return { success: false, error: access.error };
    if (!fs.existsSync(absPath)) return { success: false, error: `Directory not found: ${absPath}` };
    const stat = fs.statSync(absPath);
    if (!stat.isDirectory()) return { success: false, error: `Not a directory: ${absPath}` };

    let result = "";
    let fileCount = 0;
    let dirCount = 0;

    function walk(currentPath: string, prefix: string, depth: number) {
      if (depth > maxDepth) return;
      
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentPath, { withFileTypes: true });
      } catch {
        return;
      }
      
      // Filter out node_modules and .git for cleaner trees
      entries = entries.filter(e => e.name !== "node_modules" && e.name !== ".git");
      
      entries.forEach((entry, index) => {
        const isLast = index === entries.length - 1;
        const marker = isLast ? "└── " : "├── ";
        const newPrefix = prefix + (isLast ? "    " : "│   ");
        
        result += `${prefix}${marker}${entry.name}\n`;
        
        if (entry.isDirectory()) {
          dirCount++;
          walk(path.join(currentPath, entry.name), newPrefix, depth + 1);
        } else {
          fileCount++;
        }
      });
    }

    result += path.basename(absPath) || dirPath + "\n";
    walk(absPath, "", 1);
    
    result += `\n${dirCount} directories, ${fileCount} files`;
    
    const { data, truncated } = truncateOutput(result);
    return { success: true, data, truncated };
  } catch (err: unknown) {
    return { success: false, error: `Tree error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function toolFileExists(filePath: string): ToolResult {
  try {
    const absPath = resolvePath(filePath);
    const exists = fs.existsSync(absPath);
    if (!exists) {
      return { success: true, data: JSON.stringify({ exists: false, path: absPath }) };
    }
    const stat = fs.statSync(absPath);
    const type = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
    return { success: true, data: JSON.stringify({ exists: true, type, path: absPath }) };
  } catch (err: unknown) {
    return { success: false, error: `File exists check error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function toolWebFetch(url: string): Promise<ToolResult & { _html?: string }> {
  try {
    if (!url) {
      return { success: false, error: `Invalid URL: empty` };
    }
    const { safeFetch, SafeFetchError } = await import("./security/safeFetch");
    const startTime = Date.now();
    let res;
    try {
      res = await safeFetch(url, {
        timeoutMs: 20000,
        maxHops: 3,
        allowLocalhost: false,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ToolNet-CLI/1.0; +https://toolnet.ai)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
      });
    } catch (err: any) {
      if (err instanceof SafeFetchError) {
        return { success: false, error: `Web fetch error (${err.code}): ${err.message}` };
      }
      const msg = redactSecrets(err?.message || String(err));
      return { success: false, error: `Web fetch error: ${msg}` };
    }
    const responseTimeMs = Date.now() - startTime;
    const finalUrl = res.url;
    const originalUrl = url;

    if (res.status < 200 || res.status >= 300) {
      return { success: false, error: `HTTP ${res.status} ${res.statusText} (${responseTimeMs}ms)\nURL: ${finalUrl}` };
    }

    const contentType = res.headers.get("content-type") || "";
    const html = res.body;
    const size = html.length;

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "(no title)";

    // Strip tags and get readable text (first ~2000 chars)
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .substring(0, 3000);

    const summary = [
      `URL: ${finalUrl}${finalUrl !== originalUrl ? ` (redirected from ${originalUrl} via ${res.hops} hops${res.crossOrigin ? ", cross-origin" : ""})` : ""}`,
      `Status: ${res.status} | Time: ${responseTimeMs}ms | Size: ${Math.round(size / 1024)}KB | HTTPS: ${originalUrl.startsWith("https://") ? "✓" : "✗"}`,
      `Content-Type: ${contentType}`,
      `Title: ${title}`,
      ``,
      `=== Page Text (first 3000 chars) ===`,
      text,
    ].join("\n");

    const { data, truncated } = truncateOutput(summary);

    // Store _html internally for toolAuditUrl to reuse
    const result: ToolResult & { _html?: string } = { success: true, data, truncated };
    result._html = html;
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Web fetch error: ${msg}` };
  }
}


export async function toolAuditUrl(url: string): Promise<ToolResult> {
  const fetchRes = await toolWebFetch(url);
  if (!fetchRes.success) return fetchRes;

  try {
    // Use raw HTML stored in _html (not the stripped text in data)
    const html = (fetchRes as any)._html || "";
    const isHttps = url.startsWith("https://");

    const extract = (regex: RegExp, group = 1) => {
      const m = html.match(regex);
      return m ? (m[group] || "").replace(/<[^>]+>/g, "").trim() : "";
    };
    const count = (regex: RegExp) => (html.match(regex) || []).length;

    const title = extract(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const metaDesc = extract(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,300})/i)
      || extract(/<meta[^>]+content=["']([^"']{0,300})["'][^>]+name=["']description["']/i);
    const canonical = extract(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)/i)
      || extract(/<link[^>]+href=["']([^"']*?)["'][^>]+rel=["']canonical["']/i);
    const robotsMeta = extract(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)/i);
    const viewport = extract(/<meta[^>]+name=["']viewport["'][^>]+content=["']([^"']*)/i);
    const ogTitle = extract(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)/i);
    const ogDesc = extract(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)/i);
    const ogImage = extract(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)/i);
    const twitterCard = extract(/<meta[^>]+name=["']twitter:card["'][^>]+content=["']([^"']*)/i);
    const h1 = count(/<h1[\s>]/gi);
    const h2 = count(/<h2[\s>]/gi);
    const imgTags = html.match(/<img[^>]*>/gi) || [];
    const imgCount = imgTags.length;
    const missingAlt = imgTags.filter((t: string) => !/\balt=["'][^"']/i.test(t)).length;

    // Parse status from first line of fetchRes.data
    const statusLine = (fetchRes.data || "").split("\n")[1] || "";
    const statusCode = statusLine.match(/Status:\s*(\d+)/)?.[1] || "200";
    const redirectLine = (fetchRes.data || "").split("\n")[0] || "";
    const hasRedirect = redirectLine.includes("redirected from");
    const redirectFrom = hasRedirect ? redirectLine.split("redirected from")[1]?.replace(")", "").trim() : "none";

    const report = [
      `=== URL Audit: ${url} ===`,
      ``,
      `HTTP Status    : ${statusCode}`,
      `HTTPS          : ${isHttps ? "✓ Yes" : "✗ No — not secure"}`,
      `Redirect       : ${hasRedirect ? `${redirectFrom} → ${url}` : "none"}`,
      ``,
      `Title          : ${title || "⚠ MISSING"}`,
      `Meta Desc      : ${metaDesc ? metaDesc.substring(0, 160) : "⚠ MISSING"}`,
      `Canonical      : ${canonical || "(not set)"}`,
      `Robots meta    : ${robotsMeta || "(not set)"}`,
      `Viewport       : ${viewport ? "✓ set" : "⚠ MISSING"}`,
      ``,
      `H1 count       : ${h1}${h1 !== 1 ? " ⚠ should be exactly 1" : " ✓"}`,
      `H2 count       : ${h2}`,
      `Images total   : ${imgCount}`,
      `Images no-alt  : ${missingAlt}${missingAlt > 0 ? " ⚠ accessibility issue" : " ✓"}`,
      `HTML size      : ${Math.round(html.length / 1024)}KB`,
      ``,
      `OpenGraph      : title="${ogTitle || "—"}" | desc="${(ogDesc || "—").substring(0, 80)}"`,
      `OG Image       : ${ogImage || "—"}`,
      `Twitter Card   : ${twitterCard || "—"}`,
    ].join("\n");

    return { success: true, data: report };
  } catch (err: unknown) {
    return { success: false, error: `Audit parse error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function toolGitStatus(dirPath?: string): Promise<ToolResult> {
  return toolBash(`git status --short`, 10000);
}

export async function toolGitDiff(filePath?: string, staged = false): Promise<ToolResult> {
  const fileArg = filePath ? ` -- "${filePath}"` : "";
  const stagedArg = staged ? " --staged" : "";
  return toolBash(`git diff${stagedArg}${fileArg}`, 15000);
}

export async function toolApplyPatch(patchText: string): Promise<ToolResult> {
  return applyStructuredPatch(patchText, currentCwd);
}
