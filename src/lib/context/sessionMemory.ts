import type { SessionMemoryData } from "./types";
import { ContextCache } from "../../teamwork/contextCache";
import { detectProjectFramework } from "../projectDetector";
import { workspaceRoot } from "../codingAgent";

class SessionMemoryStore {
  private data: SessionMemoryData;
  private cache: ContextCache | null = null;
  private sessionId: string;

  constructor(sessionId = "default-session") {
    this.sessionId = sessionId;
    this.data = {
      workspaceRoot: workspaceRoot || process.cwd(),
      keyFilesTouched: [],
      modifiedFiles: [],
      userGoals: [],
      discoveredInsights: [],
      environmentInfo: {
        nodeVersion: process.version,
        platform: process.platform,
      },
      lastUpdated: Date.now(),
    };

    try {
      this.cache = new ContextCache();
      this.hydrateFromCache();
    } catch {
      // Non-fatal if sqlite is unavailable
    }

    this.detectWorkspaceContext();
  }

  private detectWorkspaceContext() {
    try {
      const root = this.data.workspaceRoot || process.cwd();
      const detected = detectProjectFramework(root);
      if (detected && detected.framework !== "unknown") {
        this.data.framework = detected.framework;
        this.data.projectOverview = `Detected ${detected.framework.toUpperCase()} project (Triggered by ${detected.configFile}). Verification: ${detected.verifyCommands.join(" && ") || "none"}`;
      }
    } catch {}
  }

  private hydrateFromCache() {
    if (!this.cache) return;
    try {
      const cached = this.cache.get(this.sessionId);
      if (cached && cached.fileMaps) {
        const parsed = JSON.parse(cached.fileMaps);
        if (Array.isArray(parsed.keyFilesTouched)) {
          this.data.keyFilesTouched = Array.from(new Set([...this.data.keyFilesTouched, ...parsed.keyFilesTouched]));
        }
        if (Array.isArray(parsed.modifiedFiles)) {
          this.data.modifiedFiles = Array.from(new Set([...this.data.modifiedFiles, ...parsed.modifiedFiles]));
        }
      }
    } catch {}
  }

  private persistToCache() {
    if (!this.cache) return;
    try {
      this.cache.set(this.sessionId, {
        astHash: this.data.framework || "generic",
        dependencyGraph: JSON.stringify(this.data.discoveredInsights.slice(-10)),
        fileMaps: JSON.stringify({
          keyFilesTouched: this.data.keyFilesTouched.slice(-30),
          modifiedFiles: this.data.modifiedFiles.slice(-30),
          userGoals: this.data.userGoals.slice(-10),
        }),
      });
    } catch {}
  }

  recordFileAccess(filePath: string, action: "read" | "write" | "patch") {
    if (!filePath) return;
    const clean = filePath.trim();
    if (!this.data.keyFilesTouched.includes(clean)) {
      this.data.keyFilesTouched.push(clean);
      if (this.data.keyFilesTouched.length > 50) {
        this.data.keyFilesTouched.shift();
      }
    }
    if ((action === "write" || action === "patch") && !this.data.modifiedFiles.includes(clean)) {
      this.data.modifiedFiles.push(clean);
      if (this.data.modifiedFiles.length > 50) {
        this.data.modifiedFiles.shift();
      }
    }
    this.data.lastUpdated = Date.now();
    this.persistToCache();
  }

  recordUserGoal(goal: string) {
    if (!goal) return;
    const clean = goal.trim().slice(0, 200);
    if (!this.data.userGoals.includes(clean)) {
      this.data.userGoals.push(clean);
      if (this.data.userGoals.length > 10) {
        this.data.userGoals.shift();
      }
    }
    this.data.lastUpdated = Date.now();
    this.persistToCache();
  }

  recordInsight(insight: string) {
    if (!insight) return;
    const clean = insight.trim().slice(0, 300);
    if (!this.data.discoveredInsights.includes(clean)) {
      this.data.discoveredInsights.push(clean);
      if (this.data.discoveredInsights.length > 15) {
        this.data.discoveredInsights.shift();
      }
    }
    this.data.lastUpdated = Date.now();
    this.persistToCache();
  }

  getSnapshot(): SessionMemoryData {
    return { ...this.data };
  }

  generateSystemPromptSnippet(): string {
    const lines: string[] = [];
    lines.push("<session_memory>");
    lines.push(`Workspace: ${this.data.workspaceRoot}`);
    if (this.data.framework) {
      lines.push(`Tech Stack: ${this.data.framework}`);
    }
    if (this.data.projectOverview) {
      lines.push(`Project Details: ${this.data.projectOverview}`);
    }
    if (this.data.modifiedFiles.length > 0) {
      lines.push(`Modified Files in Session: ${this.data.modifiedFiles.slice(-8).join(", ")}`);
    }
    if (this.data.keyFilesTouched.length > 0) {
      lines.push(`Key Files Referenced: ${this.data.keyFilesTouched.slice(-10).join(", ")}`);
    }
    if (this.data.discoveredInsights.length > 0) {
      lines.push(`Key Findings:`);
      for (const ins of this.data.discoveredInsights.slice(-4)) {
        lines.push(`- ${ins}`);
      }
    }
    lines.push("</session_memory>");
    return lines.join("\n");
  }

  reset() {
    this.data.keyFilesTouched = [];
    this.data.modifiedFiles = [];
    this.data.userGoals = [];
    this.data.discoveredInsights = [];
    this.data.lastUpdated = Date.now();
    this.persistToCache();
  }
}

export const sessionMemory = new SessionMemoryStore();
export { SessionMemoryStore };
