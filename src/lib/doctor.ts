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
import { auditLogger } from "./security/auditLogger";
import { pluginManager } from "./plugins/pluginManager";
import { getWorkspaceIndex } from "./workspaceIndex";
import { getWorkspaceRoots } from "./codingAgent";
import { isNoColor } from "../term";
import { supportsVision } from "./vision";
import { getCliKey } from "./keys";
import { checkPendingRecovery } from "./crashRecovery";

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
  provider: string | null;
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
  let provider: string | null = null;
  let defaultModel = "unknown";
  let sandboxMode = "unknown";
  try {
    const { config } = loadAppConfig();
    gatewayUrl = config.gatewayUrl ?? config.baseUrl;
    provider = config.provider;
    defaultModel = config.defaultModel;
    sandboxMode = config.sandboxMode;
  } catch {
    checks.push({ name: "config", status: "error", value: "Failed to load config" });
  }

  // Budget
  const budget = getBudgetConfig();

  // Baseline P3 Checks
  checks.push(checkFileExists("config file", configPath));
  checks.push(checkDirExists("sessions dir", sessionsDir));
  checks.push(checkDirWritable("sessions dir writable", sessionsDir));
  checks.push(checkBunPresence());
  checks.push(checkNodePresence());
  checks.push(checkMcpConfig());

  // P4 Expanded Checks
  checks.push(checkAuditChain());
  checks.push(checkPlugins());
  checks.push(checkWorkspaceIndex());
  checks.push(checkTerminal());
  checks.push(checkVisionCapability(defaultModel));
  checks.push(checkScmAuth());
  checks.push(checkRecoveryState());
  checks.push(checkSandboxIsolation());

  return {
    version: getVersion(),
    platform,
    arch,
    installMethod: method,
    configPath,
    sessionsDir,
    gatewayUrl,
    provider,
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
  lines.push(`Gateway:       ${report.gatewayUrl ?? "(none)"}`);
  lines.push(`Provider:      ${report.provider ?? "(none configured)"}`);
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

function checkAuditChain(): DiagnosticResult {
  try {
    const res = auditLogger.verifyChain();
    if (res.valid) {
      return { name: "audit log hash chain", status: "ok", value: `valid (${res.totalEntries} entries)` };
    }
    return { name: "audit log hash chain", status: "error", value: `tampered at entry ${res.brokenIndex}: ${res.reason}` };
  } catch (err: any) {
    return { name: "audit log hash chain", status: "warn", value: `verification failed: ${err.message}` };
  }
}

function checkPlugins(): DiagnosticResult {
  try {
    const list = pluginManager.listPlugins();
    const active = list.filter((p) => p.enabled).length;
    return { name: "plugins", status: "ok", value: `${active} active (${list.length} installed)` };
  } catch {
    return { name: "plugins", status: "ok", value: "0 installed" };
  }
}

function checkWorkspaceIndex(): DiagnosticResult {
  try {
    const roots = getWorkspaceRoots();
    const idx = getWorkspaceIndex();
    return {
      name: "workspace index",
      status: "ok",
      value: `${roots.length} root(s), ${idx.totalFiles} files indexed`,
    };
  } catch {
    return { name: "workspace index", status: "warn", value: "index not built" };
  }
}

function checkTerminal(): DiagnosticResult {
  const isTty = Boolean(process.stdout && process.stdout.isTTY);
  const cols = process.stdout?.columns || 80;
  const rows = process.stdout?.rows || 24;
  const colorMode = isNoColor() ? "no-color" : "true-color/ansi";
  return {
    name: "terminal",
    status: "ok",
    value: `${isTty ? "TTY" : "non-TTY"} ${cols}x${rows}, ${colorMode}`,
  };
}

function checkVisionCapability(modelName: string): DiagnosticResult {
  const canVision = supportsVision(modelName);
  return {
    name: "vision / image input",
    status: canVision ? "ok" : "warn",
    value: canVision ? `supported by ${modelName}` : `model '${modelName}' is text-only`,
  };
}

function checkScmAuth(): DiagnosticResult {
  const ghToken = Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || getCliKey("github"));
  const glToken = Boolean(process.env.GITLAB_TOKEN || process.env.GL_TOKEN || getCliKey("gitlab"));
  const statusStr = [ghToken ? "GitHub: configured" : "GitHub: unauthenticated", glToken ? "GitLab: configured" : "GitLab: unauthenticated"].join(", ");
  return {
    name: "SCM credentials",
    status: "ok",
    value: statusStr,
  };
}

function checkRecoveryState(): DiagnosticResult {
  const pending = checkPendingRecovery();
  if (pending) {
    return {
      name: "crash recovery",
      status: "warn",
      value: `pending recovery for session ${pending.sessionId} (from ${new Date(pending.timestamp).toLocaleTimeString()})`,
    };
  }
  return {
    name: "crash recovery",
    status: "ok",
    value: "clean (no crashed sessions)",
  };
}

function checkSandboxIsolation(): DiagnosticResult {
  const { detectSandboxCapability } = require("./security/sandboxExecutor");
  const cap = detectSandboxCapability();
  return {
    name: "OS sandbox isolation",
    status: cap.available ? "ok" : "warn",
    value: cap.label + " (" + cap.details + ")",
  };
}
