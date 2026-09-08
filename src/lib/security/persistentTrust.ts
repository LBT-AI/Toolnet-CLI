/**
 * Persistent "Always trust" rules — Layer 4 Security.
 *
 * Unlike SessionTrust (strictly per-session, in-memory), these rules survive
 * across sessions AND restarts so the Security Approval modal's
 * "Always trust this folder" option never asks again for the same
 * (toolName, targetKey) pair.
 *
 * Stored at <toolnet-home>/always-trust.json:
 *   { "rules": { "<toolName>": ["<targetKey>", ...] } }
 */

import fs from "node:fs";
import path from "node:path";
import { getToolnetHome, ensureToolnetDir } from "../toolnetHome";

export interface AlwaysTrustFile {
  rules: Record<string, string[]>;
}

export function alwaysTrustFilePath(): string {
  return path.join(getToolnetHome(), "always-trust.json");
}

function readRules(): AlwaysTrustFile {
  try {
    const raw = fs.readFileSync(alwaysTrustFilePath(), "utf8");
    const parsed = JSON.parse(raw) as AlwaysTrustFile;
    if (parsed && parsed.rules && typeof parsed.rules === "object") return parsed;
  } catch {
    // Missing or unparsable file → treat as no rules.
  }
  return { rules: {} };
}

/**
 * True when a persistent "always trust" rule covers (toolName, targetKey).
 * "*" acts as a wildcard target for a tool.
 */
export function isAlwaysTrusted(toolName: string, targetKey: string): boolean {
  const data = readRules();
  const list = data.rules[toolName] || [];
  return list.includes(targetKey) || list.includes("*");
}

/** Persists an always-trust rule for (toolName, targetKey). Idempotent. */
export function recordAlwaysTrust(toolName: string, targetKey: string): void {
  try {
    ensureToolnetDir(getToolnetHome());
    const data = readRules();
    if (!data.rules[toolName]) data.rules[toolName] = [];
    const list = data.rules[toolName];
    if (!list.includes(targetKey)) list.push(targetKey);
    fs.writeFileSync(alwaysTrustFilePath(), JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch {
    // Persistence failure is non-fatal: the session-scoped record still applies.
  }
}

/** Test helper: wipe all persistent always-trust rules. */
export function clearAlwaysTrustForTests(): void {
  try {
    fs.rmSync(alwaysTrustFilePath(), { force: true });
  } catch {}
}