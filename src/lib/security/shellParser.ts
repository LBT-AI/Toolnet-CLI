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
        // Multi-char operators: &&, ||, >>, 2>, &>
        if (
          (ch === "&" && command[i + 1] === "&") ||
          (ch === "|" && command[i + 1] === "|") ||
          (ch === ">" && command[i + 1] === ">")
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

const INTERPRETERS = new Set(["python", "python3", "node", "perl", "ruby", "sh", "bash", "zsh", "dash", "eval"]);

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
        hasDynamicVariables = true;
        hasNodeDynamic = true;
      }

      // Redirections: >, >>, <, 2>, etc.
      if (tok === ">" || tok === ">>" || tok === "<" || tok === "2>" || tok === "2>>" || tok === "&>") {
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
      const cFlagIdx = args.findIndex((a) => a === "-c" || a === "-e" || a === "--eval");
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
