/**
 * Semantic theme + surface polish.
 *
 * Locks the "lit dark" palette (never absolute black, high-contrast text,
 * distinct semantic roles) and the new/updated surfaces: startup empty state,
 * structured diff badges, and running/success/error tool accents.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { A, theme, setNoColor } from "../../term";
import { renderStartupEmptyState } from "../renderers/startupRenderer";
import { renderFileMutation, renderFileMutationBody } from "../renderers/diffRenderer";
import { renderToolLine } from "../../lib/tool-format";
import { stripAnsi, visibleWidth } from "../layout";
import type { FileMutation } from "../../core/contracts";

function mutation(operation: FileMutation["operation"], path = "src/x.ts"): FileMutation {
  return {
    callId: "c1",
    operation,
    path,
    additions: 2,
    deletions: 1,
    hunks: [
      {
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 3,
        lines: [
          { kind: "context", text: "const a = 1;", oldLine: 1, newLine: 1 },
          { kind: "del", text: "const b = 2;", oldLine: 2 },
          { kind: "add", text: "const b = 3;", newLine: 2 },
          { kind: "add", text: "const c = 4;", newLine: 3 },
        ],
      },
    ],
  } as FileMutation;
}

describe("semantic theme", () => {
  beforeEach(() => setNoColor(false));
  afterEach(() => setNoColor(null));

  it("uses a lit navy background, bright text and distinct semantic roles", () => {
    // Not absolute black.
    expect(A.bgSurface).toContain("48;2;11;18;32");
    expect(A.bgPanel).toContain("48;2;17;26;43");
    // Bright primary text.
    expect(A.fgText).toContain("38;2;234;242;255");
    expect(A.fgSubtext).toContain("38;2;183;196;214");
    // Semantic colors are distinct.
    expect(theme.success).toContain("46;204;113");
    expect(theme.error).toContain("255;107;107");
    expect(theme.warning).toContain("245;185;66");
    expect(theme.info).toContain("91;192;255");
    expect(theme.accent).toContain("77;163;255");
    expect(new Set([theme.success, theme.error, theme.warning, theme.info, theme.thinking]).size).toBe(5);
  });

  it("suppresses every token under NO_COLOR", () => {
    setNoColor(true);
    expect(A.bgSurface).toBe("");
    expect(A.fgText).toBe("");
    expect(theme.success).toBe("");
  });
});

describe("startup empty state", () => {
  beforeEach(() => setNoColor(false));
  afterEach(() => setNoColor(null));

  it("shows brand, model and workspace and never overflows a 52-col phone row", () => {
    const lines = renderStartupEmptyState(52, { model: "gpt-5.6", workspace: "/root/toolnet-cli" });
    const plain = stripAnsi(lines.join("\n"));
    expect(plain).toContain("ToolNet");
    expect(plain).toContain("gpt-5.6");
    expect(plain).toContain("/root/toolnet-cli");
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(52);
    }
  });
});

describe("structured diff polish", () => {
  beforeEach(() => setNoColor(false));
  afterEach(() => setNoColor(null));

  it("badges new and deleted files and colors +/- lines", () => {
    const created = renderFileMutation(mutation("create", "src/new.ts"), 80);
    expect(stripAnsi(created[0])).toContain("NEW");
    expect(stripAnsi(created[0])).toContain("Wrote");

    const deleted = renderFileMutation(mutation("delete"), 80);
    expect(stripAnsi(deleted[0])).toContain("DEL");
    expect(stripAnsi(deleted[0])).toContain("Deleted");

    const updated = renderFileMutation(mutation("update"), 80);
    expect(stripAnsi(updated[0])).toContain("Edited");
    expect(stripAnsi(updated[0])).not.toContain("NEW");

    const body = renderFileMutationBody(mutation("update"), 80).join("\n");
    expect(body).toContain(A.fgGreen); // + line
    expect(body).toContain(A.fgRed); //  - line
  });
});

describe("tool activity accents", () => {
  beforeEach(() => setNoColor(false));
  afterEach(() => setNoColor(null));

  it("running uses info, success green, error red", () => {
    const running = renderToolLine("bash", { command: "bun test" }, "running");
    expect(running).toContain(A.fgInfo);
    expect(stripAnsi(running)).toContain("●");

    const ok = renderToolLine("bash", { command: "bun test" }, "success", 1200);
    expect(ok).toContain(A.fgGreen);
    expect(stripAnsi(ok)).toContain("✓");

    const bad = renderToolLine("bash", { command: "bun test" }, "error", 1200);
    expect(bad).toContain(A.fgRed);
    expect(stripAnsi(bad)).toContain("✗");
  });
});
