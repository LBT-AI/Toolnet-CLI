import path from "node:path";
import type { RiskLevel } from "./types";
import { parseShellCommand, type ShellCommandNode, type ShellParseResult } from "./shellParser";
import { isPathInsideWorkspace } from "./workspacePolicy";

export interface CommandAnalysis {
  riskLevel: RiskLevel;
  isDangerous: boolean;
  isCritical: boolean;
  category: string;
  reason?: string;
  suggestedAction?: string;
  ast?: ShellParseResult;
}

const CRITICAL_EXECUTABLES = new Set([
  "mkfs", "mkswap", "fdisk", "parted", "wipefs", "dd", "shred",
  "sudo", "su", "doas", "pkexec", "shutdown", "reboot", "poweroff", "init", "telinit",
  "systemctl", "service", "iptables", "ufw", "nft", "insmod", "rmmod", "modprobe"
]);
const SENSITIVE_SYSTEM_PREFIXES = ["/etc", "/var", "/usr", "/bin", "/sbin", "/root", "/proc", "/sys", "/dev"];

/**
 * High-accuracy AST-driven Shell Command Classifier.
 * Analyzes parsed shell syntax trees, argument semantics, redirections,
 * subshells, and workspace boundaries without relying purely on literal string matching.
 */
export function classifyShellCommand(
  command: string,
  workspaceRoot?: string,
  cwd?: string
): CommandAnalysis {
  if (!command || !command.trim()) {
    return {
      riskLevel: "SAFE_READ",
      isDangerous: false,
      isCritical: false,
      category: "EMPTY",
    };
  }

  const rawTrimmed = command.trim();

  // 0. Fast check for raw syntax-level Fork Bomb attacks
  if (rawTrimmed.includes(":(){ :|:& };:") || rawTrimmed.includes(":(){ :|:&};:")) {
    return {
      riskLevel: "CRITICAL_DENY",
      isDangerous: true,
      isCritical: true,
      category: "SYSTEM_DESTRUCTION",
      reason: "Fork bomb resource exhaustion attack detected",
      suggestedAction: "Permanently blocked by security policy.",
    };
  }

  // 1. Parse Shell AST
  const ast = parseShellCommand(rawTrimmed);

  if (!ast.isValid) {
    return {
      riskLevel: "CRITICAL_DENY",
      isDangerous: true,
      isCritical: true,
      category: "MALFORMED_SHELL",
      reason: "Malformed or unparseable shell command syntax (Fail-Closed).",
      suggestedAction: "Command failed AST validation.",
      ast,
    };
  }

  // 2. Check for Piped arbitrary execution (e.g. curl | bash, wget | sh)
  if (ast.hasPipes) {
    const hasDownloader = ast.allExecutables.some((e) => e === "curl" || e === "wget" || e === "fetch");
    const hasShellSink = ast.allExecutables.some((e) => {
      if (["bash", "sh", "zsh", "eval"].includes(e)) return true;
      if (e === "xargs") {
        const xargsNode = ast.nodes.find((n) => n.executable === "xargs");
        return xargsNode ? xargsNode.args.some((a) => ["sh", "bash", "zsh", "-c"].includes(a)) : false;
      }
      return false;
    });
    if (hasDownloader && hasShellSink) {
      return {
        riskLevel: "CRITICAL_DENY",
        isDangerous: true,
        isCritical: true,
        category: "REMOTE_CODE_EXECUTION",
        reason: "Direct web-to-shell execution pipe (curl/wget | sh/bash)",
        suggestedAction: "Permanently blocked by security policy.",
        ast,
      };
    }

    const hasCriticalInPipe = ast.nodes.some((node) => {
      const allText = [node.raw, node.inlineScript, ...node.args, ...node.redirections.map((r) => r.target)].join(" ").toLowerCase();
      return /\brm\s+-[a-z]*r[a-z]*\s+\//.test(allText) ||
        /\brm\s+\/\*/.test(allText) ||
        /\brm\s+\/\.\*/.test(allText) ||
        /\brm\s+\.git/.test(allText) ||
        /\bdd\s+if=/.test(allText) ||
        /\bmkfs/.test(allText) ||
        /\b(shutdown|reboot|poweroff)\b/.test(allText);
    });
    if (hasShellSink && hasCriticalInPipe) {
      return {
        riskLevel: "CRITICAL_DENY",
        isDangerous: true,
        isCritical: true,
        category: "SYSTEM_DESTRUCTION",
        reason: "Piped command chain contains destructive system command (rm -rf /, dd, mkfs, shutdown)",
        suggestedAction: "Permanently blocked by security policy.",
        ast,
      };
    }
  }

  // 3. Inspect every AST Node
  for (const node of ast.nodes) {
    const nodeRisk = inspectCommandNode(node, workspaceRoot, cwd);
    if (nodeRisk) {
      return { ...nodeRisk, ast };
    }

    // Inspect nested sub-commands (e.g. inside subshells, bash -c)
    for (const sub of node.subCommands) {
      const subRisk = inspectCommandNode(sub, workspaceRoot, cwd);
      if (subRisk) {
        return { ...subRisk, ast };
      }
    }
  }

  // 4. Check Redirection Targets for Workspace Boundary Violation or System Files
  for (const target of ast.allRedirectTargets) {
    for (const sysPrefix of SENSITIVE_SYSTEM_PREFIXES) {
      if (target === sysPrefix || target.startsWith(sysPrefix + "/")) {
        return {
          riskLevel: "CRITICAL_DENY",
          isDangerous: true,
          isCritical: true,
          category: "SYSTEM_TAMPERING",
          reason: `Output redirection targets protected system directory '${target}'`,
          suggestedAction: "Permanently blocked by security policy.",
          ast,
        };
      }
    }

    if (workspaceRoot) {
      const pathCheck = isPathInsideWorkspace(target, workspaceRoot, cwd);
      if (!pathCheck.isInside) {
        const realTarget = pathCheck.resolvedPath || target;
        if (!realTarget.startsWith("/tmp/") && realTarget !== "/tmp") {
          return {
            riskLevel: "DANGEROUS",
            isDangerous: true,
            isCritical: false,
            category: "WORKSPACE_ESCAPE",
            reason: `Output redirection target '${target}' escapes workspace boundary`,
            suggestedAction: "Requires user confirmation before writing outside workspace.",
            ast,
          };
        }
      }
    }
  }

  // 5. Check if pure Safe Read-Only single command without side-effects
  if (
    !ast.hasPipes &&
    !ast.hasSubshells &&
    ast.allRedirectTargets.length === 0 &&
    ast.nodes.length === 1
  ) {
    const mainNode = ast.nodes[0];
    if (isSafeReadOnlyNode(mainNode)) {
      return {
        riskLevel: "SAFE_READ",
        isDangerous: false,
        isCritical: false,
        category: "READ_ONLY",
        ast,
      };
    }

    if (isSafeBuildNode(mainNode)) {
      return {
        riskLevel: "SAFE_BUILD",
        isDangerous: false,
        isCritical: false,
        category: "BUILD_AND_TEST",
        ast,
      };
    }
  }

  // 5. Interpreter inline execution (-c, -e) is inherently dynamic → DANGEROUS
  //    (unless already flagged as CRITICAL_DENY by subcommand inspection above)
  for (const node of ast.nodes) {
    if (node.isInterpreter && node.inlineScript) {
      const script = node.inlineScript.toLowerCase();
      const hasCriticalDestruction =
        /\brm\s+-[a-z]*r[a-z]*\s+\//.test(script) ||
        /\brm\s+\/\*/.test(script) ||
        /\brm\s+\/\.\*/.test(script) ||
        /\brm\s+\.git/.test(script) ||
        /\bdd\s+if=/.test(script) ||
        /\bmkfs/.test(script) ||
        /\b(shutdown|reboot|poweroff)\b/.test(script) ||
        /\brm\s+-[a-z]*r[a-z]*\s+~/.test(script) ||
        /\brm\s+\$HOME/.test(script);

      if (hasCriticalDestruction) {
        return {
          riskLevel: "CRITICAL_DENY",
          isDangerous: true,
          isCritical: true,
          category: "SYSTEM_DESTRUCTION",
          reason: `Interpreter inline execution contains destructive system command: "${node.inlineScript.slice(0, 60)}"`,
          suggestedAction: "Permanently blocked by security policy.",
          ast,
        };
      }

      return {
        riskLevel: "DANGEROUS",
        isDangerous: true,
        isCritical: false,
        category: "DYNAMIC_EVALUATION",
        reason: `Interpreter inline execution (${node.interpreterName || node.normalizedExecutable} -c/-e) executes dynamic code`,
        suggestedAction: "Requires explicit user confirmation.",
        ast,
      };
    }
  }

  // 6. Indeterminate variables in executable position -> Fail Closed to DANGEROUS
  if (ast.hasDynamicVariables) {
    return {
      riskLevel: "DANGEROUS",
      isDangerous: true,
      isCritical: false,
      category: "DYNAMIC_EVALUATION",
      reason: "Command uses dynamic shell variable expansion in executable or arguments (Fail-Closed).",
      suggestedAction: "Requires explicit user confirmation.",
      ast,
    };
  }

  // 7. Default: Moderate Write / Workspace Execution
  return {
    riskLevel: "MODERATE_WRITE",
    isDangerous: false,
    isCritical: false,
    category: "WORKSPACE_EXECUTION",
    ast,
  };
}

/**
 * Inspects an individual shell command AST node for destructive semantics.
 */
function inspectCommandNode(
  node: ShellCommandNode,
  workspaceRoot?: string,
  cwd?: string
): CommandAnalysis | null {
  const exec = node.normalizedExecutable;
  const args = node.args;

  // 0. eval — dynamic code execution
  if (exec === "eval") {
    return {
      riskLevel: "DANGEROUS",
      isDangerous: true,
      isCritical: false,
      category: "DYNAMIC_EVALUATION",
      reason: "eval dynamically executes shell code from strings/variables",
      suggestedAction: "Requires explicit user confirmation.",
    };
  }

  // 1. Critical Binary Check (sudo, su, mkfs, dd, shutdown)
  if (exec.startsWith("mkfs") || exec.startsWith("mkswap") || CRITICAL_EXECUTABLES.has(exec)) {
    return {
      riskLevel: "CRITICAL_DENY",
      isDangerous: true,
      isCritical: true,
      category: "PRIVILEGED_EXECUTION",
      reason: `Privileged/system-destructive executable '${exec}' is permanently blocked.`,
      suggestedAction: "Blocked by security sandbox policy.",
    };
  }

  // 1b. Wrapper commands (env, command, exec, nohup, nice, timeout)
  if (["env", "command", "exec", "nohup", "nice", "timeout"].includes(exec)) {
    let innerIdx = 0;
    if (exec === "timeout" && innerIdx < args.length && /^\d+[smhd]?$/.test(args[innerIdx])) {
      innerIdx++;
    }
    while (innerIdx < args.length && (args[innerIdx].startsWith("-") || args[innerIdx].includes("="))) {
      innerIdx++;
    }
    const innerExec = innerIdx < args.length ? args[innerIdx] : null;
    if (innerExec && CRITICAL_EXECUTABLES.has(innerExec)) {
      return {
        riskLevel: "CRITICAL_DENY",
        isDangerous: true,
        isCritical: true,
        category: "PRIVILEGED_EXECUTION",
        reason: `Wrapper '${exec}' invokes privileged executable '${innerExec}'`,
        suggestedAction: "Blocked by security sandbox policy.",
      };
    }
    if (innerExec === "rm" || innerExec === "rmdir" || innerExec === "unlink") {
      const rmArgs = args.slice(innerIdx + 1);
      const isRecursive = rmArgs.some((a) => a.startsWith("-") && (a.includes("r") || a.includes("R")));
      const hasForce = rmArgs.some((a) => a.startsWith("-") && a.includes("f"));
      for (const arg of rmArgs) {
        if (arg.startsWith("-")) continue;
        if (arg === "/" || arg === "/*" || arg === "/." || arg === "/.*" || arg === "~" || arg === "$HOME") {
          return {
            riskLevel: "CRITICAL_DENY",
            isDangerous: true,
            isCritical: true,
            category: "SYSTEM_DESTRUCTION",
            reason: `Wrapper '${exec}' invokes destructive removal of root/home ('${innerExec} ${arg}')`,
            suggestedAction: "Blocked permanently.",
          };
        }
      }
      if (isRecursive || hasForce) {
        return {
          riskLevel: "CRITICAL_DENY",
          isDangerous: true,
          isCritical: true,
          category: "SYSTEM_DESTRUCTION",
          reason: `Wrapper '${exec}' invokes recursive/force removal ('${innerExec} ${rmArgs.join(" ")}')`,
          suggestedAction: "Blocked permanently.",
        };
      }
    }
    return {
      riskLevel: "DANGEROUS",
      isDangerous: true,
      isCritical: false,
      category: "DYNAMIC_EVALUATION",
      reason: `Wrapper command '${exec}' obscures real execution target`,
      suggestedAction: "Requires explicit user confirmation.",
    };
  }

  // 1c. xargs with shell execution
  if (exec === "xargs") {
    const hasShell = args.some((a) => a === "sh" || a === "bash" || a === "zsh" || a === "-c");
    if (hasShell) {
      return {
        riskLevel: "DANGEROUS",
        isDangerous: true,
        isCritical: false,
        category: "DYNAMIC_EVALUATION",
        reason: "xargs pipes input to shell execution (sh/bash -c)",
        suggestedAction: "Requires explicit user confirmation.",
      };
    }
  }

  // 2. Destructive Filesystem Removal: rm / rmdir / unlink
  if (exec === "rm" || exec === "rmdir" || exec === "unlink") {
    const isRecursive = args.some((a) => a.startsWith("-") && (a.includes("r") || a.includes("R")));
    const hasForce = args.some((a) => a.startsWith("-") && a.includes("f"));

    for (const arg of args) {
      if (arg.startsWith("-")) continue;

      const normArg = arg.trim();

      // Root / System destruction
      if (normArg === "/" || normArg === "/*" || normArg === "/." || normArg === "/.*") {
        return {
          riskLevel: "CRITICAL_DENY",
          isDangerous: true,
          isCritical: true,
          category: "SYSTEM_DESTRUCTION",
          reason: `Root directory destruction ('${exec} ${normArg}')`,
          suggestedAction: "Blocked permanently.",
        };
      }

      // Home directory destruction
      if (normArg === "~" || normArg === "~/" || normArg === "$HOME" || normArg === "$HOME/") {
        return {
          riskLevel: "CRITICAL_DENY",
          isDangerous: true,
          isCritical: true,
          category: "SYSTEM_DESTRUCTION",
          reason: `Home directory destruction ('${exec} ${normArg}')`,
          suggestedAction: "Blocked permanently.",
        };
      }

      // Git repository history destruction
      if (normArg === ".git" || normArg === "./.git" || normArg.endsWith("/.git")) {
        return {
          riskLevel: "CRITICAL_DENY",
          isDangerous: true,
          isCritical: true,
          category: "SYSTEM_DESTRUCTION",
          reason: `Destruction of .git version control repository`,
          suggestedAction: "Blocked permanently.",
        };
      }

      // Wildcard mass deletion in root or project
      if (normArg === "*" || normArg === "./*" || normArg === ".*") {
        if (isRecursive || hasForce) {
          return {
            riskLevel: "CRITICAL_DENY",
            isDangerous: true,
            isCritical: true,
            category: "MASS_DESTRUCTION",
            reason: `Wildcard recursive file destruction ('${exec} ${args.join(" ")}')`,
            suggestedAction: "Blocked permanently.",
          };
        }
        return {
          riskLevel: "CRITICAL_DENY",
          isDangerous: true,
          isCritical: true,
          category: "MASS_DESTRUCTION",
          reason: `Wildcard file destruction ('${exec} ${args.join(" ")}')`,
          suggestedAction: "Blocked permanently.",
        };
      }

      // Wildcard file deletion e.g. rm *.ts
      if (normArg.includes("*") || normArg.includes("?")) {
        return {
          riskLevel: "DANGEROUS",
          isDangerous: true,
          isCritical: false,
          category: "WILDCARD_DELETION",
          reason: `Wildcard file deletion ('${exec} ${args.join(" ")}')`,
          suggestedAction: "Requires explicit user confirmation.",
        };
      }

      // Essential source directory removal
      if (isRecursive && /^(src|lib|app|components|routes|pages|models|controllers|tests|test)$/i.test(normArg)) {
        return {
          riskLevel: "DANGEROUS",
          isDangerous: true,
          isCritical: false,
          category: "DESTRUCTIVE_OPERATION",
          reason: `Recursive deletion of core source code directory '${normArg}'`,
          suggestedAction: "Requires explicit user confirmation.",
        };
      }

      // Target outside workspace
      if (workspaceRoot) {
        const check = isPathInsideWorkspace(normArg, workspaceRoot, cwd);
        if (!check.isInside) {
          return {
            riskLevel: "DANGEROUS",
            isDangerous: true,
            isCritical: false,
            category: "OUT_OF_WORKSPACE_DELETION",
            reason: `Deletion targets path outside workspace: '${check.resolvedPath}'`,
            suggestedAction: "Requires explicit user confirmation.",
          };
        }
      }
    }

    if (isRecursive) {
      return {
        riskLevel: "DANGEROUS",
        isDangerous: true,
        isCritical: false,
        category: "RECURSIVE_DELETION",
        reason: `Recursive removal command '${exec} ${args.join(" ")}'`,
        suggestedAction: "Requires explicit user confirmation.",
      };
    }
  }

  // 3. Destructive Find Commands (find / -delete, find . -exec rm ...)
  if (exec === "find") {
    const hasDelete = args.includes("-delete");
    const hasExecRm = args.some((a, idx) => (a === "-exec" || a === "-execdir") && args[idx + 1] === "rm");
    if (hasDelete || hasExecRm) {
      const targetsRootOrHome = args.some((a) => a === "/" || a === "/*" || a === "~" || a === "$HOME");
      if (targetsRootOrHome) {
        return {
          riskLevel: "CRITICAL_DENY",
          isDangerous: true,
          isCritical: true,
          category: "SYSTEM_DESTRUCTION",
          reason: `Find command with destructive deletion targeting root or home ('find ${args.join(" ")}')`,
          suggestedAction: "Blocked permanently.",
        };
      }
      return {
        riskLevel: "DANGEROUS",
        isDangerous: true,
        isCritical: false,
        category: "FIND_DELETION",
        reason: `Find command executes destructive file deletion ('find ${args.join(" ")}')`,
        suggestedAction: "Requires explicit user confirmation.",
      };
    }
  }

  // 4. Recursive Permission/Ownership Changes on Root or System
  if (exec === "chmod" || exec === "chown" || exec === "chgrp") {
    const isRecursive = args.some((a) => a.startsWith("-") && (a.includes("R") || a.includes("r")));
    if (isRecursive) {
      const targetsRoot = args.some((a) => a === "/" || a === "/*" || a === "~" || a === "$HOME" || a.startsWith("/etc") || a.startsWith("/var"));
      if (targetsRoot) {
        return {
          riskLevel: "CRITICAL_DENY",
          isDangerous: true,
          isCritical: true,
          category: "SYSTEM_TAMPERING",
          reason: `Recursive permission or ownership change targeting system or root ('${exec} ${args.join(" ")}')`,
          suggestedAction: "Blocked permanently.",
        };
      }
    }
  }

  // 5. Destructive Git Commands (reset --hard, clean -f, restore .)
  if (exec === "git") {
    const gitSub = args[0]?.toLowerCase();
    if (
      (gitSub === "reset" && args.includes("--hard")) ||
      (gitSub === "clean" && args.some((a) => a.startsWith("-") && a.includes("f"))) ||
      (gitSub === "restore" && (args.includes(".") || args.includes("*"))) ||
      (gitSub === "checkout" && (args.includes(".") || args.includes("*") || args.includes("-f")))
    ) {
      return {
        riskLevel: "DANGEROUS",
        isDangerous: true,
        isCritical: false,
        category: "GIT_DESTRUCTIVE",
        reason: `Git command wipes uncommitted working changes ('git ${args.join(" ")}')`,
        suggestedAction: "Requires explicit user confirmation.",
      };
    }
  }

  // 6. Reverse shell utilities (nc -e, ncat -e)
  if ((exec === "nc" || exec === "netcat" || exec === "ncat") && args.some((a) => a.includes("e"))) {
    return {
      riskLevel: "DANGEROUS",
      isDangerous: true,
      isCritical: false,
      category: "NETWORK_SHELL",
      reason: "Network reverse shell execution detected (nc/ncat -e)",
      suggestedAction: "Requires explicit user confirmation.",
    };
  }

  // 7. Python / Node / Perl inline script inspection
  if (node.isInterpreter && node.inlineScript) {
    const script = node.inlineScript.toLowerCase();
    const isCatastrophicScript =
      /\b(rmtree|unlink|remove|rmdir|rmsync|unlinksync)\s*\(\s*['"]?(\/|\/\*|~|\$home|\/etc|\/var|\.git)/i.test(script) ||
      /\b(os\.system|subprocess\.\w+|execsync|child_process\.\w+|system|exec)\s*\(\s*['"]?.*(rm\s+-[a-z]*r[a-z]*\s+(\/|~|\/\*|\.git))/i.test(script);

    if (isCatastrophicScript) {
      return {
        riskLevel: "CRITICAL_DENY",
        isDangerous: true,
        isCritical: true,
        category: "SYSTEM_DESTRUCTION",
        reason: `Inline interpreter script deletes root or system directories: "${node.inlineScript.slice(0, 40)}…"`,
        suggestedAction: "Blocked permanently.",
      };
    }
    const destructivePhrases = [
      "rmtree",
      "unlink",
      "os.system",
      "subprocess",
      "child_process",
      "execsync",
      "shutil",
      "require('fs')",
      "import os",
      "import shutil",
      "import subprocess",
    ];

    const hasDestructive = destructivePhrases.some((p) => script.includes(p));
    if (hasDestructive) {
      return {
        riskLevel: "DANGEROUS",
        isDangerous: true,
        isCritical: false,
        category: "INLINE_SCRIPT_EVALUATION",
        reason: `Interpreter inline script contains system/filesystem execution calls: "${node.inlineScript.slice(0, 40)}…"`,
        suggestedAction: "Requires explicit user confirmation.",
      };
    }
  }

  // 6. Process termination commands
  if (exec === "kill" || exec === "pkill" || exec === "killall") {
    return {
      riskLevel: "DANGEROUS",
      isDangerous: true,
      isCritical: false,
      category: "PROCESS_TERMINATION",
      reason: `Process termination command '${exec} ${args.join(" ")}'`,
      suggestedAction: "Requires explicit user confirmation.",
    };
  }

  // 7. Inspect paths in arguments for Protected System Directories or Traversals
  for (const arg of args) {
    if (arg.startsWith("-")) continue;

    // If argument is inside current workspace, allow it even if workspace is under /root or /var
    if (workspaceRoot) {
      const checkInside = isPathInsideWorkspace(arg, workspaceRoot, cwd);
      if (checkInside.isInside) {
        continue;
      }
    }

    for (const sysPrefix of SENSITIVE_SYSTEM_PREFIXES) {
      if (arg === sysPrefix || arg.startsWith(sysPrefix + "/")) {
        return {
          riskLevel: "DANGEROUS",
          isDangerous: true,
          isCritical: false,
          category: "SYSTEM_PATH_TARGET",
          reason: `Command argument references protected system directory '${arg}'`,
          suggestedAction: "Requires explicit user confirmation.",
        };
      }
    }

    if (arg.includes("../") || arg.includes("..\\")) {
      return {
        riskLevel: "DANGEROUS",
        isDangerous: true,
        isCritical: false,
        category: "PATH_TRAVERSAL",
        reason: `Command argument contains parent traversal path ('${arg}')`,
        suggestedAction: "Requires explicit user confirmation.",
      };
    }
  }

  return null;
}

const SAFE_READ_EXACT = new Set([
  "pwd", "ls", "dir", "cat", "head", "tail", "more", "less",
  "grep", "rg", "find", "tree", "wc", "echo", "printf",
  "which", "where", "type", "readlink", "uname", "whoami", "id",
  "date", "uptime", "df", "du", "ps", "printenv",
  "node", "bun", "npm", "python", "python3", "cargo", "go",
]);

function isSafeReadOnlyNode(node: ShellCommandNode): boolean {
  const exec = node.normalizedExecutable;
  const args = node.args;

  if (exec === "git") {
    const sub = args[0]?.toLowerCase();
    return sub === "status" || sub === "diff" || sub === "log" || sub === "show" || sub === "branch" || sub === "tag";
  }

  if (exec === "node" || exec === "bun" || exec === "npm" || exec === "python" || exec === "python3" || exec === "cargo" || exec === "go") {
    return args.includes("-v") || args.includes("--version") || args.includes("version");
  }

  return SAFE_READ_EXACT.has(exec);
}

function isSafeBuildNode(node: ShellCommandNode): boolean {
  const exec = node.normalizedExecutable;
  const args = node.args;

  if (exec === "bun" || exec === "npm" || exec === "pnpm" || exec === "yarn") {
    const sub = args[0]?.toLowerCase();
    return sub === "test" || sub === "run" || sub === "check" || sub === "typecheck" || sub === "build" || sub === "lint";
  }

  if (exec === "cargo" || exec === "go") {
    const sub = args[0]?.toLowerCase();
    return sub === "test" || sub === "check" || sub === "build";
  }

  if (exec === "tsc") {
    return args.includes("--noEmit") || args.length === 0;
  }

  if (exec === "pytest" || exec === "vitest" || exec === "jest") {
    return true;
  }

  return false;
}
