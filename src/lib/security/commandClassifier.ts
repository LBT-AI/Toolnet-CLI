import type { RiskLevel } from "./types";

export interface CommandAnalysis {
  riskLevel: RiskLevel;
  isDangerous: boolean;
  isCritical: boolean;
  category: string;
  reason?: string;
  suggestedAction?: string;
}

// Critical denial patterns (never permitted in workspace sandbox)
const CRITICAL_DENY_PATTERNS: Array<{ pattern: RegExp | string; reason: string }> = [
  { pattern: "rm -rf /", reason: "Root directory destruction (rm -rf /)" },
  { pattern: "rm -rf ~", reason: "Home directory destruction (rm -rf ~)" },
  { pattern: "rm -rf *", reason: "Wildcard recursive destruction of project directory (rm -rf *)" },
  { pattern: "rm -rf ./*", reason: "Wildcard recursive destruction of project directory (rm -rf ./*)" },
  { pattern: "rm -rf .*", reason: "Wildcard recursive destruction of project hidden files (rm -rf .*)" },
  { pattern: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(\.\/)?\.git(\/|\s|$)/i, reason: "Destruction of .git version control history (rm -rf .git)" },
  { pattern: ":(){ :|:& };:", reason: "Fork bomb resource exhaustion attack" },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/i, reason: "Filesystem format command (mkfs)" },
  { pattern: /\bdd\s+if=/i, reason: "Direct disk/block device write (dd)" },
  { pattern: /\b(chmod|chown)\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?(777|000|root)\s+\//i, reason: "Root filesystem permission tampering" },
  { pattern: /\b(shutdown|reboot|poweroff|init\s+0)\b/i, reason: "System shutdown/reboot command" },
  { pattern: /\|\s*(bash|sh|zsh|eval)\b/i, reason: "Piped arbitrary code execution (| bash/sh)" },
  { pattern: /\b(curl|wget)\b[^\n|]+\|\s*(bash|sh|zsh)\b/i, reason: "Direct web-to-shell execution (curl | bash)" },
  { pattern: /\b(sudo|su|doas)\b/i, reason: "Privileged superuser execution (sudo/su)" },
];

// Dangerous patterns requiring user confirmation in 'ask' mode
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Destructive git operations that wipe uncommitted work
  { pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*|restore\s+(\.|\*)|checkout\s+(\.|\*|-f))/i, reason: "Git command that wipes uncommitted working changes" },
  // Deletion of essential project source directories
  { pattern: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(src|lib|app|components|routes|pages|models|controllers|tests|test)\b/i, reason: "Destructive removal of essential project source code directory" },
  // Mass wildcard deletion in workspace
  { pattern: /\brm\s+(-[a-zA-Z]*\s+)?(\*|\*\.[a-zA-Z0-9]+)\b/i, reason: "Mass wildcard file deletion in workspace" },
  // Recursive directory deletion
  { pattern: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*/i, reason: "Recursive file/directory removal (rm -r)" },
  { pattern: /\brmdir\b/i, reason: "Directory removal (rmdir)" },
  // Process termination
  { pattern: /\b(kill|pkill|killall)\b/i, reason: "Process termination command" },
  // Network shells / Exfiltration
  { pattern: /\b(nc|ncat|netcat)\s+-[a-zA-Z]*e\b/i, reason: "Network reverse shell connection" },
  { pattern: /\bcurl\b[^\n]+(-d|--data)[^\n]*@\/(etc|root|var|home)/i, reason: "Potential sensitive file exfiltration via curl" },
  // Target system directories
  { pattern: /\b(cat|cp|mv|chmod|chown|touch)\s+[^\n]*\/(etc|var|usr|bin|sbin|root|proc|sys|dev)/i, reason: "Command targets protected system directory" },
  // Parent traversal in shell
  { pattern: /\.\.\//, reason: "Command references parent directory path (../)" },
  // Dynamic evaluation
  { pattern: /\b(eval|exec)\b\s+["'$]/i, reason: "Dynamic shell evaluation (eval/exec)" },
  { pattern: /\bbase64\s+(-d|--decode)\b/i, reason: "Encoded shell payload execution" },
];

// Safe read-only commands
const SAFE_READ_COMMANDS = new Set([
  "pwd", "ls", "dir", "cat", "head", "tail", "more", "less",
  "grep", "rg", "find", "tree", "wc", "echo", "printf",
  "git status", "git diff", "git log", "git show", "git branch", "git tag",
  "which", "where", "type", "command -v", "readlink", "uname", "whoami", "id",
  "date", "uptime", "df", "du", "ps", "env", "printenv",
  "node -v", "node --version", "bun -v", "bun --version", "npm -v", "npm --version",
  "python --version", "python3 --version", "cargo --version", "go version",
]);

// Safe build/test patterns
const SAFE_BUILD_PATTERNS = [
  /^(bun|npm|pnpm|yarn)\s+(test|run test)/,
  /^(bun|npm|pnpm|yarn)\s+(run\s+)?(build|typecheck|lint|check|compile)/,
  /^tsc(\s+--noEmit)?$/,
  /^(cargo|go)\s+(test|check|build)/,
  /^(pytest|python\s+-m\s+unittest|vitest|jest)/,
];

/**
 * Analyzes and classifies a shell command into a rigorous risk tier.
 */
export function classifyShellCommand(command: string): CommandAnalysis {
  if (!command || !command.trim()) {
    return {
      riskLevel: "SAFE_READ",
      isDangerous: false,
      isCritical: false,
      category: "EMPTY",
    };
  }

  const trimmed = command.trim();
  const normalized = trimmed.replace(/\s+/g, " ");

  // 1. Check Critical Deny
  for (const { pattern, reason } of CRITICAL_DENY_PATTERNS) {
    const isMatch = typeof pattern === "string" ? normalized.includes(pattern) : pattern.test(normalized);
    if (isMatch) {
      return {
        riskLevel: "CRITICAL_DENY",
        isDangerous: true,
        isCritical: true,
        category: "SYSTEM_DESTRUCTION",
        reason,
        suggestedAction: "Blocked permanently by security sandbox policy.",
      };
    }
  }

  // 2. Check Dangerous
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        riskLevel: "DANGEROUS",
        isDangerous: true,
        isCritical: false,
        category: "DANGEROUS_OPERATION",
        reason,
        suggestedAction: "Requires user explicit confirmation before execution.",
      };
    }
  }

  // 3. Check Safe Read-only exact matches or prefixes
  for (const safeCmd of SAFE_READ_COMMANDS) {
    if (normalized === safeCmd || normalized.startsWith(safeCmd + " ")) {
      // Ensure no sneaky pipes to dangerous commands
      if (!normalized.includes("|") && !normalized.includes(";") && !normalized.includes("&&") && !normalized.includes(">")) {
        return {
          riskLevel: "SAFE_READ",
          isDangerous: false,
          isCritical: false,
          category: "READ_ONLY",
        };
      }
    }
  }

  // 4. Check Safe Build/Test patterns
  for (const pattern of SAFE_BUILD_PATTERNS) {
    if (pattern.test(normalized)) {
      if (!normalized.includes("|") && !normalized.includes(";")) {
        return {
          riskLevel: "SAFE_BUILD",
          isDangerous: false,
          isCritical: false,
          category: "BUILD_AND_TEST",
        };
      }
    }
  }

  // 5. Default: Moderate Write / Custom execution
  return {
    riskLevel: "MODERATE_WRITE",
    isDangerous: false,
    isCritical: false,
    category: "WORKSPACE_EXECUTION",
  };
}
