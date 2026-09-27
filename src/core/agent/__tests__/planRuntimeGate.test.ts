/**
 * Plan-mode runtime gates — the harness permission scope, proven against the
 * REAL AgentHarness dispatch path.
 *
 *  Scenario C (direct runtime call): a tool call for a denied tool under the
 *  plan scope is refused by the harness gate — it never reaches an executor.
 */

import { describe, expect, test } from "bun:test";
import { AgentHarness } from "../../../lib/harness/agentHarness";
import { agentRegistry } from "../agents/registry";
import { permissionScopeFromAgent } from "../agents/permissions";
import { planPathForSession } from "../agents/planWriteTool";

function planHarness(): AgentHarness {
  const plan = agentRegistry.resolve("plan");
  const harness = new AgentHarness({
    workspaceRoot: "/tmp/toolnet-plan-test",
    currentCwd: "/tmp/toolnet-plan-test",
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
    const p = planPathForSession("/tmp/toolnet-plan-test", "plan-sec-session");
    expect(p).toBe("/tmp/toolnet-plan-test/.toolnet/plans/plan-sec-session.md");
  });
});
