/**
 * CLI argument disambiguation.
 *
 * `-s` is overloaded by history: bare `-s` has always meant the lightweight
 * REPL (`--simple`), while `--session <id>` opens a specific session and also
 * advertises `-s <id>` in help. The value form wins: `-s <id>` opens a session,
 * a bare `-s` (or `-s` followed by another flag) stays the REPL. This keeps both
 * documented behaviours working instead of silently routing `-s <id>` into the
 * REPL, which ignored the id.
 */
export function isSimpleMode(args: readonly string[]): boolean {
  if (args.includes("--simple")) return true;
  const index = args.indexOf("-s");
  if (index === -1) return false;
  const next = args[index + 1];
  return next === undefined || next.startsWith("-");
}
