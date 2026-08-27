import { test, it, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SecurityAuditLogger, GENESIS_HASH } from "../../lib/security/auditLogger";

function tmpDir(): string {
  const d = path.join(os.tmpdir(), "toolnet-audit-chain-test-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function cleanDir(d: string) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

describe("P4.14 & P4.15 — Tamper-Resistant Audit Log & Rotation", () => {
  let dir: string;
  let logFile: string;

  beforeEach(() => {
    dir = tmpDir();
    logFile = path.join(dir, "security-audit.jsonl");
  });

  afterEach(() => {
    cleanDir(dir);
  });

  it("27. audit hash chain is valid for consecutive logged entries", () => {
    const logger = new SecurityAuditLogger(logFile);

    logger.logEvent({
      action: "read_file",
      mode: "workspace",
      allowed: true,
      args: { path: "src/index.ts" },
    });

    logger.logEvent({
      action: "edit_file",
      mode: "workspace",
      allowed: true,
      args: { path: "src/index.ts", line: 10 },
    });

    logger.logEvent({
      action: "shell",
      mode: "ask",
      allowed: false,
      args: { command: "rm -rf /" },
      reason: "Critical destructive command blocked",
    });

    const verify = logger.verifyChain();
    expect(verify.valid).toBe(true);
    expect(verify.totalEntries).toBe(3);
    expect(verify.lastHash).toBeDefined();
    expect(verify.lastHash).not.toBe(GENESIS_HASH);
  });

  it("28. tampered audit entry is detected at the exact corrupted index", () => {
    const logger = new SecurityAuditLogger(logFile);

    logger.logEvent({ action: "read_file", mode: "workspace", allowed: true, args: { path: "a.txt" } });
    logger.logEvent({ action: "read_file", mode: "workspace", allowed: true, args: { path: "b.txt" } });
    logger.logEvent({ action: "read_file", mode: "workspace", allowed: true, args: { path: "c.txt" } });

    // Tamper with the 2nd entry (index 1)
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    const entry1 = JSON.parse(lines[1]);
    entry1.data.args.path = "tampered.txt"; // modify data
    lines[1] = JSON.stringify(entry1);
    fs.writeFileSync(logFile, lines.join("\n") + "\n");

    const verify = logger.verifyChain();
    expect(verify.valid).toBe(false);
    expect(verify.brokenIndex).toBe(1);
    expect(verify.reason).toContain("Hash mismatch");
  });

  it("29. rotation creates new log archive and resets chain", () => {
    const smallLimitLogger = new SecurityAuditLogger(logFile, 200); // small size limit

    // Write enough to trigger size rotation
    for (let i = 0; i < 5; i++) {
      smallLimitLogger.logEvent({
        action: "write_file",
        mode: "workspace",
        allowed: true,
        args: { path: `test_${i}.txt`, content: "some large content to exceed the small 200 byte limit for test" },
      });
    }

    const files = fs.readdirSync(dir);
    // At least one rotated log file should exist
    expect(files.some((f) => f.startsWith("security-audit-"))).toBe(true);
  });
});
