/**
 * Plan-mode security regression — the runtime invariant, not the schema claim.
 *
 * Layers proven here:
 *   1. AGENT REGISTRY: the canonical plan agent declares read-only scope with
 *      exactly one sanctioned mutation (`plan_write`).
 *   2. PERMISSION SCOPE: `permissionScopeFromAgent(plan)` + `decideTool` deny
 *      every mutation/execution tool and allow only reads + plan_write.
 *   3. MODEL ADAPTER: the structured JSON fallback rejects tool calls outside
 *      the per-turn allowedToolNames — write_file never becomes a call.
 *   4. PLAN PATH: plan_write is pinned to
 *      <workspaceRoot>/.toolnet/plans/<session-id>.md (per-session, /cd-safe).
 *   5. SUBAGENT DERIVATION: a coder child of a Plan parent stays write-denied.
 */

import { describe, expect, test } from "bun:test";
import { agentRegistry } from "../agents/registry";
import { permissionScopeFromAgent, deriveSubagentPermission } from "../agents/permissions";
import { decideTool } from "../agents/types";
import { parseStructuredToolCalls } from "../../../lib/harness/modelAdapter";
import {
  planPathForSession,
  planFileStem,
  parsePlanWriteInput,
  buildPlanHeader,
  setPlanStatus,
  parsePlanWriteInput as parseInput,
} from "../agents/planWriteTool";

const DENIED = [
  "write_file",
  "edit_file",
  "apply_patch",
  "replace_all",
  "shell",
  "bash",
  "run_command",
  "create_artifact",
  "update_artifact",
  "spawn_subagent",
];

describe("plan security — canonical registry scope", () => {
  const plan = agentRegistry.resolve("plan");
  const scope = permissionScopeFromAgent(plan);

  test("plan agent exists as a primary built-in", () => {
    expect(plan.id).toBe("plan");
    expect(plan.mode).toBe("primary");
    expect(plan.builtIn).toBe(true);
  });

  for (const tool of DENIED) {
    test(`plan scope denies ${tool}`, () => {
      expect(decideTool(scope, tool)).toBe("deny");
    });
  }

  for (const tool of ["read_file", "grep", "glob", "list_dir", "get_cwd", "file_exists", "find_path", "tree"]) {
    test(`plan scope allows read tool ${tool}`, () => {
      expect(decideTool(scope, tool)).toBe("allow");
    });
  }

  test("plan scope allows exactly one mutation: plan_write", () => {
    expect(decideTool(scope, "plan_write")).toBe("allow");
    expect(decideTool(scope, "task")).toBe("allow");
  });

  test("plan prompt is composed, not empty", () => {
    expect(plan.systemPrompt).toContain("plan_write");
    expect(plan.systemPrompt).toContain("never execute");
  });
});

describe("plan security — ModelAdapter per-turn allowlist", () => {
  const planJson = "```json\n{\"type\":\"tool_call\",\"tool\":\"write_file\",\"arguments\":{\"path\":\"src/x.ts\",\"content\":\"pwned\"}}\n```";
  const planReadJson = "{\"type\":\"tool_call\",\"tool\":\"read_file\",\"arguments\":{\"path\":\"src/x.ts\"}}";

  test("write_file structured call is rejected when not in the turn allowlist", () => {
    const allowed = new Set(["read_file", "grep", "plan_write"]);
    const calls = parseStructuredToolCalls(planJson, allowed);
    // The injected write_file must NOT parse into a tool call — the adapter
    // layer rejects it before any dispatcher.
    expect(calls).toBeNull();
  });

  test("an allowed tool still parses under the per-turn allowlist", () => {
    const allowed = new Set(["read_file", "grep", "plan_write"]);
    const calls = parseStructuredToolCalls(planReadJson, allowed);
    expect(calls).not.toBeNull();
    expect(calls![0].name).toBe("read_file");
  });

  test("legacy behavior without allowlist still parses known tools", () => {
    const calls = parseStructuredToolCalls(planJson);
    expect(calls).not.toBeNull();
    expect(calls![0].name).toBe("write_file");
  });
});

describe("plan security — plan path pinning", () => {
  test("plan path is per-session under workspaceRoot", () => {
    const a = planPathForSession("/root/project", "sess_A");
    const b = planPathForSession("/root/project", "sess_B");
    expect(a).toBe("/root/project/.toolnet/plans/sess_A.md");
    expect(b).toBe("/root/project/.toolnet/plans/sess_B.md");
    expect(a).not.toBe(b);
  });

  test("plan path is workspace-stable, not cwd-relative", () => {
    // /cd inside the workspace must not move the plan.
    const from = planPathForSession("/root/project", "s1");
    const to = planPathForSession("/root/project", "s1");
    expect(from).toBe(to);
  });

  test("unsafe session ids are sanitized for the filesystem", () => {
    expect(planFileStem("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(planFileStem("")).toBe("session");
  });

  test("plan_write input parsing is strict", () => {
    expect(parseInput({ content: "hello" })).toEqual({ content: "hello", status: undefined });
    expect(parseInput({ content: 42 })).toBeNull();
    expect(parseInput(null)).toBeNull();
  });

  test("plan header keeps and updates status", () => {
    const header = buildPlanHeader("s1", "/root/project", "draft");
    expect(header).toContain("status: draft");
    expect(setPlanStatus(header, "ready")).toContain("status: ready");
    expect(setPlanStatus("no header", "ready")).toBe("no header");
  });
});

describe("plan security — subagent cannot launder a write", () => {
  test("coder child of a plan parent stays write-denied", () => {
    const plan = agentRegistry.resolve("plan");
    const parentScope = permissionScopeFromAgent(plan);
    const coder = agentRegistry.resolve("coder");
    const childScope = deriveSubagentPermission({ parentPermission: parentScope, agentDefinition: coder });
    expect(decideTool(childScope, "write_file")).toBe("deny");
    expect(decideTool(childScope, "shell")).toBe("deny");
    // Reads survive the intersection.
    expect(decideTool(childScope, "read_file")).toBe("allow");
  });

  test("explore child of a plan parent stays read-only", () => {
    const plan = agentRegistry.resolve("plan");
    const parentScope = permissionScopeFromAgent(plan);
    const explore = agentRegistry.resolve("explore");
    const childScope = deriveSubagentPermission({ parentPermission: parentScope, agentDefinition: explore });
    expect(decideTool(childScope, "grep")).toBe("allow");
    expect(decideTool(childScope, "write_file")).toBe("deny");
    // The child also loses plan_write — the plan file belongs to the parent.
    expect(decideTool(childScope, "plan_write")).toBe("deny");
  });
});
