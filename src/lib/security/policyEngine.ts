import fs from "node:fs";
import path from "node:path";
import type { CapabilityConfig, PermissionCapability, SecurityPolicyConfig } from "./types";

const DEFAULT_CAPABILITIES: Required<CapabilityConfig> = {
  read: true,      // Auto-allow reading files, grep, git status
  create: true,    // Auto-allow creating new files & directories
  modify: true,    // Auto-allow surgical edits & patch within workspace
  delete: false,   // Locked: requires explicit user confirmation
  execute: true,   // Auto-allow safe builds & tests
  reset: false,    // Locked: git reset/clean requires explicit confirmation
  network: true,   // Auto-allow web fetch & docs lookup
  system: false,   // Locked: OS admin & system tampering blocked
};

export class PolicyEngine {
  private workspacePolicy: SecurityPolicyConfig | null = null;
  private dynamicCapabilities: Partial<CapabilityConfig> = {};
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

  isCapabilityAllowed(capability: PermissionCapability): boolean {
    if (!this.loaded) this.reload();

    const key = capability.toLowerCase() as keyof CapabilityConfig;

    // 1. Check in-memory dynamic override (session)
    if (this.dynamicCapabilities[key] !== undefined) {
      return Boolean(this.dynamicCapabilities[key]);
    }

    // 2. Check project policy file (.toolnet/permissions.json)
    if (this.workspacePolicy?.capabilities && this.workspacePolicy.capabilities[key] !== undefined) {
      return Boolean(this.workspacePolicy.capabilities[key]);
    }

    // 3. Fallback to safe built-in default
    return DEFAULT_CAPABILITIES[key];
  }

  setCapability(capability: PermissionCapability, allowed: boolean) {
    const key = capability.toLowerCase() as keyof CapabilityConfig;
    this.dynamicCapabilities[key] = allowed;
  }

  getAllCapabilities(): Record<PermissionCapability, boolean> {
    return {
      READ: this.isCapabilityAllowed("READ"),
      CREATE: this.isCapabilityAllowed("CREATE"),
      MODIFY: this.isCapabilityAllowed("MODIFY"),
      DELETE: this.isCapabilityAllowed("DELETE"),
      EXECUTE: this.isCapabilityAllowed("EXECUTE"),
      RESET: this.isCapabilityAllowed("RESET"),
      NETWORK: this.isCapabilityAllowed("NETWORK"),
      SYSTEM: this.isCapabilityAllowed("SYSTEM"),
    };
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
