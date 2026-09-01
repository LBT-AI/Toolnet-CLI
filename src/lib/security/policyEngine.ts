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
  dynamicExecution: false, // Locked: eval, interpreter inline execution requires explicit confirmation
};

const MAX_REGEX_LENGTH = 200;
const SUSPICIOUS_REDOS_PATTERNS = [
  /\([^)]*(\+|\*)\)[+*]/,      // Nested quantifiers like (a+)+ or (a*)*
  /\([^)]*(\+|\*)\)\{/,        // Nested range like (a+){2,}
  /([a-zA-Z0-9_\-\s]+)\+\1\+/, // Overlapping plus repetition
];

export function compileSafeRegex(pattern: string): RegExp | null {
  if (!pattern || typeof pattern !== "string") return null;
  if (pattern.length > MAX_REGEX_LENGTH) return null;

  for (const sus of SUSPICIOUS_REDOS_PATTERNS) {
    if (sus.test(pattern)) return null;
  }

  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

export function isSubpathOrEqual(parentPath: string, childPath: string): boolean {
  const normParent = path.resolve(parentPath);
  const normChild = path.resolve(childPath);
  let realParent = normParent;
  let realChild = normChild;
  try { realParent = fs.realpathSync(normParent); } catch {}
  try { realChild = fs.realpathSync(normChild); } catch {}

  const rel = path.relative(realParent, realChild);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

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

     const key = capability.toLowerCase() as string;
     const normalizedKey = key === "dynamic_execution" ? "dynamicExecution" : (key as keyof CapabilityConfig);

     // 1. Check in-memory dynamic override (session)
     if (this.dynamicCapabilities[normalizedKey] !== undefined) {
       return Boolean(this.dynamicCapabilities[normalizedKey]);
     }

     // 2. Check project policy file (.toolnet/permissions.json)
     if (this.workspacePolicy?.capabilities && this.workspacePolicy.capabilities[normalizedKey] !== undefined) {
       return Boolean(this.workspacePolicy.capabilities[normalizedKey]);
     }

     // 3. Fallback to safe built-in default
     return DEFAULT_CAPABILITIES[normalizedKey];
   }

   setCapability(capability: PermissionCapability, allowed: boolean) {
     const key = capability.toLowerCase() as string;
     const normalizedKey = key === "dynamic_execution" ? "dynamicExecution" : (key as keyof CapabilityConfig);
     this.dynamicCapabilities[normalizedKey] = allowed;
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
      DYNAMIC_EXECUTION: this.isCapabilityAllowed("DYNAMIC_EXECUTION"),
    };
  }

  isCommandWhitelisted(command: string): boolean {
    if (!this.loaded) this.reload();
    const policy = this.workspacePolicy;
    if (!policy?.allowedCommands || !Array.isArray(policy.allowedCommands)) return false;

    const trimmed = command.trim();
    for (const item of policy.allowedCommands) {
      if (!item) continue;
      if (item === trimmed || (item.endsWith("*") && trimmed.startsWith(item.slice(0, -1)))) {
        return true;
      }
      const regex = compileSafeRegex(item);
      if (regex && regex.test(trimmed)) return true;
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
      if (!item) continue;
      if (item === trimmed || (item.endsWith("*") && trimmed.startsWith(item.slice(0, -1)))) {
        return { isBlacklisted: true, reason: `Command matches blocked policy rule: "${item}"` };
      }
      const regex = compileSafeRegex(item);
      if (regex && regex.test(trimmed)) {
        return { isBlacklisted: true, reason: `Command matches blocked policy rule: "${item}"` };
      }
    }
    return { isBlacklisted: false };
  }

  isPathAllowedByPolicy(targetPath: string, mode: "read" | "write"): boolean {
    if (!this.loaded) this.reload();
    const policy = this.workspacePolicy;
    if (!policy) return true;

    const absTarget = path.resolve(targetPath);

    // Check blacklist first with canonical subtree/exact boundary matching
    if (policy.blockedPaths && Array.isArray(policy.blockedPaths)) {
      for (const bp of policy.blockedPaths) {
        if (!bp) continue;
        const absBp = path.resolve(bp);
        if (isSubpathOrEqual(absBp, absTarget)) {
          return false;
        }
      }
    }

    // Check whitelist if configured
    const allowList = mode === "write" ? policy.allowedWritePaths : policy.allowedReadPaths;
    if (allowList && Array.isArray(allowList) && allowList.length > 0) {
      return allowList.some((ap) => {
        if (!ap) return false;
        const absAp = path.resolve(ap);
        return isSubpathOrEqual(absAp, absTarget);
      });
    }

    return true;
  }

  getPolicySnapshot(): SecurityPolicyConfig | null {
    return this.workspacePolicy;
  }
}

export const policyEngine = new PolicyEngine();
