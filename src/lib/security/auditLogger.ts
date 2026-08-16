import fs from "node:fs";
import path from "node:path";
import type { SecurityAuditEvent } from "./types";
import { redactSecrets } from "./secretGuard";

export class SecurityAuditLogger {
  private logFilePath: string;
  private enabled: boolean;

  constructor(customLogPath?: string) {
    const logsDir = path.resolve(process.cwd(), ".logs");
    this.logFilePath = customLogPath || path.join(logsDir, "security-audit.jsonl");
    this.enabled = true;
  }

  logEvent(event: SecurityAuditEvent) {
    if (!this.enabled) return;

    try {
      const dir = path.dirname(this.logFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const sanitizedEvent = {
        ...event,
        args: JSON.parse(redactSecrets(JSON.stringify(event.args || {}))),
        reason: redactSecrets(event.reason || ""),
      };

      const line = JSON.stringify(sanitizedEvent) + "\n";
      fs.appendFileSync(this.logFilePath, line, "utf-8");
    } catch {
      // Non-fatal if logging fails (e.g. read-only filesystem)
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
