import fs from "node:fs";
import path from "node:path";
import { pushSnapshot, commitSnapshot } from "./history";
import { evaluatePermission, isPathInsideWorkspace, getSandboxMode } from "./permissions";
import { applyStructuredPatch } from "./patchUtils";

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
export let bypassPolicy = false;

export function initWorkspace(customPath?: string) {
  let targetPath = customPath;

  if (!targetPath) {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if ((arg === "--cwd" || arg === "--workspace") && i + 1 < args.length) {
        targetPath = args[i + 1];
        break;
      } else if (arg.startsWith("--cwd=") || arg.startsWith("--workspace=")) {
        targetPath = arg.split("=")[1];
        break;
      } else if (arg === "-p" || arg === "--prompt" || arg === "-m" || arg === "--model" || arg === "--session") {
        i++;
        continue;
      } else if (!arg.startsWith("-")) {
        targetPath = arg;
        break;
      }
    }
  }

  if (targetPath) {
    const abs = path.resolve(process.cwd(), targetPath);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      workspaceRoot = abs;
      currentCwd = abs;
      try {
        process.chdir(abs);
      } catch {}
    } else {
      console.warn(`Warning: Workspace directory does not exist or is not a directory: ${targetPath}`);
      workspaceRoot = process.cwd();
      currentCwd = process.cwd();
    }
  } else {
    workspaceRoot = process.cwd();
    currentCwd = process.cwd();
  }
}

export function setBypassPolicy(enabled: boolean) {
  bypassPolicy = enabled;
}

export function getCwdInfo() {
  const isFullAccess = getSandboxMode() === "full-access";
  return { currentCwd, workspaceRoot, bypassPolicy: bypassPolicy || isFullAccess };
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
  if (bypassPolicy) return { allowed: true };
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
    return { success: true, data: `Edited ${path.relative(currentCwd, absPath)}: replaced "${oldString}" → "${newString}"` };
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
    return { success: true, data: `Replaced ${count} occurrence(s) in ${path.relative(currentCwd, absPath)}` };
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
    pushSnapshot(absPath, `write: ${path.basename(absPath)}`);
    fs.writeFileSync(absPath, content, "utf8");
    commitSnapshot(absPath);
    return { success: true, data: `Written ${content.length} bytes to ${path.relative(currentCwd, absPath)}` };
  } catch (err: unknown) {
    return { success: false, error: `Write error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function toolBash(command: string, timeoutMs = 30000): Promise<ToolResult> {
  const { exec } = require("node:child_process");
  return new Promise((resolve) => {
    // Inject a trap to capture the final PWD after the command executes
    const wrappedCommand = `${command}\necho "---CWD---"\npwd`;
    
    exec(wrappedCommand, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      cwd: workspaceRoot,
    }, (error: any, stdout: string, stderr: string) => {
      let finalStdout = stdout || "";
      const cwdMarkerIdx = finalStdout.lastIndexOf("---CWD---");
      
      if (cwdMarkerIdx !== -1) {
        const afterMarker = finalStdout.substring(cwdMarkerIdx + 9).trim();
        const newCwd = afterMarker.split("\n")[0].trim();
        if (newCwd && newCwd.startsWith("/")) {
          if (fs.existsSync(newCwd)) {
            currentCwd = newCwd; // Sync the agent's virtual CWD with the bash session
          }
        }
        finalStdout = finalStdout.substring(0, cwdMarkerIdx).trim();
      }

      const exitCode = error ? (error.code ?? 1) : 0;
      const { data: stdoutData, truncated: stdoutTrunc } = truncateOutput(finalStdout);
      const { data: stderrData, truncated: stderrTrunc } = truncateOutput(stderr || "");
      
      if (error) {
        const combined = [stderrData, stdoutData].filter(Boolean).join("\\n").trim();
        resolve({
          success: false,
          error: combined || error.message,
          data: combined || error.message,
          stdout: stdoutData,
          stderr: stderrData,
          exitCode,
          truncated: stdoutTrunc || stderrTrunc
        });
      } else {
        const data = stdoutData.trim() || "(no output)";
        resolve({
          success: true,
          data,
          stdout: stdoutData,
          stderr: stderrData,
          exitCode,
          truncated: stdoutTrunc || stderrTrunc
        });
      }
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
    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
      return { success: false, error: `Invalid URL: '${url}'. Must start with http:// or https://` };
    }
    const startTime = Date.now();
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ToolNet-CLI/1.0; +https://toolnet.ai)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      signal: AbortSignal.timeout(20000),
      redirect: "follow",
    });
    const responseTimeMs = Date.now() - startTime;
    const finalUrl = res.url;

    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status} ${res.statusText} (${responseTimeMs}ms)\nURL: ${finalUrl}` };
    }

    const contentType = res.headers.get("content-type") || "";
    const html = await res.text();
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
      `URL: ${finalUrl}${finalUrl !== url ? ` (redirected from ${url})` : ""}`,
      `Status: ${res.status} | Time: ${responseTimeMs}ms | Size: ${Math.round(size / 1024)}KB | HTTPS: ${url.startsWith("https://") ? "✓" : "✗"}`,
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
