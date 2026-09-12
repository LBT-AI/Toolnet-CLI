import { getHarness } from "./harness";
import { contextEngine } from "./context";
import { sessionTrust } from "./security/sessionTrust";
import { toolRegistry } from "./harness/toolRegistry";
import type { HarnessMetrics } from "./harness/types";
import type { ListItem } from "../tui/renderers/listPanelRenderer";
// Phase 81 §19 — the panel READS the canonical harness registry and the
// canonical config. It implements no policy: selection goes through the same
// `persistHarnessProfile` API the CLI uses.
import {
  currentHarnessSettings,
  harnessRegistry,
  summarizeHarnessProfile,
} from "../core/harness";

export interface HarnessDetailRow {
  label: string;
  value: string;
  status?: "enabled" | "disabled" | "active";
}

export interface HarnessSectionDetail {
  id: string;
  title: string;
  rows: HarnessDetailRow[];
}

export const HARNESS_SECTIONS: Array<{ id: string; title: string; description: string }> = [
  { id: "session", title: "Session", description: "Session ID, model, workspace and framework" },
  { id: "profile", title: "Profile", description: "Active harness policy profile (prompt, tools, loops, completion)" },
  { id: "execution", title: "Execution", description: "Execution kernel, sandbox and strategies" },
  { id: "security", title: "Security", description: "Sandbox, trusted rules, SecretGuard and classifier" },
  { id: "context", title: "Context", description: "Context engine, compaction and tracked files" },
  { id: "tools", title: "Tools", description: "Registered tool registry and cache statistics" },
  { id: "telemetry", title: "Telemetry", description: "Tokens, tool calls, uptime and output metrics" },
  { id: "subagents", title: "Subagents", description: "Subagent runtime and delegation roles" },
];

export function normalizeSectionId(input: string): string | null {
  if (!input) return null;
  const wanted = input.toLowerCase().trim();
  const found = HARNESS_SECTIONS.find((s) => s.id === wanted || s.title.toLowerCase() === wanted);
  return found ? found.id : null;
}

export function getHarnessSections(query?: string): ListItem[] {
  const q = (query || "").trim().toLowerCase();
  const sections = HARNESS_SECTIONS.filter(
    (s) =>
      !q ||
      s.title.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q)
  );
  return sections.map((s) => ({
    id: s.id,
    title: s.title,
    subtitle: "Harness",
    description: s.description,
    status: "enabled" as const,
  }));
}

export function getHarnessSectionDetail(input: string): HarnessSectionDetail | null {
  const id = normalizeSectionId(input);
  if (!id) return null;

  const snap = getHarness().getSnapshot();
  const uptime = Math.max(0, Math.round((Date.now() - snap.initializedAt) / 1000));

  switch (id) {
    case "session":
      return {
        id,
        title: "Harness / Session",
        rows: [
          { label: "Session ID", value: snap.sessionId },
          { label: "Active Model", value: snap.currentModel },
          { label: "Workspace Root", value: snap.workspaceRoot },
          { label: "Current CWD", value: snap.currentCwd },
          { label: "Detected Stack", value: snap.activeFramework, status: "active" },
        ],
      };
    case "profile": {
      const settings = currentHarnessSettings();
      const active = harnessRegistry.get(settings.profile);
      const rows: HarnessDetailRow[] = [
        {
          label: "Configured",
          value: settings.profile,
          status: active ? "active" : "disabled",
        },
        {
          label: "Status",
          value: active ? "registered" : "unknown — runs fall back to 'default'",
          status: active ? "enabled" : "disabled",
        },
      ];
      for (const line of active ? summarizeHarnessProfile(active) : []) {
        const [label, ...rest] = line.split(":");
        rows.push({ label: label.trim(), value: rest.join(":").trim() });
      }
      rows.push({ label: "Available", value: harnessRegistry.ids().join(", ") });
      return { id, title: "Harness / Profile", rows };
    }
    case "execution":
      return {
        id,
        title: "Harness / Execution",
        rows: [
          { label: "Kernel", value: "Unified AgentHarness", status: "active" },
          { label: "Sandbox Mode", value: snap.sandboxMode },
          { label: "Total Tool Calls", value: String(snap.totalToolCalls) },
          { label: "Strategies", value: "Headless (-p), Turbo, Teamwork DAG, Subagents" },
          { label: "Initialized", value: new Date(snap.initializedAt).toLocaleTimeString() },
        ],
      };
    case "security":
      return {
        id,
        title: "Harness / Security",
        rows: [
          { label: "Sandbox", value: snap.sandboxMode, status: "active" },
          { label: "Trusted Rules", value: String(sessionTrust.listTrusted().length) },
          { label: "SecretGuard", value: "active", status: "enabled" },
          { label: "Semantic Classifier", value: "active", status: "enabled" },
        ],
      };
    case "context": {
      let memory: any = null;
      try {
        memory = contextEngine.getSessionMemory(snap.sessionId);
      } catch {}
      const mem = memory || {};
      return {
        id,
        title: "Harness / Context",
        rows: [
          { label: "Compactions", value: String(contextEngine.getCompactionCount()) },
          { label: "Tracked Files", value: String(Array.isArray(mem.keyFilesTouched) ? mem.keyFilesTouched.length : 0) },
          { label: "Modified Files", value: String(Array.isArray(mem.modifiedFiles) ? mem.modifiedFiles.length : 0) },
          { label: "User Goals", value: String(Array.isArray(mem.userGoals) ? mem.userGoals.length : 0) },
          { label: "Atomic Compaction", value: "ready", status: "enabled" },
        ],
      };
    }
    case "tools": {
      const metrics = (snap.metrics || {}) as HarnessMetrics;
      return {
        id,
        title: "Harness / Tools",
        rows: [
          { label: "Registered Tools", value: String(toolRegistry.canonicalNames().length), status: "active" },
          { label: "Cache Hits", value: String(metrics.toolCacheHits || 0) },
          { label: "Deduplicated", value: String(metrics.toolCallsDeduplicated || 0) },
          { label: "Batched", value: String(metrics.toolCallsBatched || 0) },
          { label: "Executed", value: String(metrics.toolCallsExecuted || 0) },
        ],
      };
    }
    case "telemetry": {
      const metrics = (snap.metrics || {}) as HarnessMetrics;
      return {
        id,
        title: "Harness / Telemetry",
        rows: [
          { label: "Tokens Used", value: `~${snap.totalTokensUsed}` },
          { label: "Calls Requested", value: String(metrics.toolCallsRequested || 0) },
          { label: "Calls Executed", value: String(metrics.toolCallsExecuted || 0) },
          { label: "Uptime", value: `${uptime}s` },
          { label: "Raw Output Chars", value: String(metrics.rawToolOutputChars || 0) },
          { label: "Retained Output Chars", value: String(metrics.retainedToolOutputChars || 0) },
        ],
      };
    }
    case "subagents":
      return {
        id,
        title: "Harness / Subagents",
        rows: [
          { label: "Runtime", value: "subagentRuntime", status: "active" },
          { label: "Delegation", value: "executeSubagentTask → AgentHarness → ToolGateway" },
          { label: "Roles", value: "CODER, RESEARCHER, TESTER, REVIEWER, ARCHITECT, GENERAL" },
          { label: "Isolation", value: "per-subagent context memory" },
        ],
      };
    default:
      return null;
  }
}