import fs from "node:fs";
import path from "node:path";
import type { SecurityPolicyConfig } from "./types";

export class PolicyEngine {
  private workspacePolicy: SecurityPolicyConfig | null = null;
  private globalPolicy: SecurityPolicyConfig | null = null;
  private loaded = false;

  constructor() {}

  reload(customRoot?: string) {
    const root = customRoot || process.cwd();
    this.workspacePolicy = this.loadPolicyFile(root);
    this.loaded = true;
  }

  private loadPolicyFile(dir: string): SecurityPolicyConfig | null {
    const candidates = [
      path.join(dir, ".toolnet", "permissions.json"),
      path.join(dir, "toolnet.policy.json"),
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try {
          const raw = fs.readFileSync(p, "utf-8");
          return JSON.parse(raw) as SecurityPolicyConfig;
        } catch {
          // Ignore parse errors and continue
        }
      }
    }
    return null;
  }

  isCommandWhitelisted(command: string): boolean {
    if (!this.loaded) this.reload();
    const policy = this.workspacePolicy;
    if (!policy?.allowedCommands || !Array.isArray(policy.allowedCommands)) return false;

    const trimmed = command.trim();
    for (const item of policy.allowedCommands) {
      if (item === trimmed || (item.endsWith("*") && trimmed.startsWith(item.slice(0, -1)))) {
        return true;
      }
      try {
        const regex = new RegExp(item);
        if (regex.test(trimmed)) return true;
      } catch {}
    }
    return false;
  }

  isCommandBlacklisted(command: string): { isBlacklisted: boolean; reason?: string } {
    if (!this.loaded) this.reload();
    const policy = this.workspacePolicy;
    if (!policy?.blockedCommands || !Array.isArray(policy.blockedCommands)) {
      return { isBlacklisted: false };
    }

    const trimmed = command.trim();
    for (const item of policy.blockedCommands) {
      if (item === trimmed || (item.endsWith("*") && trimmed.startsWith(item.slice(0, -1)))) {
        return { isBlacklisted: true, reason: `Command matches blocked policy rule: "${item}"` };
      }
      try {
        const regex = new RegExp(item);
        if (regex.test(trimmed)) {
          return { isBlacklisted: true, reason: `Command matches blocked policy rule: "${item}"` };
        }
      } catch {}
    }
    return { isBlacklisted: false };
  }

  isPathAllowedByPolicy(targetPath: string, mode: "read" | "write"): boolean {
    if (!this.loaded) this.reload();
    const policy = this.workspacePolicy;
    if (!policy) return true;

    const normalized = path.normalize(targetPath);

    // Check blacklist first
    if (policy.blockedPaths && Array.isArray(policy.blockedPaths)) {
      for (const bp of policy.blockedPaths) {
        if (normalized.includes(bp)) return false;
      }
    }

    // Check whitelist if configured
    const allowList = mode === "write" ? policy.allowedWritePaths : policy.allowedReadPaths;
    if (allowList && Array.isArray(allowList) && allowList.length > 0) {
      return allowList.some((ap) => normalized.startsWith(path.normalize(ap)));
    }

    return true;
  }

  getPolicySnapshot(): SecurityPolicyConfig | null {
    return this.workspacePolicy;
  }
}

export const policyEngine = new PolicyEngine();
