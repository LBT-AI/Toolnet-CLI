/**
 * Phase 75.2 / 75.14 — Canonical Agent Registry
 *
 * ONE registry for every agent ToolNet knows about — built-in and user-defined.
 * There is deliberately no second "agent catalog": the `task` tool, the UI, the
 * permission deriver and the tests all resolve agents here.
 *
 * Built-ins are intentionally few. Personas are cheap to add and expensive to
 * keep coherent, so ToolNet ships one agent per *responsibility* (read, write,
 * verify, review, general) rather than one per domain.
 */

import fs from "node:fs";
import path from "node:path";
import { parseYamlSubset, YamlSubsetError } from "./yaml";
import {
  DEFAULT_SUBAGENT_TYPE,
  type AgentDefinition,
  type AgentMode,
  type ModelRef,
  type PermissionRule,
  type ToolDecision,
} from "./types";

/** Pure read/navigation tools — safe for every read-capable role. */
const READ_NAV_TOOLS = [
  "get_cwd",
  "read_file",
  "list_dir",
  "tree",
  "file_exists",
  "find_path",
  "grep",
  "glob",
] as const;

/** Search + semantic navigation used by explore/reviewer. */
const INTELLIGENCE_TOOLS = [...READ_NAV_TOOLS, "lsp"] as const;

/** Tools a fully privileged coding role may use inside the workspace. */
const CODER_TOOLS = [
  ...INTELLIGENCE_TOOLS,
  "write_file",
  "edit_file",
  "replace_all",
  "apply_patch",
  "shell",
  "git_status",
  "git_diff",
] as const;

/** Tools that mutate the filesystem — never granted to read-only roles. */
const MUTATION_TOOLS = ["write_file", "edit_file", "replace_all", "apply_patch"] as const;

/** Tools that execute a process — never granted to read-only roles. */
const PROCESS_TOOLS = ["shell", "bash", "run_command"] as const;

/**
 * Built-in agents. Scope (per §75.3):
 *   general  → inherits the parent's scope (no allowlist)
 *   explore  → read + search + LSP + network fetch, never writes
 *   coder    → full workspace editing + shell
 *   tester   → read + shell (to run tests), never writes source
 *   reviewer → read + search + LSP only
 *   plan     → primary, read-only: cannot mutate or execute, and cannot launder
 *              a write through a subagent (see §75.5)
 */
export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: "general",
    name: "General",
    description:
      "General-purpose agent that inherits the parent's tool scope and permissions. Use when no specialised role fits.",
    mode: "all",
    builtIn: true,
  },
  {
    id: "explore",
    name: "Explore",
    description:
      "Read-only research agent. Inspects code, searches symbols, reads files and reports findings. Never modifies the workspace.",
    mode: "subagent",
    builtIn: true,
    allowedTools: [...INTELLIGENCE_TOOLS, "web_fetch", "audit_url", "git_status", "git_diff"],
    deniedTools: [...MUTATION_TOOLS, ...PROCESS_TOOLS],
    maxSteps: 12,
  },
  {
    id: "coder",
    name: "Coder",
    description:
      "Implementation agent. Reads before editing, writes real files, runs commands and verifies its own changes.",
    mode: "subagent",
    builtIn: true,
    allowedTools: [...CODER_TOOLS],
    deniedTools: ["task", "spawn_subagent"],
    maxSteps: 20,
  },
  {
    id: "tester",
    name: "Tester",
    description:
      "Verification agent. Runs the project's tests and typecheck, inspects failures and reports exact evidence.",
    mode: "subagent",
    builtIn: true,
    allowedTools: [...INTELLIGENCE_TOOLS, "shell", "git_status", "git_diff"],
    deniedTools: [...MUTATION_TOOLS],
    maxSteps: 12,
  },
  {
    id: "reviewer",
    name: "Reviewer",
    description:
      "Read-only review agent. Audits changes, security implications and edge cases without touching the workspace.",
    mode: "subagent",
    builtIn: true,
    allowedTools: [...INTELLIGENCE_TOOLS, "git_status", "git_diff"],
    deniedTools: [...MUTATION_TOOLS, ...PROCESS_TOOLS],
    maxSteps: 12,
  },
  {
    id: "plan",
    name: "Plan",
    description:
      "Planning agent. Analyses and proposes changes but never edits files or runs commands. `task` stays available — but any subagent it spawns inherits the same write/execute denial, so delegation cannot launder a mutation.",
    mode: "primary",
    builtIn: true,
    // Mutations and process execution are denied; `task` is deliberately left
    // available so the runtime (not the prompt) proves the bypass is blocked.
    deniedTools: [...MUTATION_TOOLS, ...PROCESS_TOOLS],
    permissions: [
      { tool: "write_file", decision: "deny" },
      { tool: "edit_file", decision: "deny" },
      { tool: "apply_patch", decision: "deny" },
      { tool: "replace_all", decision: "deny" },
      { tool: "shell", decision: "deny" },
    ],
  },
];

const VALID_MODES: AgentMode[] = ["primary", "subagent", "all"];
const VALID_DECISIONS: ToolDecision[] = ["allow", "ask", "deny"];
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export interface AgentValidationIssue {
  agentId: string;
  message: string;
}

export interface CustomAgentLoadResult {
  registered: string[];
  issues: AgentValidationIssue[];
}

/** Coerce an unknown YAML node into a cleaned string list. */
function toStringList(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    const items = value.map((v) => String(v).trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  const single = String(value).trim();
  return single ? [single] : undefined;
}

/**
 * Validate and normalise one raw agent config node. Returns the definition or a
 * descriptive issue — never throws, so one bad entry cannot disable the rest.
 */
export function parseAgentDefinition(
  id: string,
  raw: unknown
): { ok: true; definition: AgentDefinition } | { ok: false; message: string } {
  if (!AGENT_ID_PATTERN.test(id)) {
    return { ok: false, message: `Invalid agent id "${id}" — use letters, digits, dot, dash or underscore.` };
  }

  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: `Agent "${id}" must be a mapping of properties.` };
  }

  const node = raw as Record<string, unknown>;
  const mode = node.mode == null ? "subagent" : String(node.mode).trim();
  if (!VALID_MODES.includes(mode as AgentMode)) {
    return { ok: false, message: `Agent "${id}" has invalid mode "${mode}" (expected primary|subagent|all).` };
  }

  const permissions: PermissionRule[] = [];
  const rawPermissions = node.permissions;
  if (rawPermissions != null) {
    if (typeof rawPermissions !== "object" || Array.isArray(rawPermissions)) {
      return { ok: false, message: `Agent "${id}" permissions must be a mapping of tool: decision.` };
    }
    for (const [tool, decision] of Object.entries(rawPermissions as Record<string, unknown>)) {
      const value = String(decision).trim();
      if (!VALID_DECISIONS.includes(value as ToolDecision)) {
        return { ok: false, message: `Agent "${id}" permission for "${tool}" must be allow|ask|deny.` };
      }
      permissions.push({ tool, decision: value as ToolDecision });
    }
  }

  const model = parseModelRef(id, node.model);
  if (model && "error" in model) return { ok: false, message: model.error };

  const allowedTools = toStringList(node.tools);
  const deniedTools = toStringList(node.deny);
  const maxSteps = Number(node.maxSteps);

  return {
    ok: true,
    definition: {
      id,
      name: typeof node.name === "string" && node.name.trim() ? node.name.trim() : id,
      description:
        typeof node.description === "string" && node.description.trim()
          ? node.description.trim()
          : `Custom agent "${id}".`,
      mode: mode as AgentMode,
      ...(model ? { model: model.value } : {}),
      ...(typeof node.systemPrompt === "string" ? { systemPrompt: node.systemPrompt } : {}),
      ...(allowedTools ? { allowedTools } : {}),
      ...(deniedTools ? { deniedTools } : {}),
      ...(permissions.length > 0 ? { permissions } : {}),
      ...(Number.isFinite(maxSteps) && maxSteps > 0 ? { maxSteps } : {}),
      builtIn: false,
    },
  };
}

function parseModelRef(
  id: string,
  raw: unknown
): { value: ModelRef } | { error: string } | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `Agent "${id}" model must be a mapping with providerId and modelId.` };
  }
  const node = raw as Record<string, unknown>;
  const providerId = node.providerId ?? node.provider;
  const modelId = node.modelId ?? node.model;
  if (!providerId || !modelId) {
    return { error: `Agent "${id}" model requires both providerId and modelId.` };
  }
  return { value: { providerId: String(providerId), modelId: String(modelId) } };
}

export class AgentRegistry {
  private readonly agents = new Map<string, AgentDefinition>();

  constructor(definitions: AgentDefinition[] = BUILTIN_AGENTS) {
    for (const definition of definitions) this.register(definition);
  }

  /** Register (or replace a non-built-in) agent definition. Ids are case-insensitive. */
  register(definition: AgentDefinition): void {
    const key = definition.id.toLowerCase();
    const existing = this.agents.get(key);
    if (existing?.builtIn && !definition.builtIn) return;
    this.agents.set(key, definition);
  }

  get(id: string): AgentDefinition | undefined {
    if (!id) return undefined;
    return this.agents.get(String(id).toLowerCase());
  }

  list(): AgentDefinition[] {
    return [...this.agents.values()];
  }

  /** Agents usable as a spawned child (`task` tool targets). */
  listSubagents(): AgentDefinition[] {
    return this.list().filter((a) => a.mode === "subagent" || a.mode === "all");
  }

  /** Agents that can be a top-level persona. */
  listPrimary(): AgentDefinition[] {
    return this.list().filter((a) => a.mode === "primary" || a.mode === "all");
  }

  /**
   * Resolve an agent for spawning. Unknown ids fall back to the general agent
   * so a model hallucinating a role name degrades safely instead of failing the
   * turn — and never silently gains extra scope.
   */
  resolve(id?: string): AgentDefinition {
    const wanted = id?.trim();
    if (!wanted) return this.mustGet(DEFAULT_SUBAGENT_TYPE);
    return this.get(wanted) || this.mustGet(DEFAULT_SUBAGENT_TYPE);
  }

  private mustGet(id: string): AgentDefinition {
    const found = this.agents.get(id);
    if (!found) throw new Error(`AgentRegistry is missing required built-in agent "${id}".`);
    return found;
  }

  /**
   * Load user agents from `<root>/.toolnet/agents.yaml`. Malformed entries are
   * reported, never fatal: a broken config must not prevent the agent from
   * running with its built-ins.
   */
  loadCustomAgents(root: string): CustomAgentLoadResult {
    const result: CustomAgentLoadResult = { registered: [], issues: [] };
    if (!root) return result;

    const configPath = path.join(root, ".toolnet", "agents.yaml");
    if (!fs.existsSync(configPath)) return result;

    let raw: unknown;
    try {
      raw = parseYamlSubset(fs.readFileSync(configPath, "utf8"));
    } catch (err) {
      const message = err instanceof YamlSubsetError ? err.message : (err as Error)?.message || "parse error";
      result.issues.push({ agentId: "<file>", message: `.toolnet/agents.yaml: ${message}` });
      return result;
    }

    const agentsNode =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).agents
        : undefined;

    if (!agentsNode || typeof agentsNode !== "object" || Array.isArray(agentsNode)) {
      result.issues.push({ agentId: "<file>", message: `.toolnet/agents.yaml must contain an "agents:" mapping.` });
      return result;
    }

    for (const [id, node] of Object.entries(agentsNode as Record<string, unknown>)) {
      const parsed = parseAgentDefinition(id, node);
      if (!parsed.ok) {
        result.issues.push({ agentId: id, message: parsed.message });
        continue;
      }
      if (this.get(id)?.builtIn) {
        result.issues.push({ agentId: id, message: `Cannot override built-in agent "${id}".` });
        continue;
      }
      this.register(parsed.definition);
      result.registered.push(id);
    }

    return result;
  }
}

/** Process-wide registry. Front-ends may construct isolated ones for tests. */
export const agentRegistry = new AgentRegistry();
