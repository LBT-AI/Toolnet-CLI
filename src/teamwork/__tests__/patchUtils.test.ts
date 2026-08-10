import { describe, test, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseUnifiedDiff,
  applyHunksToContent,
  generateDiff,
  applyStructuredPatch,
} from "../../lib/patchUtils";
import { undo, canUndo } from "../../lib/history";

describe("Patch & Diff Utilities (Structured Patches & Undo)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-patch-test-"));
  });

  test("parseUnifiedDiff correctly parses unified diff patch header and hunks", () => {
    const diff = [
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -1,3 +1,4 @@",
      " line 1",
      "-line 2",
      "+line 2 modified",
      "+line 3 new",
      " line 4"
    ].join("\n");

    const patches = parseUnifiedDiff(diff);
    expect(patches.length).toBe(1);
    expect(patches[0].oldPath).toBe("src/index.ts");
    expect(patches[0].newPath).toBe("src/index.ts");
    expect(patches[0].hunks.length).toBe(1);
    expect(patches[0].hunks[0].lines).toContain("-line 2");
    expect(patches[0].hunks[0].lines).toContain("+line 2 modified");
  });

  test("applyHunksToContent replaces target lines accurately", () => {
    const orig = "alpha\nbeta\ngamma";
    const hunks = [
      {
        oldStart: 1,
        oldLinesCount: 3,
        newStart: 1,
        newLinesCount: 3,
        lines: [" alpha", "-beta", "+delta", " gamma"]
      }
    ];

    const res = applyHunksToContent(orig, hunks);
    expect(res.success).toBe(true);
    expect(res.content).toBe("alpha\ndelta\ngamma");
  });

  test("generateDiff produces readable unified diff string", () => {
    const oldCode = "const a = 1;\nconst b = 2;";
    const newCode = "const a = 1;\nconst b = 3;\nconst c = 4;";

    const diff = generateDiff(oldCode, newCode, "app.ts");
    expect(diff).toContain("--- a/app.ts");
    expect(diff).toContain("+++ b/app.ts");
    expect(diff).toContain("-const b = 2;");
    expect(diff).toContain("+const b = 3;");
  });

  test("applyStructuredPatch applies patch to disk file and is fully undoable via undo()", () => {
    const testFile = path.join(tmpDir, "sample.txt");
    fs.writeFileSync(testFile, "line 100\nline 200\nline 300\n");

    const patchText = [
      `--- a/${testFile}`,
      `+++ b/${testFile}`,
      "@@ -1,3 +1,3 @@",
      " line 100",
      "-line 200",
      "+line 250 updated",
      " line 300"
    ].join("\n");

    const result = applyStructuredPatch(patchText, tmpDir);
    expect(result.success).toBe(true);

    const updatedContent = fs.readFileSync(testFile, "utf8");
    expect(updatedContent).toBe("line 100\nline 250 updated\nline 300\n");

    // Test /undo integration
    expect(canUndo()).toBe(true);
    const undoRes = undo();
    expect(undoRes.success).toBe(true);

    const restoredContent = fs.readFileSync(testFile, "utf8");
    expect(restoredContent).toBe("line 100\nline 200\nline 300\n");

    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });
});
