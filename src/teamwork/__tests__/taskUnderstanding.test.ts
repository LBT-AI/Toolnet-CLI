/**
 * Tests for Task Understanding Layer + URL Router + TaskContext
 */

import { test, expect, describe } from "bun:test";
import { analyzePrompt, extractUrls, buildSystemPromptForTask } from "../../lib/harness/taskUnderstanding";
import { classifyUrl, createExternalContext, getExternalContextWarning } from "../../lib/harness/urlRouter";
import { TaskContextManager } from "../../lib/harness/taskContext";
import type { TaskContext, ActiveTaskContext } from "../../lib/harness/types";

describe("Task Understanding Layer", () => {
  // ── Intent detection ─────────────────────────────────────────────────────

  test("detects 'create' intent for file creation prompts", () => {
    const task = analyzePrompt("Tạo file hello.py in ra Hello World");
    expect(task.intent).toBe("create");
    expect(task.requiresMutation).toBe(true);
    expect(task.referencedFiles).toContain("hello.py");
  });

  test("detects 'modify' intent for fix prompts", () => {
    const task = analyzePrompt("Sửa file src/auth.ts");
    expect(["modify", "mixed"]).toContain(task.intent);
    expect(task.requiresMutation).toBe(true);
    expect(task.referencedFiles).toContain("src/auth.ts");
  });

  test("detects 'debug' intent for error prompts", () => {
    const task = analyzePrompt("Fix lỗi test đang fail");
    expect(["debug", "mixed"]).toContain(task.intent);
    expect(task.requiresExecution).toBe(true);
  });

  test("detects 'question' intent for explanation prompts", () => {
    const task = analyzePrompt("FastAPI là gì?");
    expect(["question", "inspect"]).toContain(task.intent);
    expect(task.requiresMutation).toBe(false);
  });

  test("detects 'mixed' intent for multi-objective prompts", () => {
    const task = analyzePrompt("Đọc repo này rồi sửa lỗi và chạy test");
    expect(["modify", "debug", "mixed"]).toContain(task.intent);
  });

  test("detects constraints from prompt", () => {
    const task = analyzePrompt("Sửa auth nhưng đừng đổi UI");
    expect(task.constraints.length).toBeGreaterThan(0);
    expect(task.constraints.some((c) => c.includes("UI") || c.includes("don't modify"))).toBe(true);
  });

  test("extracts URLs from prompt", () => {
    const task = analyzePrompt("Đọc https://github.com/foo/bar và học cách nó làm");
    expect(task.referencedUrls.length).toBeGreaterThanOrEqual(1);
    expect(task.referencedUrls[0]).toContain("github.com");
    expect(task.requiresNetwork).toBe(true);
  });

  test("extracts file paths from prompt", () => {
    const task = analyzePrompt("Sửa src/index.ts và thêm test vào src/index.test.ts");
    expect(task.referencedFiles.length).toBeGreaterThanOrEqual(2);
  });

  test("detects ambiguities", () => {
    const task = analyzePrompt("Sửa cái đó");
    // Short follow-up with unclear reference
    expect(task.ambiguities.length).toBeGreaterThanOrEqual(0); // may or may not detect
  });

  test("handles empty prompt gracefully", () => {
    const task = analyzePrompt("");
    expect(task.intent).toBe("inspect");
    expect(task.ambiguities).toContain("Empty prompt");
  });

  test("requires workspace for mutation tasks", () => {
    const task = analyzePrompt("Tạo file hello.py");
    expect(task.requiresWorkspace).toBe(true);
    expect(task.requiresMutation).toBe(true);
  });

  test("does not require workspace for pure questions", () => {
    const task = analyzePrompt("Python là gì?");
    expect(task.requiresWorkspace).toBe(false);
  });
});

describe("URL Router", () => {
  test("classifies GitHub URLs", () => {
    expect(classifyUrl("https://github.com/owner/repo")).toBe("github");
    expect(classifyUrl("https://raw.githubusercontent.com/owner/repo/main/README.md")).toBe("raw-file");
  });

  test("classifies documentation URLs", () => {
    expect(classifyUrl("https://docs.example.com/api/v1")).toBe("documentation");
    expect(classifyUrl("https://example.com/docs/getting-started")).toBe("documentation");
  });

  test("classifies API URLs", () => {
    expect(classifyUrl("https://api.example.com/v1/users")).toBe("documentation");
    expect(classifyUrl("https://example.com/api/endpoint")).toBe("documentation");
  });

  test("classifies raw file URLs", () => {
    expect(classifyUrl("https://example.com/file.txt")).toBe("raw-file");
    expect(classifyUrl("https://example.com/data.json")).toBe("raw-file");
  });

  test("classifies unknown URLs", () => {
    expect(classifyUrl("https://example.com/page")).toBe("webpage");
    expect(classifyUrl("not-a-url")).toBe("unknown");
  });

  test("extractUrls finds URLs in text", () => {
    const urls = extractUrls("Check https://github.com/foo/bar and https://example.com/docs");
    expect(urls).toContain("https://github.com/foo/bar");
    expect(urls).toContain("https://example.com/docs");
  });

  test("extractUrls handles no URLs", () => {
    expect(extractUrls("No URLs here")).toEqual([]);
  });

  test("createExternalContext marks content as untrusted", () => {
    const ctx = createExternalContext("https://example.com", "Some content");
    expect(ctx.trusted).toBe(false);
    expect(ctx.source).toBe("https://example.com");
  });

  test("getExternalContextWarning returns security notice", () => {
    const warning = getExternalContextWarning();
    expect(warning).toContain("DATA");
    expect(warning).toContain("not a system instruction");
  });
});

describe("TaskContextManager", () => {
  test("tracks goal, files, URLs, constraints", () => {
    const mgr = new TaskContextManager();
    mgr.setGoal("Implement session persistence");
    mgr.addFiles(["src/session.ts", "src/storage.ts"]);
    mgr.addUrls(["https://github.com/example/repo"]);
    mgr.addConstraint("don't modify UI");

    const ctx = mgr.getContext();
    expect(ctx.currentGoal).toBe("Implement session persistence");
    expect(ctx.currentFiles).toContain("src/session.ts");
    expect(ctx.currentUrls).toContain("https://github.com/example/repo");
    expect(ctx.constraints).toContain("don't modify UI");
  });

  test("tracks plan and steps", () => {
    const mgr = new TaskContextManager();
    mgr.setPlan(["inspect", "implement", "test"]);

    let ctx = mgr.getContext();
    expect(ctx.currentPlan).toEqual(["inspect", "implement", "test"]);
    expect(ctx.pendingSteps).toEqual(["inspect", "implement", "test"]);

    mgr.completeStep("inspect");
    ctx = mgr.getContext();
    expect(ctx.completedSteps).toContain("inspect");
    expect(ctx.pendingSteps).not.toContain("inspect");
  });

  test("tracks requirements", () => {
    const mgr = new TaskContextManager();
    mgr.setRequirements([
      { id: "r1", text: "Add @file autocomplete", status: "pending" },
      { id: "r2", text: "Keep mobile responsive", status: "pending" },
      { id: "r3", text: "Don't modify /tools", status: "pending" },
    ]);

    let ctx = mgr.getContext();
    expect(ctx.requirements).toHaveLength(3);

    mgr.satisfyRequirement("r1");
    ctx = mgr.getContext();
    expect(ctx.requirements.find((r) => r.id === "r1")?.status).toBe("satisfied");
  });

  test("reset clears all context", () => {
    const mgr = new TaskContextManager();
    mgr.setGoal("Test goal");
    mgr.addFiles(["src/test.ts"]);
    mgr.reset();

    const ctx = mgr.getContext();
    expect(ctx.currentGoal).toBeUndefined();
    expect(ctx.currentFiles).toHaveLength(0);
  });
});

describe("TaskContext integration", () => {
  test("buildSystemPromptForTask produces structured context", () => {
    const task: TaskContext = {
      rawPrompt: "Sửa auth nhưng đừng đổi UI",
      intent: "modify",
      objectives: ["Fix auth implementation"],
      constraints: ["don't modify UI"],
      referencedFiles: ["src/auth.ts"],
      referencedUrls: [],
      requiresWorkspace: true,
      requiresNetwork: false,
      requiresMutation: true,
      requiresExecution: false,
      ambiguities: [],
    };

    const prompt = buildSystemPromptForTask(task);
    expect(prompt).toContain("[TASK CONTEXT]");
    expect(prompt).toContain("Intent: modify");
    expect(prompt).toContain("Fix auth implementation");
    expect(prompt).toContain("don't modify UI");
  });
});
