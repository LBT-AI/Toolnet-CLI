import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { SecurityAuditEvent } from "./types";
import { redactOutputSecrets } from "./outputRedactor";
import { redactSecrets } from "./secretGuard";
import { getToolnetAuditDir } from "../toolnetHome";

export const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

function getDefaultAuditDir(): string {
  // Phase 3: canonical home (~/.toolnetcli/audit), legacy dir migrated by toolnetHome.
  return getToolnetAuditDir();
}

export interface AuditEntry {
  timestamp: string;
  event: string;
  data: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

export interface AuditVerificationResult {
  valid: boolean;
  totalEntries: number;
  brokenIndex?: number;
  reason?: string;
  lastHash?: string;
}

export function canonicalizeJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalizeJson).join(",") + "]";
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson((obj as Record<string, unknown>)[k])}`);
  return "{" + pairs.join(",") + "}";
}

export function computeAuditHash(previousHash: string, payload: { timestamp: string; event: string; data: Record<string, unknown> }): string {
  const canonical = canonicalizeJson(payload);
  return crypto.createHash("sha256").update(previousHash + canonical).digest("hex");
}

export class SecurityAuditLogger {
  private logFilePath: string;
  private logsDir: string;
  private enabled: boolean;
  private lastHash: string;
  private maxSizeBytes: number;

  constructor(customLogPath?: string, maxSizeBytes = 10 * 1024 * 1024) {
    this.logsDir = customLogPath ? path.dirname(customLogPath) : getDefaultAuditDir();
    this.logFilePath = customLogPath || path.join(this.logsDir, "security-audit.jsonl");
    this.enabled = true;
    this.maxSizeBytes = maxSizeBytes;
    this.lastHash = this.recoverLastHash();
  }

  private recoverLastHash(): string {
    try {
      if (fs.existsSync(this.logFilePath)) {
        const content = fs.readFileSync(this.logFilePath, "utf8").trim();
        if (content) {
          const lines = content.split("\n").filter(Boolean);
          if (lines.length > 0) {
            const lastLine = lines[lines.length - 1];
            const parsed = JSON.parse(lastLine);
            if (parsed.hash) return parsed.hash;
          }
        }
      }

      // Check rotated files to preserve continuity across rotations
      if (fs.existsSync(this.logsDir)) {
        const files = fs.readdirSync(this.logsDir)
          .filter((f) => f.startsWith("security-audit-") && f.endsWith(".jsonl"))
          .sort()
          .reverse();

        if (files.length > 0) {
          const latestRotated = path.join(this.logsDir, files[0]);
          const rotContent = fs.readFileSync(latestRotated, "utf8").trim();
          if (rotContent) {
            const lines = rotContent.split("\n").filter(Boolean);
            if (lines.length > 0) {
              const lastLine = lines[lines.length - 1];
              const parsed = JSON.parse(lastLine);
              if (parsed.hash) return parsed.hash;
            }
          }
        }
      }

      return GENESIS_HASH;
    } catch {
      return GENESIS_HASH;
    }
  }

  logEvent(event: SecurityAuditEvent) {
    if (!this.enabled) return;

    try {
      const dir = path.dirname(this.logFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      // Check size rotation
      if (fs.existsSync(this.logFilePath)) {
        const stat = fs.statSync(this.logFilePath);
        if (stat.size >= this.maxSizeBytes) {
          this.rotateNow();
        }
      }

      const timestamp = new Date().toISOString();
      const actionName = event.action || event.toolName || "unknown";
      const isAllowed = event.allowed !== undefined
        ? event.allowed
        : (event.decision === "ALLOWED" || event.decision === "APPROVED_BY_USER" || event.decision === "ALLOW" || event.decision === "APPROVED");
      const sanitizedArgs = JSON.parse(redactOutputSecrets(JSON.stringify(event.args || {})));
      const sanitizedReason = redactOutputSecrets(event.reason || "");

      const data: Record<string, unknown> = {
        action: actionName,
        allowed: isAllowed,
        decision: event.decision || (isAllowed ? "ALLOW" : "DENY"),
        riskLevel: event.riskLevel || "SAFE_READ",
        capability: event.capability || "READ",
        mode: event.mode,
        cwd: event.cwd || process.cwd(),
        args: sanitizedArgs,
        reason: sanitizedReason,
      };

      if (event.correlationId) {
        data.correlationId = event.correlationId;
      }

      if (event.metadata) {
        data.metadata = JSON.parse(redactOutputSecrets(JSON.stringify(event.metadata)));
      }

      const payload = {
        timestamp,
        event: actionName,
        data,
      };

      const previousHash = this.lastHash;
      const hash = computeAuditHash(previousHash, payload);

      const entry: AuditEntry = {
        timestamp,
        event: actionName,
        data,
        previousHash,
        hash,
      };

      this.lastHash = hash;
      const line = JSON.stringify(entry) + "\n";
      if (!fs.existsSync(this.logFilePath)) {
        fs.writeFileSync(this.logFilePath, line, { mode: 0o600, encoding: "utf-8" });
      } else {
        fs.appendFileSync(this.logFilePath, line, "utf-8");
      }
    } catch {
      // Non-fatal if logging fails
    }
  }

  rotateNow(): void {
    try {
      if (!fs.existsSync(this.logFilePath)) return;
      const dateStr = new Date().toISOString().slice(0, 10);
      const rotatedPath = path.join(this.logsDir, `security-audit-${dateStr}-${Date.now()}.jsonl`);
      fs.renameSync(this.logFilePath, rotatedPath);
      // Hash continuity: this.lastHash is preserved so the new file chains directly from the rotated file
    } catch {}
  }

  cleanOldLogs(retentionDays = 30): number {
    let deletedCount = 0;
    try {
      if (!fs.existsSync(this.logsDir)) return 0;
      const files = fs.readdirSync(this.logsDir);
      const now = Date.now();
      const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (file.startsWith("security-audit") && file.endsWith(".jsonl") && file !== "security-audit.jsonl") {
          const filePath = path.join(this.logsDir, file);
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > maxAgeMs) {
            fs.unlinkSync(filePath);
            deletedCount++;
          }
        }
      }
    } catch {}
    return deletedCount;
  }

  verifyChain(customFilePath?: string): AuditVerificationResult {
    const targetFile = customFilePath || this.logFilePath;
    if (!fs.existsSync(targetFile)) {
      return { valid: true, totalEntries: 0, lastHash: GENESIS_HASH };
    }

    try {
      const content = fs.readFileSync(targetFile, "utf8").trim();
      if (!content) {
        return { valid: true, totalEntries: 0, lastHash: GENESIS_HASH };
      }

      const lines = content.split("\n").filter(Boolean);
      let expectedPrevHash = GENESIS_HASH;

      for (let i = 0; i < lines.length; i++) {
        let entry: AuditEntry;
        try {
          entry = JSON.parse(lines[i]);
        } catch (e: any) {
          return { valid: false, totalEntries: lines.length, brokenIndex: i, reason: `Malformed JSON at line ${i + 1}: ${e.message}` };
        }

        if (entry.previousHash !== expectedPrevHash) {
          return {
            valid: false,
            totalEntries: lines.length,
            brokenIndex: i,
            reason: `Broken chain link at index ${i}: expected previousHash ${expectedPrevHash}, got ${entry.previousHash}`,
          };
        }

        const payload = {
          timestamp: entry.timestamp,
          event: entry.event,
          data: entry.data,
        };

        const recomputed = computeAuditHash(entry.previousHash, payload);
        if (recomputed !== entry.hash) {
          return {
            valid: false,
            totalEntries: lines.length,
            brokenIndex: i,
            reason: `Hash mismatch at index ${i}: stored ${entry.hash}, recomputed ${recomputed}`,
          };
        }

        expectedPrevHash = entry.hash;
      }

      return { valid: true, totalEntries: lines.length, lastHash: expectedPrevHash };
    } catch (err: any) {
      return { valid: false, totalEntries: 0, reason: `Verification error: ${err.message}` };
    }
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  getLogPath(): string {
    return this.logFilePath;
  }
}

export const auditLogger = new SecurityAuditLogger();
