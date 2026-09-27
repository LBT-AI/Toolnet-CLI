/**
 * Canonical slash-command POLICY (single source).
 *
 * The command NAME/ALIASES/DESCRIPTION/USAGE already live on each `Command`
 * definition in `src/commands/*`. This module adds the orthogonal policy the
 * UI needs — category, busy policy, argument source, namespace subcommands —
 * WITHOUT duplicating the lists that help / autocomplete / parser / executor
 * already read from the registry.
 *
 * Every consumer (palette, help, busy gate, namespace picker, error hint)
 * reads from here so behavior cannot drift between surfaces.
 */

import { findCommand, getAllCommands } from "./index";

export type CommandCategory =
  | "Session"
  | "Model"
  | "MCP"
  | "Tools"
  | "Review"
  | "Settings"
  | "Agent"
  | "System";

/** Category display order for grouped listings. */
export const CATEGORY_ORDER: CommandCategory[] = [
  "Session",
  "Model",
  "MCP",
  "Tools",
  "Agent",
  "Review",
  "Settings",
  "System",
];

export interface CommandPolicy {
  category: CommandCategory;
  /**
   * Whether the command may run while the agent is BUSY (streaming or the
   * message queue is processing). Default is FALSE: unsafe commands are
   * refused with a clear reason instead of silently mutating runtime/session
   * state mid-turn.
   */
  allowedWhileBusy: boolean;
  /**
   * Where a missing argument should be completed from. Rendered as a picker by
   * the namespace/argument completion flow; data always comes from runtime.
   */
  argSource?: "model" | "session" | "mcp-server" | "skill";
}

const POLICY: Record<string, CommandPolicy> = {
  // Session
  session:      { category: "Session", allowedWhileBusy: false, argSource: "session" },
  history:      { category: "Session", allowedWhileBusy: true },
  queue:        { category: "Session", allowedWhileBusy: true },
  clear:        { category: "Session", allowedWhileBusy: false },
  reset:        { category: "Session", allowedWhileBusy: false },
  export:       { category: "Session", allowedWhileBusy: false },

  // Model
  model:        { category: "Model", allowedWhileBusy: false, argSource: "model" },
  catalog:      { category: "Model", allowedWhileBusy: true },
  provider:     { category: "Model", allowedWhileBusy: false },
  key:          { category: "Model", allowedWhileBusy: false },
  reasoning:    { category: "Model", allowedWhileBusy: false },

  // MCP
  mcp:          { category: "MCP", allowedWhileBusy: false, argSource: "mcp-server" },
  skills:       { category: "MCP", allowedWhileBusy: true, argSource: "skill" },

  // Tools
  tools:        { category: "Tools", allowedWhileBusy: true },
  harness:      { category: "Tools", allowedWhileBusy: true },
  subagent:     { category: "Tools", allowedWhileBusy: false },
  teamwork:     { category: "Tools", allowedWhileBusy: false },
  qa:           { category: "Tools", allowedWhileBusy: false },
  attach:       { category: "Tools", allowedWhileBusy: false },

  // Agent
  compact:      { category: "Agent", allowedWhileBusy: false },
  plan:         { category: "Agent", allowedWhileBusy: false },

  // Review
  artifact:     { category: "Review", allowedWhileBusy: true },
  undo:         { category: "Review", allowedWhileBusy: false },
  redo:         { category: "Review", allowedWhileBusy: false },
  search:       { category: "Review", allowedWhileBusy: true },

  // Settings
  config:       { category: "Settings", allowedWhileBusy: true },
  permissions:  { category: "Settings", allowedWhileBusy: true },
  policy:       { category: "Settings", allowedWhileBusy: true },
  sandbox:      { category: "Settings", allowedWhileBusy: true },
  jailbreak:    { category: "Settings", allowedWhileBusy: false },
  tui:          { category: "Settings", allowedWhileBusy: false },

  // System
  help:         { category: "System", allowedWhileBusy: true },
  status:       { category: "System", allowedWhileBusy: true },
  doctor:       { category: "System", allowedWhileBusy: true },
  update:       { category: "System", allowedWhileBusy: false },
  pwd:          { category: "System", allowedWhileBusy: true },
  workspace:    { category: "System", allowedWhileBusy: true },
  cd:           { category: "System", allowedWhileBusy: false },
  exit:         { category: "System", allowedWhileBusy: true },
};

const DEFAULT_POLICY: CommandPolicy = { category: "System", allowedWhileBusy: false };

/** Policy for a command by canonical name or alias (unknown → safe default). */
export function getCommandMeta(nameOrAlias: string): CommandPolicy {
  const key = (nameOrAlias || "").replace(/^\//, "").trim().toLowerCase();
  if (POLICY[key]) return POLICY[key];
  // Resolve an alias to its canonical name so alias and name share one policy.
  const found = findCommand("/" + key);
  if (found && POLICY[found.command.name]) return POLICY[found.command.name];
  return DEFAULT_POLICY;
}

export function isAllowedWhileBusy(nameOrAlias: string): boolean {
  return getCommandMeta(nameOrAlias).allowedWhileBusy;
}

/** First token of a slash input, without the leading slash. */
export function commandNameOf(input: string): string {
  return (input || "").trim().replace(/^\//, "").split(/\s+/)[0]?.toLowerCase() ?? "";
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

/**
 * Closest command for a mistyped one (`mpc` → `mcp`). Only returns a result
 * when the match is confident (prefix or edit distance ≤ 2), so we never
 * silently suggest an unrelated command.
 */
export function suggestClosestCommand(raw: string): string | undefined {
  const name = raw.replace(/^\//, "").trim().toLowerCase();
  if (!name) return undefined;
  const found = findCommand("/" + name);
  if (found) return undefined; // valid command already
  // Candidate set: canonical names + aliases. Very short aliases (e.g. `m`,
  // `st`) are excluded so a typo of a longer word never resolves to a one-letter
  // alias. Canonical names get a slight preference over aliases on a tie.
  const candidates: Array<{ token: string; isName: boolean }> = [];
  for (const cmd of getAllCommands()) {
    candidates.push({ token: cmd.name, isName: true });
    for (const alias of cmd.aliases) {
      if (alias.length >= 3) candidates.push({ token: alias, isName: false });
    }
  }
  let best: string | undefined;
  let bestScore = Infinity;
  for (const { token, isName } of candidates) {
    const penalty = isName ? 0 : 0.5;
    let score = Infinity;
    if (token.startsWith(name) || name.startsWith(token)) {
      score = Math.abs(token.length - name.length) + penalty;
    } else {
      const d = levenshtein(name, token);
      if (d <= 2) score = d + penalty;
    }
    if (score < bestScore) { bestScore = score; best = token; }
  }
  if (!best) return undefined;
  // Prefer the canonical command name over an alias.
  const canonical = findCommand("/" + best);
  return canonical ? canonical.command.name : best;
}

/** All (name, aliases) pairs that collide, for the inventory test. */
export function findAliasCollisions(): Array<{ token: string; owners: string[] }> {
  const owners = new Map<string, string[]>();
  for (const cmd of getAllCommands()) {
    for (const token of [cmd.name, ...cmd.aliases]) {
      const list = owners.get(token) ?? [];
      list.push(cmd.name);
      owners.set(token, list);
    }
  }
  const collisions: Array<{ token: string; owners: string[] }> = [];
  for (const [token, list] of owners) {
    if (list.length > 1) collisions.push({ token, owners: list });
  }
  return collisions;
}
