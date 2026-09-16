/**
 * `toolnet health`, `toolnet logs`, `toolnet trace` — local diagnostic faces.
 *
 * Like `sessionCli`, this module is argument parsing and formatting only. It
 * reads the canonical observability modules (logger, trace store, health
 * snapshot) and never writes runtime state, so the CLI cannot become a second
 * owner of those stores.
 *
 * All output is local-only and already redacted at write time; nothing here
 * performs network I/O and no command bills an inference provider.
 */

import fs from "node:fs";
import { getLogFilePath, getLogsDir, LOG_MAX_BYTES, LOG_MAX_FILES } from "../lib/observability/logger";
import { getHealthSnapshot } from "../lib/observability/healthSnapshot";
import { traceStore } from "../lib/observability/trace";
import { redactSecret } from "../core/models/errors";
import { redactOutputSecrets } from "../lib/security/outputRedactor";

export interface ObservabilityCliIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIO: ObservabilityCliIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export const LOGS_HELP = `toolnet logs — structured local logs (local-only, redacted)

USAGE:
  toolnet logs [--level debug|info|warn|error] [--session <id>] [-n 50] [--json] [--follow]

OPTIONS:
  --level LEVEL   Only records at that level
  --session ID    Only records whose correlation carries that sessionId
  -n, --lines N   Last N records (default 50, max 500)
  --json          Print raw JSONL records
  --follow        Keep reading as new records are appended (Ctrl+C to stop)

Logs live under the ToolNet home (cap ${LOG_MAX_BYTES / 1024 / 1024}MiB per file, ${LOG_MAX_FILES} files).`;

export const TRACE_HELP = `toolnet trace — local span inspection (no collector required)

USAGE:
  toolnet trace [traceId] [--json] [-n 50]

Spans are bounded and in-memory: agent turns, model requests, provider
attempts, tool calls, compactions and verification runs.`;

const LEVELS = ["debug", "info", "warn", "error"] as const;

interface LogOptions {
  level?: string;
  session?: string;
  follow: boolean;
  json: boolean;
  count: number;
  help: boolean;
}

export function parseLogArgs(args: string[]): { options: LogOptions; error?: string } {
  const options: LogOptions = { follow: false, json: false, count: 50, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--follow" || arg === "-f") options.follow = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--level" && args[i + 1]) options.level = args[++i];
    else if (arg.startsWith("--level=")) options.level = arg.slice("--level=".length);
    else if (arg === "--session" && args[i + 1]) options.session = args[++i];
    else if (arg.startsWith("--session=")) options.session = arg.slice("--session=".length);
    else if ((arg === "-n" || arg === "--lines") && args[i + 1]) {
      const n = Number(args[++i]);
      if (!Number.isFinite(n)) return { options, error: `Invalid line count '${args[i]}'` };
      options.count = Math.max(1, Math.min(500, Math.floor(n)));
    } else if (!arg.startsWith("-")) return { options, error: `Unknown argument '${arg}'` };
    else return { options, error: `Unknown option '${arg}'` };
  }
  if (options.level && !LEVELS.includes(options.level.toLowerCase() as (typeof LEVELS)[number])) {
    return { options, error: `Unknown level '${options.level}'. Known: ${LEVELS.join(", ")}.` };
  }
  return { options };
}

/** Read the bounded tail of the log file; never loads an unbounded file into memory. */
function readTail(file: string, requested: number): string[] {
  const stat = fs.statSync(file);
  const perLine = 512;
  const window = Math.min(stat.size, Math.max(requested * perLine * 4, 64 * 1024));
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(window);
    const read = fs.readSync(fd, buffer, 0, window, stat.size - window);
    const text = buffer.subarray(0, read).toString("utf-8");
    const lines = text.split("\n").filter(Boolean);
    // A partial first line is possible when the window starts mid-record.
    if (stat.size > window) lines.shift();
    return lines.slice(-requested);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Records are redacted on write, but the reader re-applies the canonical
 * redactor anyway: a file written by an older build, a hand-edited file or a
 * record appended by another tool must not be able to spray a credential into
 * a terminal. Redaction is idempotent, so this costs nothing on healthy files.
 */
function redactForDisplay(line: string): string {
  return redactSecret(redactOutputSecrets(line));
}

export function formatLogRecord(line: string): string {
  try {
    const record = JSON.parse(line);
    const ts = record.timestamp ?? "";
    const level = String(record.level ?? "").toUpperCase().padEnd(5);
    const component = record.component ?? "";
    const event = record.event ?? "";
    const correlation = record.correlation?.sessionId ? ` sid=${record.correlation.sessionId}` : "";
    const duration = typeof record.durationMs === "number" ? ` ${record.durationMs}ms` : "";
    const outcome = record.outcome ? ` ${record.outcome}` : "";
    const detail = record.message ? ` ${record.message}` : record.error?.message ? ` error=${record.error.message}` : "";
    return redactForDisplay(`${ts} ${level} ${component}/${event}${correlation}${duration}${outcome}${detail}`);
  } catch {
    return redactForDisplay(line);
  }
}

function matchesFilter(line: string, options: LogOptions): boolean {
  try {
    const record = JSON.parse(line);
    if (options.level && String(record.level ?? "").toLowerCase() !== options.level.toLowerCase()) return false;
    if (options.session && String(record.correlation?.sessionId ?? "") !== options.session) return false;
    return true;
  } catch {
    return false;
  }
}

export async function runLogsCli(args: string[], io: ObservabilityCliIO = defaultIO): Promise<number> {
  const { options, error } = parseLogArgs(args);
  if (error) {
    io.err(error);
    io.err("");
    io.err(LOGS_HELP);
    return 2;
  }
  if (options.help) {
    io.out(LOGS_HELP);
    io.out(`Logs dir: ${getLogsDir()}`);
    return 0;
  }

  const file = getLogFilePath();
  if (!fs.existsSync(file)) {
    io.out(`No logs yet (${file}).`);
    return 0;
  }

  const emit = (lines: string[]) => {
    for (const line of lines) io.out(options.json ? redactForDisplay(line) : formatLogRecord(line));
  };

  emit(readTail(file, options.count).filter((line) => matchesFilter(line, options)));

  if (!options.follow) return 0;

  // `--follow` polls the bounded file rather than holding a read stream open:
  // rotation replaces the file, and a held descriptor would silently follow the
  // rotated-inode and stop reporting new records.
  let offset = fs.statSync(file).size;
  return await new Promise<number>((resolve) => {
    const stop = () => {
      clearInterval(timer);
      resolve(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const timer = setInterval(() => {
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        return;
      }
      if (size < offset) offset = 0; // rotated
      if (size === offset) return;
      try {
        const chunk = fs.readFileSync(file, "utf-8").slice(offset);
        offset = size;
        emit(chunk.split("\n").filter(Boolean).filter((line) => matchesFilter(line, options)));
      } catch {
        // A transient read failure must not kill the log viewer.
      }
    }, 400);
  });
}

export function runTraceCli(args: string[], io: ObservabilityCliIO = defaultIO): number {
  let traceId: string | undefined;
  let json = false;
  let count = 50;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      io.out(TRACE_HELP);
      return 0;
    }
    if (arg === "--json") json = true;
    else if ((arg === "-n" || arg === "--lines") && args[i + 1]) {
      const n = Number(args[++i]);
      if (!Number.isFinite(n)) {
        io.err(`Invalid line count '${args[i]}'`);
        return 2;
      }
      count = Math.max(1, Math.min(500, Math.floor(n)));
    } else if (!arg.startsWith("-") && !traceId) traceId = arg;
    else {
      io.err(`Unknown argument '${arg}'`);
      io.err("");
      io.err(TRACE_HELP);
      return 2;
    }
  }

  const spans = traceId ? traceStore.forTrace(traceId) : traceStore.snapshot({ limit: count });
  if (spans.length === 0) {
    io.out(traceId ? `No spans for traceId=${traceId}` : "No trace spans recorded yet.");
    return 0;
  }
  const slice = spans.slice(-count);
  if (json) {
    io.out(JSON.stringify(slice, null, 2));
    return 0;
  }
  for (const span of slice) {
    const duration = typeof span.durationMs === "number" ? `${span.durationMs}ms` : "running";
    const parent = span.parentSpanId ? ` parent=${span.parentSpanId}` : "";
    const error = span.errorCode ? ` error=${span.errorCode}` : "";
    io.out(
      `${span.kind.padEnd(16)} ${span.name}  trace=${span.traceId} span=${span.spanId}${parent}  ${duration}  ${span.status ?? "active"}${error}`,
    );
  }
  return 0;
}

export function runHealthCli(args: string[], io: ObservabilityCliIO = defaultIO): number {
  const snapshot = getHealthSnapshot();
  if (args.includes("--json")) {
    io.out(JSON.stringify(snapshot, null, 2));
    return 0;
  }
  if (args.includes("--help") || args.includes("-h")) {
    io.out(`toolnet health — read-only component health (no paid calls)

USAGE:
  toolnet health [--json]

Checks the session store, provider registry/health, model catalog and
observability logs. Unconfigured subsystems report 'unknown' rather than
probing the network.`);
    return 0;
  }
  io.out(`Health: ${snapshot.summary}  version=${snapshot.version}  at=${snapshot.at}`);
  for (const component of snapshot.components) {
    io.out(`  - ${component.component}: ${component.status}${component.detail ? ` — ${component.detail}` : ""}`);
  }
  return 0;
}
