/**
 * Diagnostics command for ToolNet CLI.
 *
 * Runs local checks and reports environment status.
 * Never prints API keys or secrets.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getVersion, getPlatform, getVersionString } from "./version";
import { detectInstallMethod } from "./installMethod";
import { getAppConfigPath, getConfigDir, loadAppConfig } from "./appConfig";
import { getSessionsDir } from "./sessionPersistence";
import { getBudgetConfig } from "./usage";

export interface DiagnosticResult {
  name: string;
  status: "ok" | "warn" | "error";
  value: string;
}

export interface DoctorReport {
  version: string;
  platform: string;
  arch: string;
  installMethod: string;
  configPath: string;
  sessionsDir: string;
  gatewayUrl: string | null;
  defaultModel: string;
  sandboxMode: string;
  budgetUsd: number | null;
  checks: DiagnosticResult[];
  json: boolean;
}

export function runDoctor(): DoctorReport {
  const { platform, arch } = getPlatform();
  const method = detectInstallMethod();
  const configPath = getAppConfigPath();
  const sessionsDir = getSessionsDir();
  const checks: DiagnosticResult[] = [];

  // Load config
  let gatewayUrl: string | null = null;
  let defaultModel = "unknown";
  let sandboxMode = "unknown";
  try {
    const { config } = loadAppConfig();
    gatewayUrl = config.gatewayUrl;
    defaultModel = config.defaultModel;
    sandboxMode = config.sandboxMode;
  } catch {
    checks.push({ name: "config", status: "error", value: "Failed to load config" });
  }

  // Budget
  const budget = getBudgetConfig();

  // Checks
  checks.push(checkFileExists("config file", configPath));
  checks.push(checkDirExists("sessions dir", sessionsDir));
  checks.push(checkDirWritable("sessions dir writable", sessionsDir));
  checks.push(checkBunPresence());
  checks.push(checkNodePresence());
  checks.push(checkMcpConfig());

  return {
    version: getVersion(),
    platform,
    arch,
    installMethod: method,
    configPath,
    sessionsDir,
    gatewayUrl,
    defaultModel,
    sandboxMode,
    budgetUsd: budget.budgetUsd,
    checks,
    json: false,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`ToolNet CLI Diagnostic Report`);
  lines.push(`${"─".repeat(40)}`);
  lines.push(`Version:       ${report.version}`);
  lines.push(`Platform:      ${report.platform}-${report.arch}`);
  lines.push(`Install:       ${report.installMethod}`);
  lines.push(`Config:        ${report.configPath}`);
  lines.push(`Sessions:      ${report.sessionsDir}`);
  lines.push(`Gateway:       ${report.gatewayUrl ?? "(direct mode)"}`);
  lines.push(`Model:         ${report.defaultModel}`);
  lines.push(`Sandbox:       ${report.sandboxMode}`);
  lines.push(`Budget:        ${report.budgetUsd !== null ? `$${report.budgetUsd}` : "(none)"}`);
  lines.push("");

  for (const check of report.checks) {
    const icon = check.status === "ok" ? "✔" : check.status === "warn" ? "⚠" : "✘";
    lines.push(`  ${icon} ${check.name}: ${check.value}`);
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Individual checks                                                 */
/* ------------------------------------------------------------------ */

function checkFileExists(name: string, filePath: string): DiagnosticResult {
  try {
    if (fs.existsSync(filePath)) {
      return { name, status: "ok", value: "exists" };
    }
    return { name, status: "warn", value: "not found (will be created on first run)" };
  } catch {
    return { name, status: "error", value: "cannot check" };
  }
}

function checkDirExists(name: string, dirPath: string): DiagnosticResult {
  try {
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      return { name, status: "ok", value: "exists" };
    }
    return { name, status: "warn", value: "not found" };
  } catch {
    return { name, status: "error", value: "cannot check" };
  }
}

function checkDirWritable(name: string, dirPath: string): DiagnosticResult {
  try {
    if (!fs.existsSync(dirPath)) {
      return { name, status: "warn", value: "dir not present" };
    }
    const testFile = path.join(dirPath, ".write-test");
    fs.writeFileSync(testFile, "ok");
    fs.unlinkSync(testFile);
    return { name, status: "ok", value: "writable" };
  } catch {
    return { name, status: "warn", value: "not writable" };
  }
}

function checkBunPresence(): DiagnosticResult {
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const ver = execSync("bun --version", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return { name: "bun", status: "ok", value: ver };
  } catch {
    return { name: "bun", status: "warn", value: "not found in PATH" };
  }
}

function checkNodePresence(): DiagnosticResult {
  try {
    return { name: "node", status: "ok", value: process.version };
  } catch {
    return { name: "node", status: "warn", value: "not available" };
  }
}

function checkMcpConfig(): DiagnosticResult {
  try {
    const mcpPath = path.join(process.cwd(), ".github", "mcp.json");
    if (fs.existsSync(mcpPath)) {
      const raw = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      const count = Object.keys(raw.mcpServers || raw.servers || {}).length;
      return { name: "MCP servers", status: "ok", value: `${count} configured` };
    }
    return { name: "MCP servers", status: "ok", value: "none configured" };
  } catch {
    return { name: "MCP servers", status: "ok", value: "none configured" };
  }
}
