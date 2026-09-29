/**
 * Plan-mode runtime gates — the harness permission scope, proven against the
 * REAL AgentHarness dispatch path.
 *
 *  Scenario C (direct runtime call): a tool call for a denied tool under the
 *  plan scope is refused by the harness gate — it never reaches an executor.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentHarness } from "../../../lib/harness/agentHarness";
import { agentRegistry } from "../agents/registry";
import { permissionScopeFromAgent } from "../agents/permissions";
import { planPathForSession } from "../agents/planWriteTool";

// A real workspace: the harness resolves and realpath-checks its cwd, so a
// hardcoded path that does not exist denies even read-only tools.
const planWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-plan-"));

function planHarness(): AgentHarness {
  const plan = agentRegistry.resolve("plan");
  const harness = new AgentHarness({
    workspaceRoot: planWorkspace,
    currentCwd: planWorkspace,
    sessionId: "plan-sec-session",
    sandboxMode: "workspace",
  });
  // Inject the plan scope exactly as the TUI wiring does (options.toolPermissionSet).
  (harness as any).toolPermissions = permissionScopeFromAgent(plan);
  return harness;
}

describe("plan runtime — harness hard gate (scenario C)", () => {
  test("direct write_file call under plan scope is DENIED, never executed", async () => {
    const harness = planHarness();
    const outcome = await harness.dispatchTool("write_file", { path: "src/evil.ts", content: "no" });
    expect(outcome.allowed).toBe(false);
    const payload = JSON.parse(outcome.result);
    expect(String(payload.error || payload.stderr || "")).toContain("Permission Denied");
  });

  test("direct shell call under plan scope is DENIED", async () => {
    const harness = planHarness();
    const outcome = await harness.dispatchTool("shell", { command: "rm -rf /" });
    expect(outcome.allowed).toBe(false);
  });

  test("read tools still execute under the plan scope", async () => {
    const harness = planHarness();
    const outcome = await harness.dispatchTool("get_cwd", {});
    expect(outcome.allowed).toBe(true);
  });

  test("plan_write targets the exact per-session plan path", () => {
    // The only sanctioned write class is pinned server-side; the tool derives
    // the path from workspaceRoot + session, never from tool input.
    const p = planPathForSession(planWorkspace, "plan-sec-session");
    // Compare resolved paths: the pinned path is a literal string, so its
    // separators are not required to match the host's notation.
    expect(path.resolve(p)).toBe(path.resolve(planWorkspace, ".toolnet", "plans", "plan-sec-session.md"));
  });
});
