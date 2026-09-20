/**
 * Structured local logger — the ONE log writer for reliability/observability.
 *
 * - JSONL to ~/.toolnetcli/logs/toolnet.jsonl (bounded, rotated, retention).
 * - Never throws into callers; logging failure is always secondary.
 * - Secrets are redacted before any write via the canonical redactors.
 * - No user prompts, no network, default local-only.
 */
import fs from "node:fs";
import path from "node:path";
import { getToolnetLogsDir, ensureToolnetDir } from "../toolnetHome";
import { redactSecret } from "../../core/models/errors";
import { redactOutputSecrets } from "../security/outputRedactor";
import type { CorrelationContext } from "./correlation";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  component: string;
  event: string;
  message?: string;
  correlation?: CorrelationContext;
  durationMs?: number;
  outcome?: string;
  errorCode?: string;
  error?: { message: string; code?: string; status?: number };
  metadata?: Record<string, unknown>;
}

export const LOG_FILE_NAME = "toolnet.jsonl";
export const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB per file
export const LOG_MAX_FILES = 5; // toolnet.jsonl + 4 rotated
export const LOG_RETENTION_DAYS = 14;

function logsDir(): string {
  return getToolnetLogsDir();
}

function logFilePath(): string {
  return path.join(logsDir(), LOG_FILE_NAME);
}

function redactString(s: string): string {
  return redactSecret(redactOutputSecrets(s));
}

function sanitizeMetadata(input?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string") out[k] = redactString(v);
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else {
      try {
        out[k] = JSON.parse(redactString(JSON.stringify(v)));
      } catch {
        out[k] = "[unserializable]";
      }
    }
  }
  return out;
}

function maybeRotate(): void {
  try {
    const p = logFilePath();
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    if (st.size < LOG_MAX_BYTES) return;
    const dir = logsDir();
    // Shift older rotated files up, drop the oldest beyond LOG_MAX_FILES.
    for (let i = LOG_MAX_FILES - 1; i >= 1; i--) {
      const src = path.join(dir, i === 1 ? LOG_FILE_NAME : `toolnet.${i - 1}.jsonl`);
      const dst = path.join(dir, `toolnet.${i}.jsonl`);
      if (fs.existsSync(src)) {
        try { fs.renameSync(src, dst); } catch {}
      }
    }
    try { fs.renameSync(p, path.join(dir, "toolnet.1.jsonl")); } catch {}
  } catch {}
}

export function cleanOldLogs(retentionDays = LOG_RETENTION_DAYS): number {
  let deleted = 0;
  try {
    const dir = logsDir();
    if (!fs.existsSync(dir)) return 0;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!/^toolnet(\.\d+)?\.jsonl$/.test(name)) continue;
      if (name === LOG_FILE_NAME) continue;
      const fp = path.join(dir, name);
      try {
        const st = fs.statSync(fp);
        if (st.mtimeMs < cutoff) { fs.rmSync(fp, { force: true }); deleted++; }
      } catch {}
    }
  } catch {}
  return deleted;
}

export interface LoggerOptions {
  minLevel?: LogLevel;
  /** Disable file writes (tests, dry-run). In-memory buffer still collects when enabled. */
  fileEnabled?: boolean;
  /** In-memory ring for trace/log inspection without hitting disk. */
  bufferSize?: number;
}

export class StructuredLogger {
  private minLevel: LogLevel;
  private fileEnabled: boolean;
  private bufferSize: number;
  private ring: LogRecord[] = [];

  constructor(opts: LoggerOptions = {}) {
    this.minLevel = opts.minLevel ?? "debug";
    this.fileEnabled = opts.fileEnabled ?? true;
    this.bufferSize = opts.bufferSize ?? 500;
  }

  setMinLevel(level: LogLevel): void { this.minLevel = level; }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.minLevel];
  }

  log(record: Omit<LogRecord, "timestamp"> & { timestamp?: string }): void {
    try {
      const level = record.level;
      if (!this.shouldLog(level)) return;
      const rec: LogRecord = {
        timestamp: record.timestamp ?? new Date().toISOString(),
        level,
        component: String(record.component ?? "unknown"),
        event: String(record.event ?? "unknown"),
        ...(record.message ? { message: redactString(String(record.message)) } : {}),
        ...(record.correlation ? { correlation: record.correlation } : {}),
        ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
        ...(record.outcome ? { outcome: String(record.outcome) } : {}),
        ...(record.errorCode ? { errorCode: String(record.errorCode) } : {}),
        ...(record.error ? { error: { message: redactString(String(record.error.message ?? "")).slice(0, 2000), ...(record.error.code ? { code: String(record.error.code).slice(0, 80) } : {}), ...(record.error.status !== undefined ? { status: record.error.status } : {}) } } : {}),
        ...(record.metadata ? { metadata: sanitizeMetadata(record.metadata) } : {}),
      };
      // In-memory ring (bounded).
      this.ring.push(rec);
      if (this.ring.length > this.bufferSize) this.ring.shift();
      if (!this.fileEnabled) return;
      // Disk (best-effort).
      try {
        ensureToolnetDir(logsDir());
        maybeRotate();
        const line = JSON.stringify(rec) + "\n";
        try {
          const fd = fs.openSync(logFilePath(), "a", 0o600);
          try {
            fs.writeFileSync(fd, line, "utf-8");
          } finally {
            fs.closeSync(fd);
          }
        } catch {}
      } catch {}
    } catch {}
  }

  debug(component: string, event: string, fields: Omit<Partial<LogRecord>, "level" | "component" | "event"> = {}): void {
    this.log({ level: "debug", component, event, ...fields });
  }
  info(component: string, event: string, fields: Omit<Partial<LogRecord>, "level" | "component" | "event"> = {}): void {
    this.log({ level: "info", component, event, ...fields });
  }
  warn(component: string, event: string, fields: Omit<Partial<LogRecord>, "level" | "component" | "event"> = {}): void {
    this.log({ level: "warn", component, event, ...fields });
  }
  error(component: string, event: string, fields: Omit<Partial<LogRecord>, "level" | "component" | "event"> = {}): void {
    this.log({ level: "error", component, event, ...fields });
  }

  /** Snapshot of the in-memory ring (bounded, no disk read). */
  buffered(): LogRecord[] { return [...this.ring]; }
  clearBuffered(): void { this.ring = []; }
}

export function getLogsDir(): string { return logsDir(); }
export function getLogFilePath(): string { return logFilePath(); }

/** Process-wide canonical logger. Tests may construct their own with fileEnabled: false. */
export const logger = new StructuredLogger();
