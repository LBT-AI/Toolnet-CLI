/**
 * `toolnet session` — durable session management.
 *
 * Formatting and argument parsing only. Every read, replay and write goes
 * through the canonical SessionStore, so the CLI can never invent a second
 * persistence path or bypass the checkpoint/lock rules.
 *
 * `resume` performs the REAL durable resume (workspace classification, lock
 * check, journal replay, interrupted marking) and reports what was
 * reconstructed. Opening the interactive session is the TUI entry's job — it
 * already accepts `--session <id>` — so the CLI prints that exact command
 * instead of re-implementing interactive boot.
 */

import {
  SessionError,
  sessionStore,
  normalizeWorkspaceIdentity,
  isValidSessionId,
  type SessionIndexEntry,
  type SessionStatus,
} from "../core/session";

export interface SessionCliIO {
  out: (line: string) => void;
  err: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

const defaultIO: SessionCliIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

function relativeTime(iso: string): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "unknown";
  const diff = Date.now() - time;
  if (diff < 5000) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(time).toLocaleDateString();
}

function statusBadge(status: SessionStatus): string {
  switch (status) {
    case "completed":
      return "completed";
    case "running":
      return "running";
    case "waiting_permission":
      return "waiting";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "idle";
  }
}

/**
 * Resolve a user-supplied reference: an exact id, or an unambiguous id prefix.
 * Ambiguity is reported rather than guessed.
 */
export function resolveSessionReference(
  reference: string,
  entries: SessionIndexEntry[] = sessionStore.list(),
): { id?: string; error?: string } {
  const target = String(reference ?? "").trim();
  if (!target) return { error: "no session id given" };
  const exact = entries.find((entry) => entry.id === target);
  if (exact) return { id: exact.id };
  const matches = entries.filter((entry) => entry.id.startsWith(target));
  if (matches.length === 1) return { id: matches[0].id };
  if (matches.length === 0) return { error: `session not found: ${target}` };
  return {
    error: `ambiguous session id "${target}" matches ${matches.length} sessions: ${matches
      .slice(0, 5)
      .map((m) => m.id)
      .join(", ")}`,
  };
}

function describeEntry(entry: SessionIndexEntry, activeId: string | null): string {
  const current = entry.id === activeId ? " (current)" : "";
  const title = entry.title ? ` "${entry.title}"` : "";
  const identity = [entry.provider, entry.model].filter(Boolean).join("/") || "no model";
  return [
    `  ${entry.id}${title}${current}`,
    `    status: ${statusBadge(entry.status)}  harness: ${entry.harness ?? "default"}  model: ${identity}`,
    `    workspace: ${entry.workspacePath}`,
    `    ${entry.messageCount} msgs · updated ${relativeTime(entry.updatedAt)}`,
  ].join("\n");
}

async function cmdList(io: SessionCliIO, args: string[]): Promise<number> {
  const json = args.includes("--json");
  const workspaceOnly = args.includes("--workspace") || args.includes("--here");
  const current = normalizeWorkspaceIdentity(process.cwd());
  const entries = workspaceOnly ? sessionStore.listForWorkspace(current) : sessionStore.list();
  const activeId = sessionStore.lastSessionId();

  if (json) {
    io.out(JSON.stringify({ sessions: entries }, null, 2));
    return 0;
  }
  if (entries.length === 0) {
    io.out(workspaceOnly ? "No sessions for this workspace." : "No saved sessions found.");
    return 0;
  }
  io.out(`Sessions (${entries.length})${workspaceOnly ? " · this workspace" : ""} — newest first`);
  io.out("─".repeat(60));
  for (const entry of entries) io.out(describeEntry(entry, activeId));
  return 0;
}

async function cmdShow(io: SessionCliIO, args: string[]): Promise<number> {
  const json = args.includes("--json");
  const reference = args.find((arg) => !arg.startsWith("-"));
  if (!reference) {
    io.err("Usage: toolnet session show <id>");
    return 1;
  }
  const resolved = resolveSessionReference(reference);
  if (!resolved.id) {
    io.err(resolved.error!);
    return 1;
  }
  const record = sessionStore.load(resolved.id);
  if (!record) {
    io.err(`session not found: ${resolved.id}`);
    return 1;
  }
  const checkpoint = sessionStore.latestCheckpoint(resolved.id);
  const lock = sessionStore.lockInfo(resolved.id);

  if (json) {
    io.out(
      JSON.stringify(
        {
          id: record.id,
          title: record.title,
          status: record.status,
          workspace: record.workspace,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          model: record.model,
          provider: record.provider,
          harness: record.harness,
          authProfileId: record.authProfileId,
          messages: record.messages.length,
          parentSessionId: record.parentSessionId,
          forkedFromCheckpointId: record.forkedFromCheckpointId,
          checkpointHead: checkpoint,
          lockedBy: lock?.pid,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  io.out(`Session ${record.id}`);
  io.out("─".repeat(60));
  if (record.title) io.out(`  Title:       ${record.title}`);
  io.out(`  Status:      ${statusBadge(record.status)}`);
  io.out(`  Workspace:   ${record.workspace.path}`);
  if (record.workspace.gitRoot && record.workspace.gitRoot !== record.workspace.path) {
    io.out(`  Git root:    ${record.workspace.gitRoot}`);
  }
  io.out(`  Messages:    ${record.messages.length}`);
  io.out(`  Model:       ${[record.provider, record.model].filter(Boolean).join("/") || "not recorded"}`);
  io.out(`  Harness:     ${record.harness ?? "default"}`);
  if (record.authProfileId) io.out(`  Auth:        ${record.authProfileId} (id only; credential resolved at call time)`);
  io.out(`  Created:     ${record.createdAt}`);
  io.out(`  Updated:     ${record.updatedAt} (${relativeTime(record.updatedAt)})`);
  if (record.parentSessionId) io.out(`  Forked from: ${record.parentSessionId}`);
  if (record.forkedFromCheckpointId) io.out(`  Checkpoint:  ${record.forkedFromCheckpointId}`);
  if (checkpoint) {
    io.out(`  Checkpoint:  ${checkpoint.checkpointId} (${checkpoint.reason}, seq ${checkpoint.eventSequence})`);
  }
  if (lock) io.out(`  Lock:        held by pid ${lock.pid} since ${new Date(lock.at).toISOString()}`);
  const children = sessionStore.childrenOf(record.id);
  if (children.length > 0) io.out(`  Forks:       ${children.join(", ")}`);
  return 0;
}

async function cmdResume(io: SessionCliIO, args: string[]): Promise<number> {
  const json = args.includes("--json");
  const dryRun = args.includes("--dry-run");
  const allowMismatch = args.includes("--allow-mismatch");
  const reference = args.find((arg) => !arg.startsWith("-"));
  if (!reference) {
    io.err("Usage: toolnet session resume <id> [--dry-run] [--allow-mismatch]");
    return 1;
  }
  const resolved = resolveSessionReference(reference);
  if (!resolved.id) {
    io.err(resolved.error!);
    return 1;
  }

  let resumed;
  try {
    resumed = sessionStore.resume(resolved.id, { allowWorkspaceMismatch: allowMismatch });
  } catch (error) {
    if (error instanceof SessionError) {
      io.err(`${error.code}: ${error.message}`);
      return 1;
    }
    throw error;
  }

  if (!dryRun) {
    // Persist the crash-recovery decision: an active run whose owner is gone is
    // interrupted, and that fact must survive the next process too.
    sessionStore.markInterrupted(resolved.id);
  }

  if (json) {
    io.out(
      JSON.stringify(
        {
          id: resumed.id,
          status: resumed.status,
          workspaceMatch: resumed.workspaceMatch,
          checkpoint: resumed.checkpointHead ?? null,
          identity: resumed.identity,
          evidence: resumed.evidence,
          interruptedTools: resumed.interruptedTools,
          replayedEvents: resumed.replayedEvents,
          messages: resumed.transcript.length,
          warnings: resumed.warnings,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  io.out(`Resumed ${resumed.id}${dryRun ? " (dry run)" : ""}`);
  io.out("─".repeat(60));
  io.out(`  Status:        ${statusBadge(resumed.status)}`);
  io.out(`  Workspace:     ${resumed.workspaceMatch}`);
  io.out(`  Messages:      ${resumed.transcript.length}`);
  io.out(`  Replayed:      ${resumed.replayedEvents} journal event(s)`);
  if (resumed.checkpointHead) {
    io.out(
      `  Checkpoint:    ${resumed.checkpointHead.checkpointId} (${resumed.checkpointHead.reason}, seq ${resumed.checkpointHead.eventSequence})`,
    );
  }
  io.out(`  Model:         ${[resumed.identity.provider, resumed.identity.model].filter(Boolean).join("/") || "not recorded"}`);
  io.out(`  Harness:       ${resumed.identity.harness ?? "default"}`);
  if (resumed.identity.authProfileId) io.out(`  Auth profile:  ${resumed.identity.authProfileId}`);
  io.out(
    `  Evidence:      ${resumed.evidence.toolCalls} tool call(s), ${resumed.evidence.filesChanged.length} file(s) changed, ${resumed.evidence.commandsRun} command(s), ${resumed.evidence.testsRun} test run(s)`,
  );

  if (resumed.interruptedTools.length > 0) {
    io.out("");
    io.out(`  Interrupted tool call(s) — outcome unknown, NOT replayed:`);
    for (const tool of resumed.interruptedTools) {
      io.out(`    · ${tool.name} (${tool.callId}) started ${new Date(tool.startedAt).toISOString()}`);
    }
  }
  for (const warning of resumed.warnings) io.out(`  ! ${warning}`);

  io.out("");
  io.out("Continue interactively with:");
  io.out(`  toolnet --session ${resumed.id}`);
  return 0;
}

async function cmdContinue(io: SessionCliIO, args: string[]): Promise<number> {
  const json = args.includes("--json");
  const resumed = sessionStore.continueForWorkspace();
  if (!resumed) {
    if (json) io.out(JSON.stringify({ session: null }, null, 2));
    else io.out("No session for this workspace — a new one will be started.");
    return 0;
  }
  if (json) {
    io.out(JSON.stringify({ session: resumed }, null, 2));
    return 0;
  }
  io.out(`Continuing most recent session for this workspace:`);
  io.out(describeEntry(resumed, sessionStore.lastSessionId()));
  io.out("");
  io.out(`  toolnet session resume ${resumed.id}`);
  return 0;
}

async function cmdFork(io: SessionCliIO, args: string[]): Promise<number> {
  const json = args.includes("--json");
  const titleIndex = args.indexOf("--title");
  const title = titleIndex !== -1 ? args[titleIndex + 1] : undefined;
  const reference = args.find((arg, index) => !arg.startsWith("-") && index !== titleIndex + 1);
  if (!reference) {
    io.err("Usage: toolnet session fork <id> [--title <name>]");
    return 1;
  }
  const resolved = resolveSessionReference(reference);
  if (!resolved.id) {
    io.err(resolved.error!);
    return 1;
  }
  try {
    const fork = sessionStore.fork(resolved.id, { ...(title ? { title } : {}) });
    if (json) {
      io.out(JSON.stringify({ id: fork.id, parentSessionId: fork.parentSessionId, forkedFromCheckpointId: fork.forkedFromCheckpointId }, null, 2));
    } else {
      io.out(`Forked ${resolved.id} → ${fork.id}`);
      io.out(`  from checkpoint: ${fork.forkedFromCheckpointId}`);
      io.out(`  source session was not modified`);
    }
    return 0;
  } catch (error) {
    if (error instanceof SessionError) {
      io.err(`${error.code}: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function cmdRename(io: SessionCliIO, args: string[]): Promise<number> {
  const reference = args[0];
  const title = args.slice(1).join(" ").trim();
  if (!reference || !title) {
    io.err("Usage: toolnet session rename <id> <title>");
    return 1;
  }
  const resolved = resolveSessionReference(reference);
  if (!resolved.id) {
    io.err(resolved.error!);
    return 1;
  }
  sessionStore.rename(resolved.id, title);
  io.out(`Renamed ${resolved.id} → "${title}"`);
  return 0;
}

async function cmdDelete(io: SessionCliIO, args: string[]): Promise<number> {
  const cascade = args.includes("--cascade");
  const reference = args.find((arg) => !arg.startsWith("-"));
  if (!reference) {
    io.err("Usage: toolnet session delete <id> [--cascade]");
    return 1;
  }
  const resolved = resolveSessionReference(reference);
  if (!resolved.id) {
    io.err(resolved.error!);
    return 1;
  }
  try {
    const { removed } = sessionStore.remove(resolved.id, { cascade });
    io.out(`Deleted ${removed.length} session(s): ${removed.join(", ")}`);
    return 0;
  } catch (error) {
    if (error instanceof SessionError) {
      io.err(`${error.code}: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function cmdDoctor(io: SessionCliIO, args: string[]): Promise<number> {
  const json = args.includes("--json");
  const report = sessionStore.doctor();
  if (json) {
    io.out(JSON.stringify(report, null, 2));
    return report.issues.some((issue) => issue.kind !== "stale-lock" && issue.kind !== "index-desync") ? 1 : 0;
  }
  io.out("Session doctor");
  io.out("─".repeat(60));
  io.out(`  Sessions dir:  ${report.sessionsDir}`);
  io.out(`  Sessions:      ${report.totalSessions}`);
  const indexLabel = !report.indexPresent ? "absent" : report.indexOk ? "ok" : "damaged";
  io.out(`  Index:         ${indexLabel}${report.indexRepaired ? " (rebuilt)" : ""}`);
  if (report.issues.length === 0) {
    io.out("  Issues:        none");
    return 0;
  }
  io.out(`  Issues:        ${report.issues.length}`);
  for (const issue of report.issues) {
    io.out(`    · [${issue.kind}] ${issue.sessionId}: ${issue.detail}`);
  }
  return 0;
}

const HELP = `ToolNet Session — durable sessions, checkpoints and resume

USAGE:
  toolnet session <subcommand>

SUBCOMMANDS:
  list [--json] [--workspace]   List saved sessions (newest first)
  current                       Show the active session
  show <id> [--json]            Show durable metadata for one session
  resume <id> [--dry-run]       Reconstruct a session and report it
  continue [--json]             Most recent session for this workspace
  fork <id> [--title <name>]    Fork a session from its latest checkpoint
  rename <id> <title>           Set a session title
  delete <id> [--cascade]       Delete a session (forks require --cascade)
  doctor [--json]               Read-only session diagnostics

  <id> may be an exact id or an unambiguous id prefix.`;

export async function runSessionCli(argv: string[], io: SessionCliIO = defaultIO): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    for (const line of HELP.split("\n")) io.out(line);
    return sub ? 0 : 1;
  }
  try {
    switch (sub) {
      case "list":
      case "ls":
        return await cmdList(io, rest);
      case "show":
      case "info":
        return await cmdShow(io, rest);
      case "current":
      case "curr": {
        const active = sessionStore.lastSessionId();
        if (!active) {
          io.out("No active session.");
          return 0;
        }
        return await cmdShow(io, [active, ...rest]);
      }
      case "resume":
        return await cmdResume(io, rest);
      case "continue":
        return await cmdContinue(io, rest);
      case "fork":
        return await cmdFork(io, rest);
      case "rename":
        return await cmdRename(io, rest);
      case "delete":
      case "rm":
        return await cmdDelete(io, rest);
      case "doctor":
        return await cmdDoctor(io, rest);
      default:
        io.err(`Unknown session subcommand: ${sub}`);
        io.err(`Try: list, show, resume, continue, fork, rename, delete, doctor`);
        return 1;
    }
  } catch (error) {
    if (error instanceof SessionError) {
      io.err(`${error.code}: ${error.message}`);
      return 1;
    }
    io.err(`session command failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** Kept for callers that validate an id before passing it on. */
export function requireValidSessionId(id: string): string {
  if (!isValidSessionId(id)) throw new SessionError("SESSION_INVALID_ID", `invalid session id: ${id}`, { sessionId: id });
  return id;
}
