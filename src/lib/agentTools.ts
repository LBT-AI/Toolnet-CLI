import {
  toolBash,
  toolRead,
  toolWrite,
  toolEdit,
  toolReplaceAll,
  toolGrep,
  toolGlob,
  toolGetCwd,
  toolListDir,
  toolTree,
  toolFileExists,
  toolWebFetch,
  toolAuditUrl,
  toolFindPath,
  toolGitStatus,
  toolGitDiff,
  toolApplyPatch,
} from "./codingAgent";
import { resolve } from "node:path";
import { getMcpAgentTools as getMcpRunnerAgentTools, executeMcpTool } from "./mcpRunner";
import { evaluatePermission, getSandboxMode } from "./permissions";
import { executeBrowserTool } from "./browserTool";

export const agentTools = [
  // ── Workspace ──────────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "get_cwd",
      description: "Get active workspace root path and current working directory.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and subdirectories in a directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path to list (default: workspace root)" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "tree",
      description: "Show directory structure as a tree. Excellent for understanding project layout.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to view (default: workspace root)" },
          depth: { type: "number", description: "Max depth (default 3)" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read content of a file. Use offset/limit to paginate large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read" },
          offset: { type: "number", description: "Line offset to start from (0-indexed)" },
          limit: { type: "number", description: "Max lines to read (default 500)" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write or overwrite content to a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to write" },
          content: { type: "string", description: "Full file content to write" }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace an exact string in a file with a new string (first occurrence).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to edit" },
          old_string: { type: "string", description: "Exact string to find and replace" },
          new_string: { type: "string", description: "Replacement string" }
        },
        required: ["path", "old_string", "new_string"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "replace_all",
      description: "Replace ALL occurrences of a string in a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to modify" },
          old_string: { type: "string", description: "Target string to replace" },
          new_string: { type: "string", description: "Replacement string" }
        },
        required: ["path", "old_string", "new_string"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "file_exists",
      description: "Check if a file or directory exists and get its type.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to check" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Apply a structured unified diff patch to target file(s) in the workspace. Fully undoable via /undo.",
      parameters: {
        type: "object",
        properties: {
          patch: { type: "string", description: "Unified diff / patch text (e.g. --- a/file +++ b/file @@ ... @@)" }
        },
        required: ["patch"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Show working directory git status (modified, untracked, staged files).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory or file path (optional)" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Show git diff for workspace or specific file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to inspect (optional)" },
          staged: { type: "boolean", description: "Set true to inspect staged changes (--staged)" }
        },
        required: []
      }
    }
  },
  // ── Search ─────────────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "find_path",
      description: "Find files or directories by name using shell find. PREFERRED for: 'tìm thư mục X', 'tìm file X', 'find X', 'where is X', 'locate X'. More reliable than glob for directory searches.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name to search for (partial match, case-insensitive)" },
          root: { type: "string", description: "Root directory to search from (default: workspace root, use '/' for system-wide)" },
          maxDepth: { type: "number", description: "Max depth (default: 6)" },
          type: { type: "string", description: "'file', 'dir', or omit for any" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search for text/regex pattern recursively across files.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex or text to search for" },
          path: { type: "string", description: "Directory or file to search in (default: workspace root)" },
          include: { type: "string", description: "File filter e.g. '*.ts'" }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files by glob pattern (e.g. '*.ts', 'src/**/*.js'). Use find_path for finding directories by name.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern" },
          path: { type: "string", description: "Directory to search from (default: workspace root)" }
        },
        required: ["pattern"]
      }
    }
  },
  // ── Shell ──────────────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "shell",
      description: "Run a bash shell command. Use for: npm/bun commands, git, system info, installing packages, running tests, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Bash command to run" }
        },
        required: ["command"]
      }
    }
  },
  // ── Web ────────────────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a URL and return readable text content: title, HTTP status, response time, and page text (first 3000 chars).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute URL (http:// or https://)" }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser",
      description: "Real Chromium/Playwright browser automation for JS-heavy web pages. Supports navigating, executing JS, clicking elements, filling forms, taking screenshots, and inspecting web UI.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "Action to perform: 'navigate' (default), 'screenshot', 'click', 'fill', 'evaluate', 'content'" },
          url: { type: "string", description: "URL to navigate to (http:// or https://)" },
          selector: { type: "string", description: "CSS selector for click or fill action" },
          text: { type: "string", description: "Text content to fill into input selector" },
          script: { type: "string", description: "JavaScript code to execute on page (for action='evaluate')" },
          path: { type: "string", description: "File path for screenshot output" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_artifact",
      description: "Create an artifact in the .artifacts directory.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the artifact" },
          content: { type: "string", description: "Content of the artifact" }
        },
        required: ["name", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "audit_url",
      description: "Audit a URL for SEO/health: HTTP status, HTTPS, title, meta description, canonical, h1/h2 count, images, OpenGraph, Twitter Card, response time.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute URL to audit" }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_artifact",
      description: "Update an existing artifact in the .artifacts directory.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the artifact" },
          content: { type: "string", description: "New content of the artifact" }
        },
        required: ["name", "content"]
      }
    }
  }
];

export function getMcpAgentTools(): Array<any> {
  return getMcpRunnerAgentTools();
}

export function getMergedAgentTools(): Array<any> {
  return [...agentTools, ...getMcpAgentTools()];
}

export function isDangerousCommand(name: string, args: any, cwd: string): boolean {
  const perm = evaluatePermission(name, args, getSandboxMode(), cwd);
  return perm.needsApproval || !perm.allowed;
}


export async function executeTool(name: string, args: any): Promise<string> {
  try {
    const perm = evaluatePermission(name, args, getSandboxMode());
    if (!perm.allowed) {
      return JSON.stringify({
        stdout: "",
        stderr: perm.reason || "Permission denied by sandbox policy.",
        exitCode: 1
      });
    }

    if (name === "get_cwd") {
      const res = toolGetCwd();
      return JSON.stringify({
        stdout: res.data || "",
        stderr: res.error || "",
        exitCode: res.success ? 0 : 1
      });
    } else if (name === "list_dir") {
      const dirPath = args.path || ".";
      const res = toolListDir(dirPath);
      return JSON.stringify({
        stdout: res.data || "",
        stderr: res.error || "",
        exitCode: res.success ? 0 : 1
      });
    } else if (name === "file_exists") {
      const filePath = args.path || ".";
      const res = toolFileExists(filePath);
      return JSON.stringify({
        stdout: res.data || "",
        stderr: res.error || "",
        exitCode: res.success ? 0 : 1
      });
    } else if (name === "find_path") {
      const res = toolFindPath(args.query, args.root, args.maxDepth, args.type);
      return JSON.stringify({
        stdout: res.data || "",
        stderr: res.error || "",
        exitCode: res.success ? 0 : 1
      });
    } else if (name === "run_command" || name === "shell") {
      const cmd = args.command || args.cmd || "";
      const res = await toolBash(cmd, 30000);
      return JSON.stringify({
        stdout: res.stdout || "",
        stderr: res.stderr || "",
        exitCode: res.exitCode
      });
    } else if (name === "tree") {
      const res = toolTree(args.path, args.depth);
      return JSON.stringify({
        stdout: res.data || "",
        stderr: res.error || "",
        exitCode: res.success ? 0 : 1
      });
    } else if (name === "read_file") {
      const res = toolRead(args.path, args.offset || 0, args.limit || 500);
      return JSON.stringify({
        stdout: res.data || "",
        stderr: res.error || "",
        exitCode: res.success ? 0 : 1
      });
    } else if (name === "write_file") {
      const res = toolWrite(args.path, args.content);
      return JSON.stringify({
        stdout: res.data || "",
        stderr: res.error || "",
        exitCode: res.success ? 0 : 1
      });
    } else if (name === "edit_file") {
      const oldStr = args.old_string || args.oldString || "";
      const newStr = args.new_string || args.newString || "";
      const res = toolEdit(args.path, oldStr, newStr);
      return JSON.stringify({
        stdout: res.data || "",
        stderr: res.error || "",
        exitCode: res.success ? 0 : 1
      });
    } else if (name === "replace_all") {
      const oldStr = args.old_string || args.oldString || "";
      const newStr = args.new_string || args.newString || "";
      const res = toolReplaceAll(args.path, oldStr, newStr);
      return JSON.stringify({
        stdout: res.data || "",
        stderr: res.error || "",
        exitCode: res.success ? 0 : 1
      });
    } else if (name === "apply_patch" || name === "patch") {
      const patchText = args.patch || args.diff || "";
      const res = await toolApplyPatch(patchText);
      return JSON.stringify({
        stdout: res.data || "",
        stderr: res.error || "",
        exitCode: res.success ? 0 : 1
      });
    } else if (name === "git_status") {
      const res = await toolGitStatus(args.path);
      return JSON.stringify({
        stdout: res.stdout || res.data || "",
        stderr: res.stderr || res.error || "",
        exitCode: res.exitCode ?? (res.success ? 0 : 1)
      });
    } else if (name === "git_diff") {
      const res = await toolGitDiff(args.path, Boolean(args.staged));
      return JSON.stringify({
        stdout: res.stdout || res.data || "",
        stderr: res.stderr || res.error || "",
        exitCode: res.exitCode ?? (res.success ? 0 : 1)
      });
    } else if (name === "grep" || name === "grep_search") {
      const searchPath = args.path || ".";
      const res = toolGrep(args.pattern, searchPath, args.include);
      return JSON.stringify({
        stdout: res.data || "",
        stderr: res.error || "",
        exitCode: res.success ? 0 : 1
      });
    } else if (name === "glob" || name === "glob_search") {
      const searchPath = args.path || ".";
      const res = toolGlob(args.pattern, searchPath);
      return JSON.stringify({
        stdout: res.data || "",
        stderr: res.error || "",
        exitCode: res.success ? 0 : 1
      });
    } else if (name === "web_fetch" || name === "web_crawl" || name === "fetch") {
      const url = args.url || args.link || "";
      const res = await toolWebFetch(url);
      return JSON.stringify({
        stdout: res.data || "",
        stderr: res.error || "",
        exitCode: res.success ? 0 : 1
      });
    } else if (name === "browser" || name === "browser_action" || name === "playwright") {
      const res = await executeBrowserTool(args);
      return JSON.stringify({
        stdout: res.data || "",
        stderr: res.error || "",
        exitCode: res.success ? 0 : 1
      });
    } else if (name === "audit_url" || name === "audit") {
      const url = args.url || args.link || "";
      const res = await toolAuditUrl(url);
      return JSON.stringify({
        stdout: res.data || "",
        stderr: res.error || "",
        exitCode: res.success ? 0 : 1
      });
    } else if (name === "create_artifact" || name === "update_artifact") {
      const artifactName = args.name || "";
      const content = args.content || "";
      if (!artifactName) {
        return JSON.stringify({ stdout: "", stderr: "Missing artifact name", exitCode: 1 });
      }
      const targetPath = `.artifacts/${artifactName}`;
      const res = toolWrite(targetPath, content);
      return JSON.stringify({
        stdout: res.success ? `Artifact ${name === "create_artifact" ? "created" : "updated"}: ${artifactName}` : "",
        stderr: res.error || "",
        exitCode: res.success ? 0 : 1
      });
    } else {
      const mcpResult = await executeMcpTool(name, args);
      if (mcpResult !== null) {
        return mcpResult;
      }
      return JSON.stringify({ stdout: "", stderr: `Unknown tool: ${name}`, exitCode: 1 });
    }
  } catch (e: any) {
    return JSON.stringify({ stdout: "", stderr: `Error executing tool: ${e.message}`, exitCode: 1 });
  }
}
