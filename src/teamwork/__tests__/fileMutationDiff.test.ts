/**
 * Regression: structured file mutation diffs.
 *
 * The tool layer knows before/after for every write/edit/patch, so it emits a
 * structured `FileMutation` (with real LCS hunks and line numbers). The TUI
 * renders that, never assistant prose or sniffed stdout text.
 *
 * Covers: create / edit / delete-lines / replace / multi-hunk / delete-file,
 * long-diff collapse (full data retained), parallel mutations, 52x20 rendering,
 * and structured persistence across a session round-trip.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFileMutation } from "../../lib/fileMutation";
import { generateDiff } from "../../lib/patchUtils";
import {
  initWorkspace,
  resetWorkspaceState,
  toolWrite,
  toolEdit,
  toolReplaceAll,
} from "../../lib/codingAgent";
import {
  renderFileMutation,
  FILE_MUTATION_MAX_LINES,
} from "../../tui/renderers/diffRenderer";
import { renderChatMessages } from "../../tui/renderers/chatRenderer";
import { computeLayoutGeometry, stripAnsi, visibleWidth } from "../../tui/layout";
import { saveSession, loadSession, deleteSessionFile } from "../../lib/sessionPersistence";
import type { Msg } from "../../tui/types";
import type { FileMutation } from "../../core/contracts";

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-diff-"));
  return dir;
}

// ── Diff generation ─────────────────────────────────────────────────────────

describe("buildFileMutation — structured diff", () => {
  it("CREATE FILE: before is empty, every line is an addition", () => {
    const m = buildFileMutation("src/new.ts", "create", "", "line 1\nline 2\nline 3\n");
    expect(m.operation).toBe("create");
    expect(m.deletions).toBe(0);
    expect(m.additions).toBe(3);
    const kinds = m.hunks.flatMap((h) => h.lines.map((l) => l.kind));
    expect(kinds.every((k) => k === "add")).toBe(true);
  });

  it("REPLACE: old line is '-' and new line is '+' with context preserved", () => {
    const m = buildFileMutation("a.ts", "update", "const a = 1\nconst b = 2\nconst c = 3\n", "const a = 1\nconst b = 20\nconst c = 3\n");
    expect(m.additions).toBe(1);
    expect(m.deletions).toBe(1);
    const lines = m.hunks.flatMap((h) => h.lines);
    expect(lines.some((l) => l.kind === "del" && l.text === "const b = 2")).toBe(true);
    expect(lines.some((l) => l.kind === "add" && l.text === "const b = 20")).toBe(true);
    expect(lines.some((l) => l.kind === "context" && l.text === "const a = 1")).toBe(true);
    // Context carries both pre/post line numbers.
    const ctx = lines.find((l) => l.kind === "context")!;
    expect(ctx.oldLine).toBe(1);
    expect(ctx.newLine).toBe(1);
  });

  it("DELETE LINES: removed line is '-' and there is no phantom addition", () => {
    const m = buildFileMutation("a.ts", "update", "keep\ndrop\nkeep2\n", "keep\nkeep2\n");
    expect(m.deletions).toBe(1);
    expect(m.additions).toBe(0);
    expect(m.hunks.flatMap((h) => h.lines).some((l) => l.kind === "del" && l.text === "drop")).toBe(true);
  });

  it("INSERTION is reported as '+' only (no mis-attributed delete)", () => {
    const m = buildFileMutation("a.ts", "update", "alpha\ngamma\n", "alpha\nbeta\ngamma\n");
    expect(m.additions).toBe(1);
    expect(m.deletions).toBe(0);
    expect(m.hunks.flatMap((h) => h.lines).some((l) => l.kind === "add" && l.text === "beta")).toBe(true);
    const unified = generateDiff("alpha\ngamma\n", "alpha\nbeta\ngamma\n", "a.ts");
    expect(unified).not.toContain("-gamma");
    expect(unified).toContain("+beta");
  });

  it("MULTI-HUNK: distant edits produce multiple hunks", () => {
    const oldLines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines[1] = "line 2 CHANGED";
    newLines[37] = "line 38 CHANGED";
    const m = buildFileMutation("big.ts", "update", oldLines.join("\n"), newLines.join("\n"));
    expect(m.hunks.length).toBe(2);
    expect(m.additions).toBe(2);
    expect(m.deletions).toBe(2);
  });

  it("DELETE FILE: every line is a deletion", () => {
    const m = buildFileMutation("legacy.ts", "delete", "function old() {\n  return 1;\n}\n", "");
    expect(m.operation).toBe("delete");
    expect(m.additions).toBe(0);
    expect(m.deletions).toBe(3);
    expect(m.hunks.flatMap((h) => h.lines).every((l) => l.kind === "del")).toBe(true);
  });
});

// ── Rendering ───────────────────────────────────────────────────────────────

describe("renderFileMutation — bounded, semantic, width-safe", () => {
  it("renders a heading with the operation, path and (+A -D) stats", () => {
    const m = buildFileMutation("src/example.ts", "update", "a\nb\n", "a\nb2\nc\n");
    const text = stripAnsi(renderFileMutation(m, 80).join("\n"));
    expect(text).toContain("Edited src/example.ts");
    expect(text).toContain("+2");
    expect(text).toContain("-1");
  });

  it("CREATE FILE renders the additions preview (not just a one-line confirmation)", () => {
    const m = buildFileMutation("src/new.ts", "create", "", "import x\n\nexport function f() {}\n");
    const text = stripAnsi(renderFileMutation(m, 80).join("\n"));
    expect(text).toContain("Wrote src/new.ts");
    expect(text).toContain("+import x");
  });

  it("collapses a long diff but keeps the FULL underlying hunks", () => {
    const oldLines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    const newLines = oldLines.map((l, i) => (i % 2 === 0 ? `${l} changed` : l));
    const m = buildFileMutation("large.ts", "update", oldLines.join("\n"), newLines.join("\n"));

    const rendered = renderFileMutation(m, 80);
    expect(rendered.length).toBeLessThanOrEqual(FILE_MUTATION_MAX_LINES + 8);
    expect(stripAnsi(rendered.join("\n"))).toContain("lines hidden");

    // The structured payload still holds the complete diff.
    const underlying = m.hunks.reduce((sum, h) => sum + h.lines.length, 0);
    expect(underlying).toBeGreaterThan(FILE_MUTATION_MAX_LINES);
  });

  it("never exceeds the terminal width at 52x20", () => {
    const layout = computeLayoutGeometry(52, 20);
    const m = buildFileMutation(
      "src/some/deeply/nested/path/with/a/very/long/file/name.ts",
      "update",
      "const value = 'a very long line of code that will not fit on a narrow terminal at all';\n",
      "const value = 'a different very long line of code that also will not fit at all';\n",
    );
    for (const line of renderFileMutation(m, layout.chatCols)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(layout.chatCols);
    }
  });
});

// ── Parallel mutations in the transcript ────────────────────────────────────

describe("parallel mutations do not overwrite each other", () => {
  it("renders both files' diffs independently in one transcript", () => {
    const a = buildFileMutation("src/a.ts", "update", "const a = 1\n", "const a = 2\n");
    const b = buildFileMutation("src/b.ts", "create", "", "export const b = 1\n");
    const msgs: Msg[] = [
      { role: "tool", name: "edit_file", tool_call_id: "call-a", content: JSON.stringify({ exitCode: 0 }), fileMutations: [a] } as any,
      { role: "tool", name: "write_file", tool_call_id: "call-b", content: JSON.stringify({ exitCode: 0 }), fileMutations: [b] } as any,
    ];
    const text = stripAnsi(renderChatMessages(msgs, 80, "\x1b[36m").join("\n"));
    expect(text).toContain("Edited src/a.ts");
    expect(text).toContain("Wrote src/b.ts");
    expect(text).toContain("+const a = 2");
    expect(text).toContain("+export const b = 1");
  });
});

// ── Tool layer wiring ───────────────────────────────────────────────────────

describe("tool layer emits structured mutations", () => {
  let testCwd: string;

  beforeEach(() => {
    testCwd = tmpDir();
    initWorkspace(testCwd);
  });

  afterEach(() => {
    resetWorkspaceState();
    try {
      fs.rmSync(testCwd, { recursive: true, force: true });
    } catch {}
  });

  it("toolWrite on a new file emits a 'create' mutation with all additions", () => {
    const target = path.join(testCwd, "fresh.ts");
    const res = toolWrite(target, "export const x = 1;\nexport const y = 2;\n");
    expect(res.success).toBe(true);
    expect(res.mutations?.length).toBe(1);
    expect(res.mutations![0].operation).toBe("create");
    expect(res.mutations![0].additions).toBe(2);
    expect(res.mutations![0].deletions).toBe(0);
  });

  it("toolEdit emits an 'update' mutation with both additions and deletions", () => {
    const target = path.join(testCwd, "edit.ts");
    fs.writeFileSync(target, "function f() {\n  return 1;\n}\n", "utf8");
    const res = toolEdit(target, "return 1;", "return 2;\n  // added");
    expect(res.success).toBe(true);
    expect(res.mutations?.[0].operation).toBe("update");
    expect(res.mutations?.[0].deletions).toBe(1);
    expect(res.mutations?.[0].additions).toBe(2);
  });

  it("toolReplaceAll emits an 'update' mutation", () => {
    const target = path.join(testCwd, "rep.ts");
    fs.writeFileSync(target, "oldName();\nother();\n", "utf8");
    const res = toolReplaceAll(target, "oldName", "newName");
    expect(res.success).toBe(true);
    expect(res.mutations?.[0].operation).toBe("update");
    expect(res.mutations?.[0].additions).toBe(1);
    expect(res.mutations?.[0].deletions).toBe(1);
  });
});

// ── Persistence (structured, not ANSI) ──────────────────────────────────────

describe("structured mutations persist across a session round-trip", () => {
  it("keeps fileMutations on the stored tool message", () => {
    const mutation: FileMutation = buildFileMutation("src/persist.ts", "update", "a\n", "a\nb\n");
    const sessionId = `sess_diff_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    try {
      saveSession(sessionId, [
        { role: "tool", name: "edit_file", tool_call_id: "c1", content: "{}", fileMutations: [mutation] } as any,
      ]);
      const loaded = loadSession(sessionId);
      const stored = (loaded?.messages?.[0] as any)?.fileMutations?.[0] as FileMutation | undefined;
      expect(stored?.path).toBe("src/persist.ts");
      expect(stored?.operation).toBe("update");
      expect(stored?.hunks.length).toBeGreaterThan(0);
    } finally {
      deleteSessionFile(sessionId);
    }
  });
});
