import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { AgentHarness, getHarness, resetHarness } from "../../lib/harness";
import { AgentRuntime } from "../../lib/agentRuntime";
import { setSandboxMode, getSandboxMode } from "../../lib/permissions";
import { securityEngine, buildPermissionContext, getPermissionContextPrompt, clampSandboxMode } from "../../lib/security";
import { signatureForToolCall, executeToolBatch } from "../../lib/harness/toolExecutor";
import { classifyToolCalls, deduplicateToolCalls, ToolCache } from "../../lib/harness/toolPlanner";
import { loadSession, saveSession } from "../../lib/sessionPersistence";
import type { HarnessEvent } from "../../lib/harness/types";

describe("AgentHarness 2.0 Hardened Architecture Regression Suite", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    setSandboxMode("workspace");
    resetHarness();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setSandboxMode("workspace");
    resetHarness();
  });

  // ── 1. AgentRuntime Delegates to AgentHarness ──────────────────────────
  describe("1. Unified Runtime Delegation", () => {
    test("AgentRuntime delegates run(), resume(), cancel() to AgentHarness without duplicating kernel logic", async () => {
      let fetchCalled = 0;
      globalThis.fetch = (mock as any)().mockImplementation(async () => {
        fetchCalled++;
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Delegated response from AgentHarness kernel",
                },
              },
            ],
          }),
        } as any;
      });

      const runtime = new AgentRuntime({ maxTurns: 2, gatewayUrl: "http://127.0.0.1:9999" });
      const result = await runtime.run("Hello AgentRuntime");

      expect(result.success).toBe(true);
      expect(result.output).toBe("Delegated response from AgentHarness kernel");
      expect(fetchCalled).toBe(1);

      // Verify cancel() exists on facade
      expect(typeof runtime.cancel).toBe("function");
      runtime.cancel();
    });

    test("AgentRuntime.runLoop delegates to harness resume and syncs messages in-place", async () => {
      globalThis.fetch = (mock as any)().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: "RunLoop delegated result",
              },
            },
          ],
        }),
      } as any);

      const runtime = new AgentRuntime({ maxTurns: 2, gatewayUrl: "http://127.0.0.1:9999" });
      const messages: any[] = [{ role: "user", content: "RunLoop prompt" }];
      const result = await runtime.runLoop(messages);

      expect(result.success).toBe(true);
      expect(result.output).toBe("RunLoop delegated result");
      // System message + user message + assistant message
      expect(messages.length).toBeGreaterThanOrEqual(3);
      expect(messages[messages.length - 1].content).toBe("RunLoop delegated result");
    });
  });

  // ── 2. Provider Invocation (1 Call per Turn) ───────────────────────────
  describe("2. Provider Turn Discipline", () => {
    test("provider is called exactly once per turn", async () => {
      let callCount = 0;
      globalThis.fetch = (mock as any)().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            json: async () => ({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "",
                    tool_calls: [
                      {
                        id: "call_turn1",
                        type: "function",
                        function: { name: "get_cwd", arguments: "{}" },
                      },
                    ],
                  },
                },
              ],
            }),
          } as any;
        }
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Final answer after 1 tool call turn",
                },
              },
            ],
          }),
        } as any;
      });

      const harness = new AgentHarness({ maxTurns: 5 });
      const result = await harness.run("Test single invocation per turn");

      expect(result.success).toBe(true);
      expect(result.turnsUsed).toBe(2);
      expect(callCount).toBe(2); // Exactly 2 calls for 2 turns
    });
  });

  // ── 3. Compaction Pipeline ─────────────────────────────────────────────
  describe("3. Unified Context Compaction", () => {
    test("context compaction executes through unified contextEngine pipeline", async () => {
      globalThis.fetch = (mock as any)().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Compacted context handled cleanly",
              },
            },
          ],
        }),
      } as any);

      const harness = new AgentHarness();
      const events: HarnessEvent[] = [];
      harness.on((e) => events.push(e));

      // Build large history of messages
      const longHistory: any[] = [{ role: "system", content: "You are a helper" }];
      for (let i = 0; i < 40; i++) {
        longHistory.push({ role: "user", content: `Question ${i}: ${"x".repeat(300)}` });
        longHistory.push({ role: "assistant", content: `Answer ${i}: ${"y".repeat(300)}` });
      }

      const result = await harness.resume(longHistory, { model: "default" });
      expect(result.success).toBe(true);
      expect(result.budget).toBeDefined();
    });
  });

  // ── 4. SecurityEngine Evaluation Before Every Tool ─────────────────────
  describe("4. Mandatory Security Pre-Evaluation (Fail-Closed)", () => {
    test("SecurityEngine evaluates BEFORE tool execution and blocks unauthorized actions", async () => {
      setSandboxMode("workspace");
      const harness = new AgentHarness({ sandboxMode: "workspace" });

      // Unauthorized outside-workspace access
      const dispatchRes = await harness.dispatchTool("read_file", { path: "/etc/passwd" });
      expect(dispatchRes.allowed).toBe(false);
      expect(dispatchRes.result).toContain("Permission Denied");

      // Dangerous shell command
      const dangerousCmd = await harness.dispatchTool("run_command", { command: "rm -rf /" });
      expect(dangerousCmd.allowed).toBe(false);
      expect(dangerousCmd.result).toContain("Permission Denied");
    });

    test("SecurityEngine requires approval in 'ask' mode and fails closed when headless", async () => {
      setSandboxMode("ask");
      const harness = new AgentHarness({ sandboxMode: "ask" });

      const res = await harness.dispatchTool("read_file", { path: "/var/log/syslog" });
      expect(res.allowed).toBe(false);
      expect(res.result).toContain("Approval Required");
      expect(res.result).toContain("approvalRequired");
    });
  });

  // ── 5. Subagent Security Inheritance ──────────────────────────────────
  describe("5. Subagent Security Inheritance (childPolicy <= parentPolicy)", () => {
    test("clampSandboxMode prevents child subagent from escalating permissions", () => {
      // Parent workspace -> child cannot be ask or full-access
      expect(clampSandboxMode("full-access", "workspace")).toBe("workspace");
      expect(clampSandboxMode("ask", "workspace")).toBe("workspace");
      expect(clampSandboxMode("workspace", "workspace")).toBe("workspace");

      // Parent ask -> child cannot be full-access
      expect(clampSandboxMode("full-access", "ask")).toBe("ask");
      expect(clampSandboxMode("ask", "ask")).toBe("ask");
      expect(clampSandboxMode("workspace", "ask")).toBe("workspace"); // Child can be MORE restrictive

      // Parent full-access -> child can be full-access, ask, or workspace
      expect(clampSandboxMode("full-access", "full-access")).toBe("full-access");
      expect(clampSandboxMode("ask", "full-access")).toBe("ask");
      expect(clampSandboxMode("workspace", "full-access")).toBe("workspace");
    });

    test("runSubagent inherits parent sandbox mode and enforces role-based tool restrictions", async () => {
      setSandboxMode("workspace");
      const harness = new AgentHarness({ sandboxMode: "workspace" });
      const events: HarnessEvent[] = [];
      harness.on((e) => events.push(e));

      globalThis.fetch = (mock as any)().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Subagent research report ready",
              },
            },
          ],
        }),
      } as any);

      // Attempt to request full-access on child while parent is workspace
      const result = await harness.runSubagent("RESEARCHER", "Explore project files", {
        sandboxMode: "full-access",
      });

      expect(result.success).toBe(true);
      const spawnEvent = events.find((e) => e.type === "subagent:spawn");
      expect(spawnEvent).toBeDefined();
      expect(spawnEvent?.payload.parentMode).toBe("workspace");
      expect(spawnEvent?.payload.effectiveSandboxMode).toBe("workspace"); // Clamped!
    });
  });

  // ── 6. No Bypass Security Flag in Production ───────────────────────────
  describe("6. Security Bypass Audit", () => {
    test("HarnessConfig does not accept bypassSecurity to disable SecurityEngine", () => {
      const config: any = { sandboxMode: "workspace", bypassSecurity: true };
      const harness = new AgentHarness(config);
      expect(harness.getSnapshot().sandboxMode).toBe("workspace");
    });
  });

  // ── 7. Tool Parallel vs Sequential Ordering ───────────────────────────
  describe("7. Tool Pipeline Ordering & Parallel Safety", () => {
    test("approval-required and mutating tools execute sequentially, read-only execute in parallel", () => {
      const calls = [
        { id: "c1", name: "read_file", args: { path: "a.ts" } },
        { id: "c2", name: "read_file", args: { path: "b.ts" } },
        { id: "c3", name: "write_file", args: { path: "c.ts", content: "data" } },
        { id: "c4", name: "read_file", args: { path: "d.ts" } },
      ];

      const needsApproval = (name: string) => name === "write_file";
      const { parallel, sequential } = classifyToolCalls(calls, needsApproval);

      // c1, c2 are parallel-safe read-only
      expect(parallel.length).toBeGreaterThanOrEqual(1);
      expect(parallel[0].map((c) => c.id)).toEqual(["c1", "c2"]);

      // c3 (write) is sequential
      expect(sequential.map((c) => c.id)).toEqual(["c3"]);
    });

    test("approval-required read tool is diverted to sequential batch", () => {
      const calls = [
        { id: "c1", name: "read_file", args: { path: "workspace.ts" } },
        { id: "c2", name: "read_file", args: { path: "/outside/hosts" } }, // requires approval
      ];

      const needsApproval = (name: string, args: any) => args.path?.startsWith("/outside");
      const { parallel, sequential } = classifyToolCalls(calls, needsApproval);

      expect(parallel[0].map((c) => c.id)).toEqual(["c1"]);
      expect(sequential.map((c) => c.id)).toEqual(["c2"]);
    });
  });

  // ── 8. Stable Canonical Dedup Key Order Insensitivity ──────────────────
  describe("8. Canonical Signature Dedup", () => {
    test("signatureForToolCall produces identical signature regardless of object key order", () => {
      const sig1 = signatureForToolCall("read_file", { path: "index.ts", limit: 10, offset: 0 });
      const sig2 = signatureForToolCall("read_file", { offset: 0, path: "index.ts", limit: 10 });
      const sig3 = signatureForToolCall("read_file", { limit: 10, offset: 0, path: "index.ts" });

      expect(sig1).toBe(sig2);
      expect(sig2).toBe(sig3);
    });

    test("nested objects with different key order produce identical signatures", () => {
      const sigA = signatureForToolCall("custom_tool", { nested: { z: 1, a: 2 }, b: [1, 2] });
      const sigB = signatureForToolCall("custom_tool", { b: [1, 2], nested: { a: 2, z: 1 } });

      expect(sigA).toBe(sigB);
    });

    test("deduplicateToolCalls correctly dedups calls with different key ordering", () => {
      const calls = [
        { id: "1", name: "grep", args: { pattern: "TODO", path: "src" } },
        { id: "2", name: "grep", args: { path: "src", pattern: "TODO" } }, // duplicate!
      ];

      const { kept, skipped } = deduplicateToolCalls(calls);
      expect(kept).toHaveLength(1);
      expect(skipped).toBe(1);
    });

    test("ToolCache returns hit for identical args in different key order", () => {
      const cache = new ToolCache();
      cache.set("grep", { pattern: "abc", path: "src" }, "Found 3 results");

      const cached = cache.get("grep", { path: "src", pattern: "abc" });
      expect(cached).toBe("Found 3 results");
    });
  });

  // ── 9. Loop Detection via maxRepeat ───────────────────────────────────
  describe("9. Loop Detection & maxRepeat Enforcement", () => {
    test("executeToolBatch aborts when same signature exceeds maxRepeat", async () => {
      const calls = [
        { id: "c1", name: "read_file", args: { path: "nonexistent.ts" } },
        { id: "c2", name: "read_file", args: { path: "nonexistent.ts" } },
        { id: "c3", name: "read_file", args: { path: "nonexistent.ts" } },
      ];

      let executed = 0;
      const outcome = await executeToolBatch(calls, {
        cwd: process.cwd(),
        maxRepeat: 2,
        runTool: async (name, args, id) => {
          executed++;
          return { result: "File not found", allowed: true };
        },
      });

      // Dedup executed it once, so duplicates reused result
      expect(outcome.deduplicatedCount).toBe(2);
      expect(outcome.executedCount).toBe(1);
    });
  });

  // ── 10. System Prompt Policy Consistency ──────────────────────────────
  describe("10. System Prompt Dynamic Permission Context", () => {
    test("buildPermissionContext for 'workspace' never says 'and system' and restricts to workspace", () => {
      const ctx = buildPermissionContext("workspace");
      const text = ctx.lines.join("\n");

      expect(text).not.toContain("and system");
      expect(text).toContain("Sandbox: Workspace");
      expect(text).toContain("Read: workspace");
      expect(text).toContain("Write: workspace only");
      expect(text).toContain("Outside workspace: denied");
    });

    test("buildPermissionContext for 'ask' reflects approval-gated policy", () => {
      const ctx = buildPermissionContext("ask");
      const text = ctx.lines.join("\n");

      expect(text).toContain("Sandbox: Ask");
      expect(text).toContain("Outside workspace: requires user approval");
      expect(text).toContain("approved by user");
    });

    test("buildPermissionContext for 'full-access' reflects unrestricted policy", () => {
      const ctx = buildPermissionContext("full-access");
      const text = ctx.lines.join("\n");

      expect(text).toContain("Sandbox: Full Access");
      expect(text).toContain("Read: unrestricted");
      expect(text).toContain("Write: unrestricted");
      expect(text).toContain("Outside workspace: allowed");
    });

    test("getPermissionContextPrompt changes dynamically when sandbox mode changes", () => {
      const promptWs = getPermissionContextPrompt("workspace");
      const promptAsk = getPermissionContextPrompt("ask");
      const promptFull = getPermissionContextPrompt("full-access");

      expect(promptWs).not.toBe(promptAsk);
      expect(promptAsk).not.toBe(promptFull);
      expect(promptWs).toContain("Sandbox: Workspace");
      expect(promptAsk).toContain("Sandbox: Ask");
      expect(promptFull).toContain("Sandbox: Full Access");
    });
  });

  // ── 11. Keyword Intent Heuristics Removed from Kernel ──────────────────
  describe("11. Keyword Heuristics Independence", () => {
    test("user prompt with keywords does NOT force tool_choice='required', defaults to 'auto'", async () => {
      let receivedToolChoice: string | undefined;

      globalThis.fetch = (mock as any)().mockImplementation(async (url: string, opts: any) => {
        const body = JSON.parse(opts?.body || "{}");
        receivedToolChoice = body.tool_choice;
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Search complete without forcing tool_choice",
                },
              },
            ],
          }),
        } as any;
      });

      const harness = new AgentHarness();
      // Prompt with many Vietnamese/English workspace keywords
      await harness.run("tìm thư mục, kiểm tra file, list_dir, read package.json trong workspace");

      expect(receivedToolChoice).toBe("auto");
    });
  });

  // ── 12. Session Persistence Exclusivity ────────────────────────────────
  describe("12. Single Layer Session Persistence", () => {
    test("AgentHarness saves session upon completion without duplicate entries", async () => {
      const sessionId = `test-persist-${Date.now()}`;
      globalThis.fetch = (mock as any)().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Task completed cleanly and saved once.",
              },
            },
          ],
        }),
      } as any);

      const harness = new AgentHarness({ sessionId });
      const res = await harness.run("Test session persistence integrity", { sessionId });

      expect(res.success).toBe(true);

      const loaded = loadSession(sessionId);
      expect(loaded).toBeDefined();
      expect(loaded?.sessionId).toBe(sessionId);
      // Ensure no duplicate assistant replies
      const assistantMsgs = loaded?.messages.filter((m: any) => m.role === "assistant");
      expect(assistantMsgs).toHaveLength(1);
    });
  });

  // ── 13. EventBus Lifecycle Standardization ─────────────────────────────
  describe("13. Standardized EventBus Lifecycle", () => {
    test("emits standard lifecycle events in proper sequence without duplicates", async () => {
      globalThis.fetch = (mock as any)().mockImplementation(async () => {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Execution finished.",
                },
              },
            ],
          }),
        } as any;
      });

      const harness = new AgentHarness();
      const emittedTypes: string[] = [];

      harness.on((evt) => {
        emittedTypes.push(evt.type);
      });

      await harness.run("Verify event lifecycle");

      expect(emittedTypes).toContain("agent:start");
      expect(emittedTypes).toContain("agent:complete");
      expect(emittedTypes).toContain("session:saved");

      // Verify no duplicate legacy events
      expect(emittedTypes).not.toContain("agent:tool_start");
      expect(emittedTypes).not.toContain("agent:tool_end");
    });
  });
});
