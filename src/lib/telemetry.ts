import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getVersion, getPlatform } from "./version";
import { redactOutputSecrets } from "./security/outputRedactor";

export interface TelemetryConfig {
  enabled: boolean;
  anonymousId: string;
}

export interface CrashReportPayload {
  reportId: string;
  anonymousId: string;
  timestamp: string;
  version: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  errorCode?: string;
  sanitizedStack?: string;
}

function getTelemetryDir(): string {
  const base = process.env.DATA_DIR || path.join(os.homedir(), ".toolnet");
  return path.join(base, "telemetry");
}

function getConfigFile(): string {
  return path.join(getTelemetryDir(), "config.json");
}

function getCrashesDir(): string {
  return path.join(getTelemetryDir(), "crashes");
}

export function getTelemetryConfig(): TelemetryConfig {
  try {
    const file = getConfigFile();
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch {}
  return {
    enabled: false,
    anonymousId: `anon_${Math.random().toString(36).slice(2, 12)}`,
  };
}

export function setTelemetryEnabled(enabled: boolean): TelemetryConfig {
  const current = getTelemetryConfig();
  current.enabled = enabled;
  try {
    const dir = getTelemetryDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getConfigFile(), JSON.stringify(current, null, 2));
  } catch {}
  return current;
}

export function sanitizeStackTrace(stack?: string): string {
  if (!stack) return "";
  let sanitized = String(stack);

  // Replace home directory with ~
  const home = os.homedir();
  sanitized = sanitized.replaceAll(home, "~");

  // Redact any potential secrets in stack trace
  sanitized = redactOutputSecrets(sanitized);

  // Mask absolute unix/windows paths
  sanitized = sanitized.replace(/(?:\/[a-zA-Z0-9_.-]+)+/g, (match) => {
    if (match.includes("node_modules") || match.includes("toolnet-cli") || match.includes("dist")) {
      return match.replace(/.*?(toolnet-cli|dist)/, "$1");
    }
    return match;
  });

  return sanitized;
}

export function recordCrashReport(err: unknown, errorCode?: string): CrashReportPayload | null {
  const config = getTelemetryConfig();
  if (!config.enabled) {
    return null;
  }

  const { platform, arch } = getPlatform();
  const stack = err instanceof Error ? err.stack : String(err);
  const reportId = `crash_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const payload: CrashReportPayload = {
    reportId,
    anonymousId: config.anonymousId,
    timestamp: new Date().toISOString(),
    version: getVersion(),
    platform,
    arch,
    nodeVersion: process.version,
    errorCode: errorCode || (err instanceof Error ? err.name : "UNKNOWN_ERROR"),
    sanitizedStack: sanitizeStackTrace(stack),
  };

  try {
    const dir = getCrashesDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${reportId}.json`), JSON.stringify(payload, null, 2));
  } catch {}

  return payload;
}
