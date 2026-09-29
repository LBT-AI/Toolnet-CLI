import path from "node:path";

/**
 * Robust Shell Command Tokenizer & AST Extractor.
 * Parses shell command pipelines, logical operators, subshells,
 * redirections, environment variables, quoted executables, and nested interpreters.
 *
 * Implements a Fail-Closed model: Any malformed or indeterminate shell construct
 * is flagged with isValid = false / isIndeterminate = true.
 */

export interface ShellRedirection {
  type: ">" | ">>" | "<" | "2>" | "2>>" | "&>" | ">&" | string;
  target: string;
}

export interface ShellCommandNode {
  raw: string;
  executable: string;
  normalizedExecutable: string;
  args: string[];
  envVars: Record<string, string>;
  redirections: ShellRedirection[];
  isSubshell: boolean;
  subCommands: ShellCommandNode[];
  isInterpreter: boolean;
  interpreterName?: string;
  inlineScript?: string;
  hasDynamicExpansion: boolean;
}

export interface ShellParseResult {
  isValid: boolean;
  isIndeterminate: boolean;
  nodes: ShellCommandNode[];
  allExecutables: string[];
  allRedirectTargets: string[];
  hasPipes: boolean;
  hasSubshells: boolean;
  hasDynamicVariables: boolean;
  syntaxError?: string;
}

/**
 * Removes outer quotes ('...', "...", $'...') and escape backslashes (\c)
 * from a shell token.
 */
export function unquoteShellToken(token: string): string {
  if (!token) return "";
  let s = token.trim();

  // Strip ANSI C-style quoting $'...'
  if (s.startsWith("$'") && s.endsWith("'") && s.length >= 3) {
    s = s.slice(2, -1);
  } else if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    s = s.slice(1, -1);
  }

  // Remove internal quote fragments: r''m -> rm, r""m -> rm
  s = s.replace(/['"]/g, "");

  // Remove backslash escapes: \r\m -> rm
  s = s.replace(/\\(.)/g, "$1");

  return s;
}

/**
 * Tokenizes a shell string respecting quotes, backslashes, and subshell parentheses.
 */
export function tokenizeShell(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let parenDepth = 0;
  let backtick = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const prev = i > 0 ? command[i - 1] : "";

    // Escape character inside double quotes or outside quotes
    if (ch === "\\" && !inSingle && prev !== "\\") {
      current += ch;
      continue;
    }

    if (ch === "'" && !inDouble && prev !== "\\") {
      inSingle = !inSingle;
      current += ch;
      continue;
    }

    if (ch === '"' && !inSingle && prev !== "\\") {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (ch === "`" && !inSingle && prev !== "\\") {
      backtick = !backtick;
      current += ch;
      continue;
    }

    if (!inSingle && !inDouble && !backtick) {
      if (ch === "(") {
        parenDepth++;
        current += ch;
        continue;
      }
      if (ch === ")") {
        parenDepth = Math.max(0, parenDepth - 1);
        current += ch;
        continue;
      }

      // Delimiters
      if (parenDepth === 0) {
        // Check 3-char operators: 2>>, 1>>, &>>
        if (
          (ch === "2" && command[i + 1] === ">" && command[i + 2] === ">") ||
          (ch === "1" && command[i + 1] === ">" && command[i + 2] === ">") ||
          (ch === "&" && command[i + 1] === ">" && command[i + 2] === ">") ||
          (ch === "2" && command[i + 1] === ">" && command[i + 2] === "&" && command[i + 3] === "1") // 2>&1
        ) {
          if (current.trim()) tokens.push(current.trim());
          if (ch === "2" && command[i + 2] === "&") {
            tokens.push("2>&1");
            i += 3;
          } else {
            tokens.push(ch + command[i + 1] + command[i + 2]);
            i += 2;
          }
          current = "";
          continue;
        }

        // Multi-char operators: &&, ||, >>, 2>, 1>, &>, >&
        if (
          (ch === "&" && command[i + 1] === "&") ||
          (ch === "|" && command[i + 1] === "|") ||
          (ch === ">" && command[i + 1] === ">") ||
          (ch === "2" && command[i + 1] === ">") ||
          (ch === "1" && command[i + 1] === ">") ||
          (ch === "&" && command[i + 1] === ">") ||
          (ch === ">" && command[i + 1] === "&")
        ) {
          if (current.trim()) tokens.push(current.trim());
          tokens.push(ch + command[i + 1]);
          current = "";
          i++;
          continue;
        }

        // Single-char operators: ;, |, &, >, <
        if (ch === ";" || ch === "|" || ch === "&" || ch === ">" || ch === "<") {
          if (current.trim()) tokens.push(current.trim());
          tokens.push(ch);
          current = "";
          continue;
        }

        // Whitespace delimiter
        if (/\s/.test(ch)) {
          if (current.trim()) {
            tokens.push(current.trim());
            current = "";
          }
          continue;
        }
      }
    }

    current += ch;
  }

  if (current.trim()) {
    tokens.push(current.trim());
  }

  return tokens;
}

const INTERPRETERS = new Set(["python", "python3", "node", "perl", "ruby", "php", "sh", "bash", "zsh", "dash", "eval"]);

/**
 * Inline-script flag for each interpreter (`-c`, `-e`, `-r`, `--eval`).
 * Single source of truth shared by the parser and the classifier so the
 * interpreter name → flag mapping can never drift between layers.
 */
export const INTERPRETER_INLINE_FLAGS: Record<string, string[]> = {
  python: ["-c"],
  python3: ["-c"],
  node: ["-e", "--eval"],
  perl: ["-e"],
  ruby: ["-e"],
  lua: ["-e"],
  php: ["-r"],
  sh: ["-c"],
  bash: ["-c"],
  zsh: ["-c"],
  dash: ["-c"],
  eval: ["-c", "-e", "--eval"], // eval is not flag-based; kept for lookup symmetry
};

export interface InlineScriptIntent {
  /** Script spawns subprocesses, shells out, or executes dynamic code. */
  spawnsProcesses: boolean;
  /** Script deletes files/directories (rmtree, unlink, fs.rmSync, …). */
  deletesPaths: boolean;
  /** Script writes files/paths or mutates state. */
  mutatesWorkspace: boolean;
  /** Destructive system mutation (root/home/​/etc/etc targets). */
  destructiveSystem: boolean;
  reason?: string;
}

// Patterns that spawn other processes from an inline script (word-boundary
// anchored where a bare substring would over-match, e.g. \bsystem\s*\( must not
// match "filesystem(").
const INLINE_SPAWN_PATTERNS: Array<string | RegExp> = [
  "os.system",
  "subprocess",
  "popen",
  "child_process",
  "execsync",
  "execfile",
  "spawnsync",
  "shellexec",
  "shell_exec",
  "passthru",
  "proc_open",
  /\bsystem\s*\(/, // php system(...)
  /\beval\s*\(/, // dynamic code execution from a string
];

// Patterns that delete paths.
const INLINE_DELETE_PATTERNS: Array<string | RegExp> = [
  "rmtree",
  "unlink", // covers unlinkSync
  "rmsync",
  "os.rmdir",
  /\brm\s+/, // shell-style rm inside the script ('rm x' — not 'farm ')
];

// Patterns that write/mutate files. Import/require of os/fs alone is NOT
// mutation — the specific mutating calls are what counts (keeps read-only
// inspection like `python -c 'import os; print(os.getcwd())'` usable).
const INLINE_MUTATE_PATTERNS: Array<string | RegExp> = [
  "file_put_contents",
  /\bfwrite\s*\(/,
  /\bftruncate\s*\(/,
  // Write-mode open: open("f","w"), fopen($f,"a"). Quotes are optional
  // because interpreter scripts are unquoted by the tokenizer — read mode
  // ("r") deliberately stays clean.
  /\bopen\s*\([^)]*,\s*['"]?[wax]\+?b?['"]?\s*[,)]/,
  /\bwritefilesync\b/,
  /\bwritefile\b/,
  /\bappendfile\b/,
  /\bmkdir[\s(]/,
  /\bmkfile\b/,
  /\btouch[\s(]/,
  "os.rename",
  "os.remove",
  "os.makedirs",
  "os.mkdir",
  "shutil", // copy/move/delete — any shutil use mutates the tree
  /\bfs\.\w*(write|append|rm|mkdir|mkdtemp|rmdir|truncate|chmod|chown|link|symlink|rename|copyfile|cp)/,
  /\.write_text\s*\(/,
  /\.write_bytes\s*\(/,
];

function matchesAny(patterns: Array<string | RegExp>, s: string): boolean {
  return patterns.some((p) => (typeof p === "string" ? s.includes(p) : p.test(s)));
}

/**
 * Shell-style output redirection inside the script (`> file`, `>> file`).
 * Must not match `=>` (arrow functions, PHP arrays) or `->` (PHP/JS deref).
 */
const INLINE_REDIRECT_PATTERN = /(?:^|[\s;])(>{1,2})\s*[^\s|&;]/;

/**
 * Classifies the intent/capabilities of an inline interpreter script
 * (php -r, python -c, node -e, bash -c …). Read-only inspection is safe;
 * workspace mutation is gated; process spawning / deletion / destructive
 * system mutation is flagged for deny or critical-deny upstream.
 */
export function inlineScriptIntent(script: string): InlineScriptIntent {
  const s = (script || "").toLowerCase();
  const intent: InlineScriptIntent = {
    spawnsProcesses: false,
    deletesPaths: false,
    mutatesWorkspace: false,
    destructiveSystem: false,
  };
  if (!s.trim()) return intent;

  // Pipeline `|` and command substitution (`$(...)`, backticks) move data
  // between processes — process-spawning regardless of the commands involved.
  // `||` (logical-or, ubiquitous in JS/PHP) must NOT match: the regex requires
  // a non-pipe char on at least one side of the single pipe.
  const pipesData = /(^|[^|])\|([^|]|$)/.test(s) || /\$\(/.test(s) || s.includes("`");

  intent.spawnsProcesses = pipesData || matchesAny(INLINE_SPAWN_PATTERNS, s);
  intent.deletesPaths = matchesAny(INLINE_DELETE_PATTERNS, s);
  intent.mutatesWorkspace =
    intent.deletesPaths || matchesAny(INLINE_MUTATE_PATTERNS, s) || INLINE_REDIRECT_PATTERN.test(script);

  // Destructive system mutation: deletion or shell-out targeting root/home/system.
  // Evaluated on structured intent flags, never on raw substring hope.
  const targetsSystem =
    /rm\s+-[a-z]*r[a-z]*\s+(\/|\/\*|~|\$home)(?=\s|$|[;&|)])/.test(s) ||
    /rmtree\s*\(\s*['"]?(\/|\/\*|~|\$home|\/etc|\/var)/.test(s) ||
    (intent.spawnsProcesses && /(rm\s+-[a-z]*r|mkfs|dd\s+if=|shutdown|reboot|poweroff)/.test(s));
  intent.destructiveSystem = intent.deletesPaths && targetsSystem;

  if (intent.destructiveSystem) {
    intent.reason = "inline script deletes root/home/system directories";
  } else if (intent.spawnsProcesses) {
    intent.reason = "inline script spawns subprocesses or shells out";
  } else if (intent.mutatesWorkspace) {
    intent.reason = "inline script writes/mutates files or paths";
  }
  return intent;
}

/**
 * Parses a stream of shell tokens into structured Command Nodes.
 */
export function parseShellCommand(commandStr: string): ShellParseResult {
  if (!commandStr || !commandStr.trim()) {
    return {
      isValid: true,
      isIndeterminate: false,
      nodes: [],
      allExecutables: [],
      allRedirectTargets: [],
      hasPipes: false,
      hasSubshells: false,
      hasDynamicVariables: false,
    };
  }

  const rawTokens = tokenizeShell(commandStr);
  const nodes: ShellCommandNode[] = [];
  const allExecutables: string[] = [];
  const allRedirectTargets: string[] = [];
  let hasPipes = false;
  let hasSubshells = false;
  let hasDynamicVariables = false;

  // Split tokens into individual command segments separated by ;, &&, ||, |, &
  const segments: string[][] = [];
  let currentSegment: string[] = [];

  for (const token of rawTokens) {
    if (token === "|" || token === "||" || token === "&&" || token === ";" || token === "&") {
      if (token === "|") hasPipes = true;
      if (currentSegment.length > 0) {
        segments.push(currentSegment);
        currentSegment = [];
      }
    } else {
      currentSegment.push(token);
    }
  }
  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  for (const seg of segments) {
    if (seg.length === 0) continue;

    let envVars: Record<string, string> = {};
    const redirections: ShellRedirection[] = [];
    const args: string[] = [];
    let executable = "";
    let isSubshell = false;
    let subCommands: ShellCommandNode[] = [];
    let hasNodeDynamic = false;
    const dynamicTokens: string[] = [];

    let idx = 0;

    // 1. Parse leading environment variable assignments (e.g. FOO=bar BAZ=1 cmd)
    while (idx < seg.length) {
      const tok = seg[idx];
      const envMatch = tok.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (envMatch && !executable) {
        envVars[envMatch[1]] = unquoteShellToken(envMatch[2]);
        idx++;
        continue;
      }
      break;
    }

    // 2. Parse executable and arguments/redirections
    while (idx < seg.length) {
      const tok = seg[idx];

      // Check subshell $(...) or `...` or (...)
      if (
        (tok.startsWith("$(") && tok.endsWith(")")) ||
        (tok.startsWith("`") && tok.endsWith("`")) ||
        (tok.startsWith("(") && tok.endsWith(")"))
      ) {
        hasSubshells = true;
        isSubshell = true;
        const innerCmd = tok.startsWith("$(")
          ? tok.slice(2, -1)
          : tok.startsWith("`")
          ? tok.slice(1, -1)
          : tok.slice(1, -1);
        const innerParsed = parseShellCommand(innerCmd);
        subCommands.push(...innerParsed.nodes);
        allExecutables.push(...innerParsed.allExecutables);
        allRedirectTargets.push(...innerParsed.allRedirectTargets);
      }

      // Check unresolved variable expansion e.g. $CMD or ${VAR}
      if (/\$[A-Za-z_]|\$\{[A-Za-z0-9_]+\}/.test(tok)) {
        dynamicTokens.push(tok);
        hasNodeDynamic = true;
      }

      // Redirections: >, >>, <, 2>, etc.
      if (
        tok === ">" || tok === ">>" || tok === "<" || 
        tok === "2>" || tok === "2>>" || tok === "&>" || 
        tok === "1>" || tok === "1>>" || tok === ">&" ||
        tok === "2>&1"
      ) {
        if (tok === "2>&1") {
          redirections.push({ type: "2>&1", target: "1" });
          idx++;
          continue;
        }
        const nextTok = seg[idx + 1];
        if (nextTok) {
          const targetClean = unquoteShellToken(nextTok);
          redirections.push({ type: tok, target: targetClean });
          allRedirectTargets.push(targetClean);
          idx += 2;
          continue;
        }
      }

      // Normal token
      if (!executable) {
        executable = tok;
      } else {
        args.push(tok);
      }

      idx++;
    }

    if (!executable && subCommands.length === 0) {
      continue;
    }

    const unquotedExec = unquoteShellToken(executable);
    // Extract base binary name: /bin/rm -> rm, ./node -> node
    const baseExec = path.basename(unquotedExec).toLowerCase();
    allExecutables.push(baseExec);

    // 3. Detect Interpreter inline execution (-c, -e)
    let isInterpreter = false;
    let interpreterName: string | undefined;
    let inlineScript: string | undefined;

    if (INTERPRETERS.has(baseExec)) {
      isInterpreter = true;
      interpreterName = baseExec;
      // Flag lookup comes from INTERPRETER_INLINE_FLAGS (single source of
      // truth shared with the classifier) so e.g. `php -r` is recognized
      // exactly once and can never drift between layers.
      const inlineFlags = INTERPRETER_INLINE_FLAGS[baseExec] || [];
      const cFlagIdx = args.findIndex((a) => inlineFlags.includes(a));
      if (cFlagIdx !== -1 && args[cFlagIdx + 1]) {
        inlineScript = unquoteShellToken(args[cFlagIdx + 1]);
        // Recursively inspect shell subcommands inside sh -c or bash -c
        if (baseExec === "sh" || baseExec === "bash" || baseExec === "zsh" || baseExec === "dash") {
          const nested = parseShellCommand(inlineScript);
          subCommands.push(...nested.nodes);
          allExecutables.push(...nested.allExecutables);
          allRedirectTargets.push(...nested.allRedirectTargets);
        }
      }
    }

    // Shell-variable expansion inside a NON-shell interpreter's inline script is
    // data handed to that interpreter, not shell-position expansion: in
    // `php -r 'echo $x;'` the `$x` is a PHP variable, never a shell variable.
    // Only shell interpreters (sh/bash/zsh/dash) expand `$VAR` inside `-c`, so
    // only they keep the fail-closed dynamic flag (TN-R0-007A).
    const shellInterpreter = ["sh", "bash", "zsh", "dash"].includes(baseExec);
    const dynamicOnlyInsideInlineScript =
      !shellInterpreter &&
      !!inlineScript &&
      dynamicTokens.length > 0 &&
      dynamicTokens.every((t) => unquoteShellToken(t) === inlineScript);
    if (dynamicTokens.length > 0 && !dynamicOnlyInsideInlineScript) {
      hasDynamicVariables = true;
    }
    if (dynamicOnlyInsideInlineScript) {
      hasNodeDynamic = false;
    }

    // 4. Unwrap command, env, nohup wrappers
    if ((baseExec === "command" || baseExec === "env" || baseExec === "nohup") && args.length > 0) {
      let innerIdx = 0;
      while (innerIdx < args.length && (args[innerIdx].startsWith("-") || args[innerIdx].includes("="))) {
        innerIdx++;
      }
      if (innerIdx < args.length) {
        const innerExecToken = args[innerIdx];
        const innerExecBase = path.basename(unquoteShellToken(innerExecToken)).toLowerCase();
        allExecutables.push(innerExecBase);
        const innerArgs = args.slice(innerIdx + 1);
        subCommands.push({
          raw: args.slice(innerIdx).join(" "),
          executable: innerExecToken,
          normalizedExecutable: innerExecBase,
          args: innerArgs.map(unquoteShellToken),
          envVars: {},
          redirections: [],
          isSubshell: false,
          subCommands: [],
          isInterpreter: INTERPRETERS.has(innerExecBase),
          hasDynamicExpansion: false,
        });
      }
    }

    nodes.push({
      raw: seg.join(" "),
      executable,
      normalizedExecutable: baseExec,
      args: args.map(unquoteShellToken),
      envVars,
      redirections,
      isSubshell,
      subCommands,
      isInterpreter,
      interpreterName,
      inlineScript,
      hasDynamicExpansion: hasNodeDynamic,
    });
  }

  return {
    isValid: true,
    isIndeterminate: hasDynamicVariables,
    nodes,
    allExecutables,
    allRedirectTargets,
    hasPipes,
    hasSubshells,
    hasDynamicVariables,
  };
}
