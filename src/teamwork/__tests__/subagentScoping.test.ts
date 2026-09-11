/**
 * Phase 75 — Scoped subagent unit tests.
 *
 * Covers the pieces that must hold regardless of model quality:
 *   - the canonical AgentRegistry (built-in + custom config)
 *   - the `.toolnet/agents.yaml` grammar and validation
 *   - permission derivation (parent ∩ agent ∩ requested, never escalating)
 *   - tool scope per role
 *   - child sessions (deterministic ids, resume, isolation)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  AgentRegistry,
  BUILTIN_AGENTS,
  parseAgentDefinition,
} from "../../core/agent/agents/registry";
import { parseYamlSubset, YamlSubsetError } from "../../core/agent/agents/yaml";
import {
  assertNoEscalation,
  deriveSubagentPermission,
  permissionScopeFromAgent,
  permissionScopeFromSandbox,
} from "../../core/agent/agents/permissions";
import {
  DEFAULT_SUBAGENT_MAX_DEPTH,
  decideTool,
  intersectDecision,
  type ToolPermissionScope,
} from "../../core/agent/agents/types";
import { SubagentSessionStore } from "../../core/agent/agents/sessions";
import { composeAgentPrompt } from "../../core/agent/agents/prompt";
import { toolRegistry } from "../../lib/harness/toolRegistry";

// ── Registry ─────────────────────────────────────────────────────────────────

describe("AgentRegistry — canonical agent definitions", () => {
  test("ships the required built-in agents with correct modes", () => {
    const registry = new AgentRegistry();
    for (const id of ["general", "explore", "coder", "tester", "reviewer"]) {
      expect(registry.get(id)).toBeDefined();
    }
    expect(registry.get("general")?.mode).toBe("all");
    for (const id of ["explore", "coder", "tester", "reviewer"]) {
      expect(registry.get(id)?.mode).toBe("subagent");
    }
    expect(registry.get("plan")?.mode).toBe("primary");
    expect(BUILTIN_AGENTS.every((a) => a.builtIn === true)).toBe(true);
  });

  test("subagent list excludes primary-only agents", () => {
    const registry = new AgentRegistry();
    const ids = registry.listSubagents().map((a) => a.id);
    expect(ids).toContain("explore");
    expect(ids).toContain("coder");
    expect(ids).not.toContain("plan");
  });

  test("unknown agent ids resolve to the general agent (safe fallback)", () => {
    const registry = new AgentRegistry();
    expect(registry.resolve("does-not-exist").id).toBe("general");
    expect(registry.resolve(undefined).id).toBe("general");
    expect(registry.resolve("EXPLORE").id).toBe("explore"); // ids are case-insensitive
  });

  test("a custom definition cannot silently replace a built-in agent", () => {
    const registry = new AgentRegistry();
    registry.register({
      id: "explore",
      name: "Hijacked",
      description: "widen access",
      mode: "subagent",
      allowedTools: ["read_file", "write_file", "shell"],
    });
    // The built-in definition is untouched, so its read-only scope stands.
    expect(registry.get("explore")?.name).toBe("Explore");
    expect(registry.get("explore")?.allowedTools).not.toContain("write_file");
  });

  test("registering a new id adds it to the registry", () => {
    const registry = new AgentRegistry();
    registry.register({
      id: "docs",
      name: "Docs",
      description: "Write documentation",
      mode: "subagent",
      allowedTools: ["read_file", "write_file"],
    });
    expect(registry.get("docs")?.name).toBe("Docs");
    expect(registry.listSubagents().map((a) => a.id)).toContain("docs");
  });
});

// ── YAML subset parser ───────────────────────────────────────────────────────

describe("yaml subset parser — .toolnet/agents.yaml", () => {
  test("parses nested mappings and scalar sequences with comments", () => {
    const parsed = parseYamlSubset(`
# ToolNet agents
agents:
  security-reviewer:
    description: Review security issues   # inline comment
    mode: subagent
    maxSteps: 6
    tools:
      - read_file
      - grep
      - lsp
    deny:
      - shell
`) as any;

    expect(parsed.agents["security-reviewer"].description).toBe("Review security issues");
    expect(parsed.agents["security-reviewer"].mode).toBe("subagent");
    expect(parsed.agents["security-reviewer"].maxSteps).toBe(6);
    expect(parsed.agents["security-reviewer"].tools).toEqual(["read_file", "grep", "lsp"]);
    expect(parsed.agents["security-reviewer"].deny).toEqual(["shell"]);
  });

  test("handles quoted scalars containing a hash", () => {
    const parsed = parseYamlSubset(`agents:\n  a:\n    description: "review #1"\n`) as any;
    expect(parsed.agents.a.description).toBe("review #1");
  });

  test("rejects tab indentation with a clear error", () => {
    expect(() => parseYamlSubset("agents:\n\ta:\n\t\tmode: subagent\n")).toThrow(YamlSubsetError);
  });
});

describe("custom agent config validation", () => {
  test("accepts a valid definition and normalises it", () => {
    const parsed = parseAgentDefinition("auditor", {
      description: "Audit things",
      mode: "subagent",
      tools: ["read_file"],
      deny: ["shell"],
      permissions: { write_file: "deny" },
      maxSteps: 4,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.definition.builtIn).toBe(false);
    expect(parsed.definition.allowedTools).toEqual(["read_file"]);
    expect(parsed.definition.deniedTools).toEqual(["shell"]);
    expect(parsed.definition.permissions).toEqual([{ tool: "write_file", decision: "deny" }]);
    expect(parsed.definition.maxSteps).toBe(4);
  });

  test("rejects invalid ids, modes and permission verdicts", () => {
    expect(parseAgentDefinition("bad id!", {}).ok).toBe(false);
    expect(parseAgentDefinition("ok", { mode: "superuser" }).ok).toBe(false);
    expect(parseAgentDefinition("ok", { permissions: { shell: "maybe" } }).ok).toBe(false);
    expect(parseAgentDefinition("ok", { model: { providerId: "x" } }).ok).toBe(false);
    expect(parseAgentDefinition("ok", "not-a-mapping").ok).toBe(false);
  });
});

describe("AgentRegistry.loadCustomAgents", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join("/tmp", "toolnet-agents-"));
    fs.mkdirSync(path.join(root, ".toolnet"), { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  test("loads valid agents and reports invalid ones without failing", () => {
    fs.writeFileSync(
      path.join(root, ".toolnet", "agents.yaml"),
      [
        "agents:",
        "  security-reviewer:",
        "    description: Review security issues",
        "    mode: subagent",
        "    tools:",
        "      - read_file",
        "      - grep",
        "    deny:",
        "      - shell",
        "  broken:",
        "    mode: not-a-mode",
      ].join("\n")
    );

    const registry = new AgentRegistry();
    const result = registry.loadCustomAgents(root);

    expect(result.registered).toEqual(["security-reviewer"]);
    expect(result.issues.map((i) => i.agentId)).toEqual(["broken"]);
    expect(registry.get("security-reviewer")?.mode).toBe("subagent");
    // The bad entry never entered the registry.
    expect(registry.get("broken")).toBeUndefined();
  });

  test("a malformed file yields an issue, not an exception", () => {
    fs.writeFileSync(path.join(root, ".toolnet", "agents.yaml"), "agents:\n\tbad: ['\n");
    const registry = new AgentRegistry();
    const result = registry.loadCustomAgents(root);
    expect(result.registered).toEqual([]);
    expect(result.issues.length).toBe(1);
  });

  test("a missing config file is a no-op", () => {
    const registry = new AgentRegistry();
    const result = registry.loadCustomAgents(root);
    expect(result).toEqual({ registered: [], issues: [] });
  });
});

// ── Permission derivation ────────────────────────────────────────────────────

/** Minimal scope helper for readable assertions. */
function scope(
  defaultDecision: ToolPermissionScope["defaultDecision"],
  tools: Record<string, ToolPermissionScope["defaultDecision"]> = {}
): ToolPermissionScope {
  return { defaultDecision, tools };
}

describe("deriveSubagentPermission — SECURITY: no privilege escalation", () => {
  test("parent deny always wins over an agent that allows the tool", () => {
    // The release-blocker scenario: a read-only parent spawns a coder child.
    const parent = scope("allow", { write_file: "deny", edit_file: "deny", shell: "deny" });
    const child = deriveSubagentPermission({
      parentPermission: parent,
      agentDefinition: new AgentRegistry().get("coder")!,
    });

    expect(decideTool(child, "write_file")).toBe("deny");
    expect(decideTool(child, "edit_file")).toBe("deny");
    expect(decideTool(child, "shell")).toBe("deny");
    // Read tools were never denied, so the child keeps them.
    expect(decideTool(child, "read_file")).toBe("allow");
  });

  test("an agent scope never grants a tool the parent's allowlist excludes", () => {
    const parent = scope("deny");
    const narrowed: ToolPermissionScope = { ...parent, allowedTools: ["read_file", "grep"] };
    const child = deriveSubagentPermission({
      parentPermission: narrowed,
      agentDefinition: new AgentRegistry().get("coder")!,
    });

    expect(decideTool(child, "read_file")).toBe("allow");
    expect(decideTool(child, "write_file")).toBe("deny");
  });

  test("no built-in agent can ever exceed its parent, across all sandbox modes", () => {
    const registry = new AgentRegistry();
    const tools = toolRegistry.canonicalNames();

    for (const mode of ["workspace", "ask", "full-access"] as const) {
      const parent = permissionScopeFromSandbox(mode);
      for (const agent of registry.list()) {
        const child = deriveSubagentPermission({ parentPermission: parent, agentDefinition: agent });
        expect(assertNoEscalation(parent, child, tools)).toEqual({ ok: true });
      }
    }
  });

  test("requested tools can only narrow the derived scope", () => {
    const parent = permissionScopeFromSandbox("full-access");
    const coder = new AgentRegistry().get("coder")!;

    const narrowed = deriveSubagentPermission({
      parentPermission: parent,
      agentDefinition: coder,
      requestedTools: ["read_file"],
    });
    expect(decideTool(narrowed, "read_file")).toBe("allow");
    expect(decideTool(narrowed, "write_file")).toBe("deny"); // not requested
  });

  test("assertNoEscalation detects a violating scope", () => {
    const parent = scope("deny");
    const escalated = scope("allow");
    const check = assertNoEscalation(parent, escalated, ["write_file"]);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.tool).toBe("write_file");
    expect(check.parent).toBe("deny");
    expect(check.child).toBe("allow");
  });

  test("the intersection primitive prefers the least privilege", () => {
    expect(intersectDecision("allow", "deny")).toBe("deny");
    expect(intersectDecision("allow", "ask")).toBe("ask");
    expect(intersectDecision("ask", "deny")).toBe("deny");
    expect(intersectDecision("allow", "allow")).toBe("allow");
  });
});

describe("tool scope per built-in role", () => {
  const parent = permissionScopeFromSandbox("workspace");

  function childOf(id: string): ToolPermissionScope {
    return deriveSubagentPermission({
      parentPermission: parent,
      agentDefinition: new AgentRegistry().get(id)!,
    });
  }

  test("explore is read-only and cannot recurse", () => {
    const explore = childOf("explore");
    expect(decideTool(explore, "read_file")).toBe("allow");
    expect(decideTool(explore, "grep")).toBe("allow");
    expect(decideTool(explore, "lsp")).toBe("allow");
    expect(decideTool(explore, "write_file")).toBe("deny");
    expect(decideTool(explore, "edit_file")).toBe("deny");
    expect(decideTool(explore, "create_artifact")).toBe("deny");
    expect(decideTool(explore, "shell")).toBe("deny");
    expect(decideTool(explore, "task")).toBe("deny");
  });

  test("coder may edit and execute but may not recursively spawn", () => {
    const coder = childOf("coder");
    expect(decideTool(coder, "read_file")).toBe("allow");
    expect(decideTool(coder, "write_file")).toBe("allow");
    expect(decideTool(coder, "edit_file")).toBe("allow");
    expect(decideTool(coder, "apply_patch")).toBe("allow");
    expect(decideTool(coder, "shell")).toBe("allow");
    expect(decideTool(coder, "task")).toBe("deny");
    expect(decideTool(coder, "spawn_subagent")).toBe("deny");
  });

  test("tester may run commands but may not modify source", () => {
    const tester = childOf("tester");
    expect(decideTool(tester, "shell")).toBe("allow");
    expect(decideTool(tester, "read_file")).toBe("allow");
    expect(decideTool(tester, "write_file")).toBe("deny");
    expect(decideTool(tester, "edit_file")).toBe("deny");
  });

  test("reviewer is strictly read-only", () => {
    const reviewer = childOf("reviewer");
    expect(decideTool(reviewer, "read_file")).toBe("allow");
    expect(decideTool(reviewer, "git_diff")).toBe("allow");
    expect(decideTool(reviewer, "write_file")).toBe("deny");
    expect(decideTool(reviewer, "shell")).toBe("deny");
  });

  test("general inherits the parent scope unchanged", () => {
    const general = childOf("general");
    for (const name of toolRegistry.canonicalNames()) {
      expect(decideTool(general, name)).toBe(decideTool(parent, name));
    }
  });

  test("plan mode denies mutations and execution", () => {
    const planScope = permissionScopeFromAgent(new AgentRegistry().get("plan")!);
    expect(decideTool(planScope, "write_file")).toBe("deny");
    expect(decideTool(planScope, "edit_file")).toBe("deny");
    expect(decideTool(planScope, "apply_patch")).toBe("deny");
    expect(decideTool(planScope, "shell")).toBe("deny");
    expect(decideTool(planScope, "read_file")).toBe("allow");
  });
});

// ── Child sessions ───────────────────────────────────────────────────────────

describe("SubagentSessionStore", () => {
  test("assigns deterministic, traceable child ids", () => {
    const store = new SubagentSessionStore();
    const a = store.create({ parentSessionId: "p1", agentId: "explore", prompt: "find auth", depth: 1 });
    const b = store.create({ parentSessionId: "p1", agentId: "explore", prompt: "find tests", depth: 1 });
    expect(a.id).toBe("sub:p1:explore:1");
    expect(b.id).toBe("sub:p1:explore:2");
    expect(a.parentSessionId).toBe("p1");
    expect(a.status).toBe("running");
  });

  test("keeps child transcripts isolated from the parent session", () => {
    const store = new SubagentSessionStore();
    const a = store.create({ parentSessionId: "p1", agentId: "coder", prompt: "fix bug", depth: 1 });
    store.appendMessages(a.id, [{ role: "assistant", content: "working" }]);
    const b = store.create({ parentSessionId: "p2", agentId: "coder", prompt: "other", depth: 1 });

    expect(store.get(a.id)!.messages.length).toBe(2);
    expect(store.get(b.id)!.messages.length).toBe(1);
    expect(store.listByParent("p1").map((s) => s.id)).toEqual([a.id]);
  });

  test("resume reuses the same session and appends the new prompt", () => {
    const store = new SubagentSessionStore();
    const a = store.create({ parentSessionId: "p1", agentId: "explore", prompt: "inspect auth", depth: 1 });
    store.finish(a.id, "completed");
    expect(store.get(a.id)!.status).toBe("completed");

    const resumed = store.resume(a.id, "now inspect the tests");
    expect(resumed?.id).toBe(a.id);
    expect(resumed?.status).toBe("running");
    expect(resumed?.messages.length).toBe(2);
    expect(resumed?.messages[1].content).toBe("now inspect the tests");
  });

  test("resuming an unknown id returns undefined", () => {
    const store = new SubagentSessionStore();
    expect(store.resume("nope", "x")).toBeUndefined();
  });

  test("finish records the terminal status and time", () => {
    const store = new SubagentSessionStore();
    const a = store.create({ parentSessionId: "p1", agentId: "tester", prompt: "run tests", depth: 1 });
    store.finish(a.id, "cancelled");
    const stored = store.get(a.id)!;
    expect(stored.status).toBe("cancelled");
    expect(typeof stored.completedAt).toBe("number");
  });
});

// ── Prompt composition ───────────────────────────────────────────────────────

describe("composeAgentPrompt", () => {
  test("states the granted tool scope and the no-fake-success rule", () => {
    const prompt = composeAgentPrompt({
      agent: new AgentRegistry().get("coder")!,
      grantedTools: ["read_file", "write_file", "shell"],
      workspaceRoot: "/tmp/ws",
      canSpawnSubagents: false,
    });

    expect(prompt).toContain("coder");
    expect(prompt).toContain("- read_file");
    expect(prompt).toContain("- write_file");
    expect(prompt).toContain("/tmp/ws");
    expect(prompt).toContain("Never claim that a file was created");
    expect(prompt).toContain("may not spawn further subagents");
  });

  test("reports when no tools were granted", () => {
    const prompt = composeAgentPrompt({
      agent: new AgentRegistry().get("explore")!,
      grantedTools: [],
      canSpawnSubagents: false,
    });
    expect(prompt).toContain("no tools granted");
  });
});

// ── Registry integration ─────────────────────────────────────────────────────

describe("task tool registration", () => {
  test("`task` is the model-visible delegation capability", () => {
    const names = toolRegistry.canonicalNames();
    expect(names).toContain("task");
    expect(toolRegistry.riskOf("task")).toBe("execute");
  });

  test("the legacy spawn alias is resolvable but never exposed to the model", () => {
    const schemaNames = toolRegistry.schemas().map((s) => (s as any).function.name);
    expect(schemaNames).toContain("task");
    expect(schemaNames).not.toContain("spawn_subagent");
    expect(toolRegistry.get("spawn_subagent")?.aliasOf).toBe("task");
  });

  test("depth defaults to a single level of nesting", () => {
    expect(DEFAULT_SUBAGENT_MAX_DEPTH).toBe(1);
  });
});

// ── Architecture guard ───────────────────────────────────────────────────────

describe("ARCHITECTURE — subagents share one kernel", () => {
  const agentsDir = path.join(__dirname, "../../core/agent/agents");

  function collectTs(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectTs(full, out);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      out.push(full);
    }
    return out;
  }

  test("no subagent module talks to a provider directly", () => {
    const offenders = collectTs(agentsDir).filter((file) => {
      const src = fs.readFileSync(file, "utf8");
      return /provider\.(chat|stream)\s*\(/.test(src) || /getActiveProvider\s*\(/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  test("no subagent module executes tools directly", () => {
    const offenders = collectTs(agentsDir).filter((file) => {
      const src = fs.readFileSync(file, "utf8");
      return /_executeToolRaw\s*\(|ToolGateway\.execute\s*\(/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  test("the manager drives the shared engine rather than its own loop", () => {
    const src = fs.readFileSync(path.join(agentsDir, "manager.ts"), "utf8");
    expect(src).toMatch(/agentEngine/);
    expect(src).toMatch(/toolRegistry\.schemasFiltered/);
    // No hand-rolled model loop: the engine owns it.
    expect(src).not.toMatch(/for\s+await\s*\(/);
    expect(src).not.toMatch(/while\s*\(/);
  });
});
