import { describe, test, expect, beforeEach } from "bun:test";
import { HookRegistry } from "../../core/hooks/registry";
import { HOOK_CLASS, HOOK_NAMES, isHookName } from "../../core/hooks/types";

/**
 * Phase 77.6–77.9 — hook lifecycle contract.
 *
 * These tests pin the properties the runtime depends on: deterministic order,
 * class-enforced decisions, fail-closed security hooks, and clean disposal.
 */

describe("hooks — contract tables", () => {
  test("every declared hook has a class and the pre-execution edges are blocking", () => {
    expect(HOOK_NAMES.length).toBeGreaterThan(0);
    for (const name of HOOK_NAMES) {
      expect(HOOK_CLASS[name]).toBeDefined();
    }
    // The veto points must be block-class or a plugin could not stop a side effect.
    expect(HOOK_CLASS["tool.before"]).toBe("block");
    expect(HOOK_CLASS["shell.before"]).toBe("block");
    expect(HOOK_CLASS["file.beforeWrite"]).toBe("block");
    // Observers must not be able to silently rewrite anything.
    expect(HOOK_CLASS["tool.error"]).toBe("observe");
    expect(HOOK_CLASS["agent.start"]).toBe("observe");
  });

  test("isHookName rejects typos", () => {
    expect(isHookName("tool.before")).toBe(true);
    expect(isHookName("tool.befor")).toBe(false);
    expect(isHookName("__proto__")).toBe(false);
  });
});

describe("hooks — registration", () => {
  test("unknown hook names are rejected loudly", () => {
    const registry = new HookRegistry();
    expect(() =>
      registry.register({ name: "not.a.hook" as never, handler: () => {}, owner: "test" }),
    ).toThrow(/Unknown hook name/);
  });

  test("a non-function handler is rejected", () => {
    const registry = new HookRegistry();
    expect(() =>
      registry.register({ name: "tool.before", handler: undefined as never, owner: "test" }),
    ).toThrow(/must be a function/);
  });

  test("unregisterOwner removes exactly that owner's hooks", () => {
    const registry = new HookRegistry();
    registry.register({ name: "tool.before", handler: () => {}, owner: "plugin:a" });
    registry.register({ name: "tool.before", handler: () => {}, owner: "plugin:b" });
    registry.register({ name: "agent.start", handler: () => {}, owner: "plugin:a" });

    expect(registry.unregisterOwner("plugin:a")).toBe(2);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]!.owner).toBe("plugin:b");
  });

  test("has() reports whether a lifecycle edge is observed", () => {
    const registry = new HookRegistry();
    expect(registry.has("tool.after")).toBe(false);
    registry.register({ name: "tool.after", handler: () => {}, owner: "p" });
    expect(registry.has("tool.after")).toBe(true);
  });
});

describe("hooks — execution order", () => {
  test("hooks run sequentially in registration order", () => {
    const registry = new HookRegistry();
    const seen: string[] = [];
    registry.register({ name: "tool.before", handler: () => void seen.push("a"), owner: "a" });
    registry.register({ name: "tool.before", handler: () => void seen.push("b"), owner: "b" });
    registry.register({ name: "tool.before", handler: () => void seen.push("c"), owner: "c" });

    return registry.run("tool.before", {}, { args: {} }).then((report) => {
      expect(seen).toEqual(["a", "b", "c"]);
      expect(report.invoked).toBe(3);
      expect(report.deniedBy).toBeUndefined();
    });
  });

  test("priority reorders execution but ties keep registration order", async () => {
    const registry = new HookRegistry();
    const seen: string[] = [];
    registry.register({ name: "tool.before", owner: "late", priority: 10, handler: () => void seen.push("late") });
    registry.register({ name: "tool.before", owner: "early", priority: -5, handler: () => void seen.push("early") });
    registry.register({ name: "tool.before", owner: "middle", priority: 0, handler: () => void seen.push("middle") });
    registry.register({ name: "tool.before", owner: "middle2", priority: 0, handler: () => void seen.push("middle2") });

    await registry.run("tool.before", {}, { args: {} });
    expect(seen).toEqual(["early", "middle", "middle2", "late"]);
  });

  test("running an edge with no hooks returns the payload untouched", async () => {
    const registry = new HookRegistry();
    const payload = { args: { a: 1 } };
    const report = await registry.run("tool.before", {}, payload);
    expect(report.invoked).toBe(0);
    expect(report.output).toBe(payload);
  });
});

describe("hooks — decisions", () => {
  test("a deny from a block-class hook stops the run and short-circuits later hooks", async () => {
    const registry = new HookRegistry();
    const seen: string[] = [];
    registry.register({
      name: "tool.before",
      owner: "guard",
      handler: () => ({ action: "deny", reason: "no writes today" }),
    });
    registry.register({ name: "tool.before", owner: "after", handler: () => void seen.push("after") });

    const report = await registry.run("tool.before", {}, { args: {} });
    expect(report.deniedBy).toEqual({ owner: "guard", reason: "no writes today" });
    // The later hook must not run once the operation is already vetoed.
    expect(seen).toEqual([]);
  });

  test("an observe-class hook returning deny is ignored, not honoured", async () => {
    const registry = new HookRegistry();
    registry.register({
      name: "tool.error",
      owner: "noisy",
      handler: () => ({ action: "deny", reason: "would love to block" }),
    });

    const report = await registry.run("tool.error", {}, { error: "x" });
    expect(report.deniedBy).toBeUndefined();
    expect(report.skipped).toContain("noisy");
  });

  test("a transform hook rewrites the payload handed to the next hook", async () => {
    const registry = new HookRegistry();
    const observed: Array<Record<string, unknown>> = [];

    registry.register({
      name: "tool.before",
      owner: "rewriter",
      handler: () => ({ action: "transform", args: { path: "/sanitized" } }),
    });
    registry.register({
      name: "tool.before",
      owner: "observer",
      handler: (invocation) => {
        observed.push(invocation.output as Record<string, unknown>);
      },
    });

    const report = await registry.run("tool.before", {}, { args: { path: "/etc/passwd" } });
    expect(observed).toEqual([{ path: "/sanitized" }]);
    expect(report.output).toEqual({ path: "/sanitized" });
  });

  test("an observe-class hook cannot transform", async () => {
    const registry = new HookRegistry();
    registry.register({
      name: "tool.error",
      owner: "sneaky",
      handler: () => ({ action: "transform", args: { error: "masked" } }),
    });

    const report = await registry.run("tool.error", {}, { error: "real" });
    expect(report.output).toEqual({ error: "real" });
    expect(report.skipped).toContain("sneaky");
  });

  test("returning nothing is treated as continue", async () => {
    const registry = new HookRegistry();
    registry.register({ name: "tool.after", owner: "silent", handler: () => undefined });
    const report = await registry.run("tool.after", {}, { result: "r" });
    expect(report.skipped).toContain("silent");
    expect(report.output).toEqual({ result: "r" });
  });
});

describe("hooks — failure policy", () => {
  test("a throwing observe hook warns and does not affect the payload", async () => {
    const warnings: Array<{ message: string; meta: Record<string, unknown> }> = [];
    const registry = new HookRegistry({
      onWarning: (message, meta) => warnings.push({ message, meta }),
    });
    registry.register({
      name: "agent.start",
      owner: "broken",
      handler: () => {
        throw new Error("boom");
      },
    });

    const report = await registry.run("agent.start", {}, { sessionId: "s" });
    expect(report.deniedBy).toBeUndefined();
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.policy).toBe("warn");
    expect(warnings.length).toBe(1);
  });

  test("a throwing blocking hook fails CLOSED — the operation is denied", async () => {
    const registry = new HookRegistry();
    registry.register({
      name: "tool.before",
      owner: "broken-guard",
      handler: () => {
        throw new Error("security hook unavailable");
      },
    });

    const report = await registry.run("tool.before", {}, { args: {} });
    expect(report.deniedBy).toBeDefined();
    expect(report.deniedBy!.owner).toBe("broken-guard");
    expect(report.deniedBy!.reason).toContain("security hook unavailable");
  });

  test("an explicit failurePolicy overrides the class default", async () => {
    const registry = new HookRegistry();
    registry.register({
      name: "tool.before",
      owner: "lenient",
      failurePolicy: "ignore",
      handler: () => {
        throw new Error("ignored");
      },
    });

    const report = await registry.run("tool.before", {}, { args: {} });
    expect(report.deniedBy).toBeUndefined();
    expect(report.failures[0]!.policy).toBe("ignore");
  });

  test("a slow hook is bounded by its timeout and the policy applies", async () => {
    const registry = new HookRegistry();
    registry.register({
      name: "tool.after",
      owner: "slow",
      timeoutMs: 25,
      handler: () => new Promise(() => {}),
    });

    const report = await registry.run("tool.after", {}, { result: "r" });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.error).toContain("timed out");
    expect(report.output).toEqual({ result: "r" });
  });

  test("a broken warning sink cannot break hook execution", async () => {
    const registry = new HookRegistry({
      onWarning: () => {
        throw new Error("sink exploded");
      },
    });
    registry.register({
      name: "agent.end",
      owner: "broken",
      handler: () => {
        throw new Error("x");
      },
    });

    const report = await registry.run("agent.end", {}, {});
    expect(report.failures).toHaveLength(1);
  });
});

describe("hooks — abort and dispose", () => {
  test("an aborted signal stops further hooks from running", async () => {
    const registry = new HookRegistry();
    const seen: string[] = [];
    registry.register({ name: "tool.before", owner: "a", handler: () => void seen.push("a") });
    registry.register({ name: "tool.before", owner: "b", handler: () => void seen.push("b") });

    const controller = new AbortController();
    controller.abort();
    await registry.run("tool.before", {}, { args: {} }, { signal: controller.signal });
    expect(seen).toEqual([]);
  });

  test("dispose clears registrations and rejects later registration", async () => {
    const registry = new HookRegistry();
    registry.register({ name: "tool.before", owner: "a", handler: () => {} });
    registry.dispose();
    expect(registry.list()).toHaveLength(0);
    expect(() => registry.register({ name: "tool.before", owner: "b", handler: () => {} })).toThrow(
      /disposed/,
    );
  });

  test("reset allows re-initialization", async () => {
    const registry = new HookRegistry();
    registry.register({ name: "tool.before", owner: "a", handler: () => {} });
    registry.dispose();
    registry.reset();
    registry.register({ name: "tool.after", owner: "b", handler: () => {} });
    expect(registry.list()).toHaveLength(1);
  });
});
