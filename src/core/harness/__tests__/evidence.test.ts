/**
 * Phase 81 §12 — execution evidence derived from the existing event bus.
 */

import { describe, expect, it } from "bun:test";
import {
  ExecutionEvidenceCollector,
  commandFromArgs,
  emptyExecutionEvidence,
  isMutationTool,
  isReadTool,
  isShellTool,
  looksLikeTestCommand,
  looksLikeVerificationCommand,
  toolFileTarget,
} from "..";

function collect(events: Array<{ type: string; payload?: Record<string, unknown> }>) {
  const collector = new ExecutionEvidenceCollector();
  for (const event of events) collector.observe(event);
  return collector;
}

describe("Phase 81 §12 — canonical tool classification", () => {
  it("classifies mutation, shell and read tools", () => {
    expect(isMutationTool("write_file")).toBe(true);
    expect(isMutationTool("edit_file")).toBe(true);
    expect(isMutationTool("read_file")).toBe(false);
    expect(isShellTool("shell")).toBe(true);
    expect(isShellTool("bash")).toBe(true);
    expect(isReadTool("grep")).toBe(true);
    expect(isReadTool("write_file")).toBe(false);
  });

  it("extracts the command only from shell tools", () => {
    expect(commandFromArgs("shell", { command: "ls" })).toBe("ls");
    expect(commandFromArgs("shell", { cmd: "pwd" })).toBe("pwd");
    expect(commandFromArgs("read_file", { command: "ls" })).toBe("");
  });

  it("recognises test and verification commands", () => {
    expect(looksLikeTestCommand("shell", { command: "bun test" })).toBe(true);
    expect(looksLikeTestCommand("shell", { command: "npm test" })).toBe(true);
    expect(looksLikeTestCommand("shell", { command: "ls" })).toBe(false);
    expect(looksLikeVerificationCommand("shell", { command: "bun run typecheck" })).toBe(true);
    expect(looksLikeVerificationCommand("shell", { command: "ls" })).toBe(false);
  });

  it("finds the file target named by a tool call", () => {
    expect(toolFileTarget({ path: "a.ts" })).toBe("a.ts");
    expect(toolFileTarget({ file: "b.ts" })).toBe("b.ts");
    expect(toolFileTarget({ filePath: "c.ts" })).toBe("c.ts");
    expect(toolFileTarget({})).toBeUndefined();
  });
});

describe("Phase 81 §12 — evidence collector", () => {
  it("starts empty", () => {
    const snapshot = new ExecutionEvidenceCollector().snapshot();
    expect(snapshot).toEqual(emptyExecutionEvidence());
  });

  it("counts tool starts, reads and file changes", () => {
    const collector = collect([
      { type: "tool:start", payload: { id: "1", toolName: "read_file", toolArgs: { path: "a.ts" } } },
      { type: "tool:complete", payload: { id: "1", toolName: "read_file", toolArgs: { path: "a.ts" } } },
      { type: "tool:start", payload: { id: "2", toolName: "write_file", toolArgs: { path: "b.ts" } } },
      { type: "tool:complete", payload: { id: "2", toolName: "write_file", toolArgs: { path: "b.ts" } } },
    ]);
    const snapshot = collector.snapshot();
    expect(snapshot.toolCalls).toBe(2);
    expect(snapshot.filesRead).toEqual(["a.ts"]);
    expect(snapshot.filesChanged).toEqual(["b.ts"]);
  });

  it("counts commands and test runs separately", () => {
    const collector = collect([
      { type: "tool:start", payload: { id: "1", toolName: "shell", toolArgs: { command: "ls" } } },
      { type: "tool:start", payload: { id: "2", toolName: "shell", toolArgs: { command: "bun test" } } },
    ]);
    expect(collector.snapshot().commandsRun).toBe(2);
    expect(collector.snapshot().testsRun).toBe(1);
  });

  it("records permission denials with their reason", () => {
    const collector = collect([
      {
        type: "tool:error",
        payload: { id: "1", toolName: "write_file", reason: "denied" },
      },
    ]);
    expect(collector.snapshot().permissionDenials).toBe(1);
    expect(collector.denials()).toEqual([{ toolName: "write_file", reason: "denied" }]);
  });

  it("does not count a non-permission tool error as a denial", () => {
    const collector = collect([
      { type: "tool:error", payload: { id: "1", toolName: "shell", reason: "exit code 1" } },
    ]);
    expect(collector.snapshot().permissionDenials).toBe(0);
    expect(collector.snapshot().failedToolCalls).toBe(1);
  });

  it("de-duplicates a re-dispatched call id", () => {
    const collector = collect([
      { type: "tool:start", payload: { id: "same", toolName: "read_file", toolArgs: { path: "a.ts" } } },
      { type: "tool:start", payload: { id: "same", toolName: "read_file", toolArgs: { path: "a.ts" } } },
    ]);
    expect(collector.snapshot().toolCalls).toBe(1);
  });

  it("does not record a file change for a failed mutation", () => {
    const collector = collect([
      { type: "tool:start", payload: { id: "1", toolName: "write_file", toolArgs: { path: "b.ts" } } },
      { type: "tool:error", payload: { id: "1", toolName: "write_file", reason: "denied" } },
    ]);
    expect(collector.snapshot().filesChanged).toEqual([]);
  });

  it("ignores unknown event types instead of throwing", () => {
    expect(() =>
      collect([{ type: "something:new", payload: {} }, { type: "harness:init" }]),
    ).not.toThrow();
  });

  it("snapshot returns a copy, so later events do not mutate it", () => {
    const collector = collect([
      { type: "tool:start", payload: { id: "1", toolName: "read_file", toolArgs: { path: "a.ts" } } },
    ]);
    const first = collector.snapshot();
    collector.observe({ type: "tool:start", payload: { id: "2", toolName: "read_file", toolArgs: { path: "z.ts" } } });
    expect(first.filesRead).toEqual(["a.ts"]);
    expect(collector.snapshot().filesRead).toEqual(["a.ts", "z.ts"]);
  });
});
