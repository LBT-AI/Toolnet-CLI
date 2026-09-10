import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setWorkspaceRoot, getCwdInfo } from "../../lib/codingAgent";
import {
  verifyFileWritten,
  verifyFileEdited,
  snapshotFileHash,
  verifyArtifactWritten,
  verifyDirectoryExists,
} from "../../lib/toolVerification";
import { scanForUnbackedClaim, buildClaimGuardNudge } from "../../lib/claimGuard";
import { extractPatchTargets } from "../../lib/agentTools";

/**
 * Correctness lifecycle tests: no filesystem mutation → no success claim.
 * These lock the postcondition-verification layer that backs tool results.
 */

let tmpDir = "";
let savedCwd = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-verify-"));
  savedCwd = getCwdInfo().currentCwd;
  // resolvePath() is workspace-cwd based — point it at the tmp workspace.
  setWorkspaceRoot(tmpDir);
});

afterEach(() => {
  // Restore the workspace state FIRST — setWorkspaceRoot is module-global and
  // shared bun workers run other test files after this one. Also restore the
  // process cwd before deleting the tmpdir (deleting a live cwd breaks later
  // relative-path resolution).
  try {
    process.chdir(savedCwd);
  } catch {}
  setWorkspaceRoot(savedCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function inWorkspace(rel: string): string {
  return path.join(tmpDir, rel);
}

describe("toolVerification — filesystem postconditions", () => {
  it("verifyFileWritten: passes for a real file", () => {
    fs.writeFileSync(inWorkspace("test.py"), "print('hello')\n");
    expect(verifyFileWritten(inWorkspace("test.py")).ok).toBe(true);
  });

  it("verifyFileWritten: fails when the file does NOT exist (the video bug)", () => {
    const post = verifyFileWritten(inWorkspace("test.py"));
    expect(post.ok).toBe(false);
    expect(post.error).toContain("does not exist");
  });

  it("verifyFileWritten: fails for a directory masquerading as a file", () => {
    fs.mkdirSync(inWorkspace("sneaky"));
    expect(verifyFileWritten(inWorkspace("sneaky")).ok).toBe(false);
  });

  it("verifyFileWritten: fails for missing/invalid path arg", () => {
    expect(verifyFileWritten(undefined).ok).toBe(false);
    expect(verifyFileWritten("").ok).toBe(false);
    expect(verifyFileWritten(42).ok).toBe(false);
  });

  it("verifyFileEdited: detects unchanged content (edit that did nothing)", () => {
    const p = inWorkspace("app.ts");
    fs.writeFileSync(p, "const x = 1;\n");
    const before = snapshotFileHash(p);
    // "Successful" edit that wrote identical bytes → must NOT pass.
    fs.writeFileSync(p, "const x = 1;\n");
    const post = verifyFileEdited(p, before);
    expect(post.ok).toBe(false);
    expect(post.error).toContain("unchanged");
  });

  it("verifyFileEdited: passes when content actually changed", () => {
    const p = inWorkspace("app.ts");
    fs.writeFileSync(p, "const x = 1;\n");
    const before = snapshotFileHash(p);
    fs.writeFileSync(p, "const x = 2;\n");
    expect(verifyFileEdited(p, before).ok).toBe(true);
  });

  it("verifyFileEdited: fails when file vanished after a 'successful' edit", () => {
    const p = inWorkspace("gone.ts");
    const post = verifyFileEdited(p, undefined);
    expect(post.ok).toBe(false);
    expect(post.error).toContain("does not exist");
  });

  it("verifyArtifactWritten: passes only for real artifacts", () => {
    fs.mkdirSync(inWorkspace(".artifacts"));
    expect(verifyArtifactWritten("report.md").ok).toBe(false); // not written yet
    fs.writeFileSync(inWorkspace(".artifacts/report.md"), "# Report\n");
    expect(verifyArtifactWritten("report.md").ok).toBe(true);
    expect(verifyArtifactWritten("missing.md").ok).toBe(false);
    expect(verifyArtifactWritten(undefined).ok).toBe(false);
  });

  it("verifyDirectoryExists: dir vs file vs missing", () => {
    fs.mkdirSync(inWorkspace("adir"));
    fs.writeFileSync(inWorkspace("afile"), "x");
    expect(verifyDirectoryExists(inWorkspace("adir")).ok).toBe(true);
    expect(verifyDirectoryExists(inWorkspace("afile")).ok).toBe(false);
    expect(verifyDirectoryExists(inWorkspace("nope")).ok).toBe(false);
  });
});

describe("claimGuard — unbacked side-effect claim detection", () => {
  it("flags the exact video repro: Vietnamese claim + code block", () => {
    const answer =
      "Tôi đã tạo file Python cho bạn:\n\n```python\nprint('hello')\n```\n\nChạy thử nhé!";
    const scan = scanForUnbackedClaim(answer);
    expect(scan.suspected).toBe(true);
    expect(scan.matchedPhrase).toBeTruthy();
  });

  it("flags unaccented Vietnamese and English claim variants", () => {
    expect(scanForUnbackedClaim("Toi da tao file:\n```py\nx=1\n```").suspected).toBe(true);
    expect(scanForUnbackedClaim("I've created the file:\n```js\nx\n```").suspected).toBe(true);
    expect(scanForUnbackedClaim("I saved the config:\n```yaml\na: 1\n```").suspected).toBe(true);
  });

  it("does NOT flag honest answers: code provided, no creation claim", () => {
    expect(scanForUnbackedClaim("Đây là code mẫu:\n```python\nprint(1)\n```").suspected).toBe(false);
    expect(scanForUnbackedClaim("Here's the code — copy it into test.py:\n```py\nx\n```").suspected).toBe(false);
    // Claim without code block → out of scope for this guard (tools verify fs).
    expect(scanForUnbackedClaim("Tôi đã tạo file cho bạn rồi.").suspected).toBe(false);
  });

  it("nudge instructs tool execution or truthful rewording", () => {
    const nudge = buildClaimGuardNudge("Tôi đã tạo file", "/root/test");
    expect(nudge).toContain("write_file");
    expect(nudge).toContain("/root/test");
    expect(nudge).toContain("PROVIDING the code");
  });
});

describe("patch target extraction", () => {
  it("extracts b/ targets, skipping /dev/null", () => {
    const patch = [
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "--- /dev/null",
      "+++ b/bar.ts",
      "+created",
    ].join("\n");
    expect(extractPatchTargets(patch).sort()).toEqual(["bar.ts", "foo.ts"]);
  });
});
