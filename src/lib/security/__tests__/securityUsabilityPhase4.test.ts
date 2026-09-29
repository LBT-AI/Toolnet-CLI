import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyShellCommand } from "../commandClassifier";
import { securityEngine } from "../securityEngine";
import { ToolGateway } from "../toolGateway";

/**
 * PHASE 4 — SECURITY USABILITY WITHOUT WEAKENING SAFETY
 *
 * Acceptance matrix for the two false-positive classes (TN-R0-007A inline
 * interpreters, TN-R0-007B /dev redirects) plus the preserved controls that
 * must never regress: protected system writes, destructive dynamic commands,
 * and the rule that no sandbox mode (or user approval) turns the engine into
 * "allow everything".
 */

const ws = () => process.cwd();

const evalAs = (mode: "workspace" | "ask" | "full-access", command: string) =>
  securityEngine.evaluate("shell", { command }, mode, ws(), ws());

// ── Task E — 11-scenario matrix ───────────────────────────────────────────

describe("PHASE4 Task E — inline interpreter usability (1-5)", () => {
  test("1. php -r echo is usable in workspace mode", () => {
    const cmd = "php -r 'echo \"hello\";'";
    expect(classifyShellCommand(cmd).riskLevel).not.toBe("CRITICAL_DENY");
    expect(evalAs("workspace", cmd).decision).toBe("ALLOW");
  });

  test("2. php -r read-only fixture inspection is usable in workspace mode", () => {
    const cmd = "php -r 'require \"wp-load.php\"; $x = 1; echo $x;'";
    expect(evalAs("workspace", cmd).decision).toBe("ALLOW");
    expect(evalAs("ask", cmd).decision).toBe("ALLOW");
  });

  test("3. python -c read-only is usable in workspace mode", () => {
    const cmd = "python -c 'import os; print(os.getcwd())'";
    expect(evalAs("workspace", cmd).decision).toBe("ALLOW");
  });

  test("4. node -e read-only is usable in workspace mode", () => {
    const cmd = "node -e 'console.log(process.cwd())'";
    expect(evalAs("workspace", cmd).decision).toBe("ALLOW");
  });

  test("5. bash -c with a harmless payload is usable in workspace mode", () => {
    expect(evalAs("workspace", "bash -c 'echo hello'").decision).toBe("ALLOW");
    expect(evalAs("workspace", "sh -c 'echo hello'").decision).toBe("ALLOW");
  });

  test("interpreter payloads are never a blanket ALLOW: mutation / spawn stay gated", () => {
    const mutating = "php -r 'file_put_contents(\"a.txt\",\"b\");'";
    expect(evalAs("workspace", mutating).decision).toBe("DENY");
    expect(evalAs("ask", mutating).decision).toBe("ASK");

    const spawning = "python -c 'import os; os.system(\"ls\")'";
    expect(evalAs("workspace", spawning).decision).toBe("DENY");
    expect(evalAs("ask", spawning).decision).toBe("ASK");
  });
});

describe("PHASE4 Task E — fd-aware redirection (6-10)", () => {
  test("6. echo x 2>/dev/null is READ_ONLY and allowed", () => {
    const cmd = "echo x 2>/dev/null";
    const analysis = classifyShellCommand(cmd);
    expect(analysis.category).not.toBe("SYSTEM_TAMPERING");
    expect(analysis.riskLevel).toBe("SAFE_READ");
    expect(evalAs("workspace", cmd).decision).toBe("ALLOW");
  });

  test("7. echo x 2>>/dev/null is READ_ONLY and allowed", () => {
    expect(evalAs("workspace", "echo x 2>>/dev/null").decision).toBe("ALLOW");
  });

  test("8. echo x 2>&1 is fd duplication, not a filesystem write", () => {
    const cmd = "echo x 2>&1";
    expect(classifyShellCommand(cmd).category).toBe("READ_ONLY");
    expect(evalAs("workspace", cmd).decision).toBe("ALLOW");
  });

  test("9. a redirect inside the workspace is allowed and actually works", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phase4-"));
    try {
      const cmd = "echo phase4-safe > ./safe.txt";
      expect(classifyShellCommand(cmd, tmp, tmp).category).not.toBe("SYSTEM_TAMPERING");

      const res = await ToolGateway.execute(
        { name: "shell", args: { command: cmd } },
        { cwd: tmp, workspaceRoot: tmp, sandboxMode: "workspace" }
      );
      expect(res.allowed).toBe(true);
      expect(fs.readFileSync(path.join(tmp, "safe.txt"), "utf8").trim()).toBe("phase4-safe");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("10. a redirect to /etc stays SYSTEM_TAMPERING / DENY in every mode", () => {
    const cmd = "echo x > /etc/toolnet-phase4";
    expect(classifyShellCommand(cmd).category).toBe("SYSTEM_TAMPERING");
    expect(evalAs("workspace", cmd).decision).toBe("DENY");
    expect(evalAs("ask", cmd).decision).toBe("DENY");
    expect(evalAs("full-access", cmd).decision).toBe("DENY");
    expect(fs.existsSync("/etc/toolnet-phase4")).toBe(false);
  });
});

describe("PHASE4 Task E — destructive dynamic commands (11)", () => {
  test("11. destructive dynamic payloads are CRITICAL_DENY in every mode", () => {
    for (const cmd of [
      "php -r 'shell_exec(\"rm -rf /\");'",
      "php -r 'system(\"rm -rf /\");'",
      "python -c 'import shutil; shutil.rmtree(\"/\")'",
      "node -e 'require(\"child_process\").execSync(\"rm -rf /\")'",
      "bash -c 'rm -rf /'",
      "bash -c 'bash -c \"rm -rf /\"'",
    ]) {
      expect(classifyShellCommand(cmd).riskLevel).toBe("CRITICAL_DENY");
      expect(evalAs("workspace", cmd).decision).toBe("DENY");
      expect(evalAs("ask", cmd).decision).toBe("DENY");
      expect(evalAs("full-access", cmd).decision).toBe("DENY");
    }
  });
});

// ── Task F — no mode (or approval) is a universal bypass ──────────────────

describe("PHASE4 Task F — permissions still apply in every mode", () => {
  test("full-access does not resurrect CRITICAL_DENY actions", () => {
    const results = evalAs("full-access", "sudo rm -rf /etc");
    expect(results.decision).toBe("DENY");
    expect(results.riskLevel).toBe("CRITICAL_DENY");
  });

  test("userApproved cannot override a hard DENY through the gateway", async () => {
    const res = await ToolGateway.execute(
      { name: "shell", args: { command: "rm -rf /" } },
      { cwd: ws(), workspaceRoot: ws(), sandboxMode: "full-access", userApproved: true }
    );
    expect(res.allowed).toBe(false);
    expect(res.riskLevel).toBe("CRITICAL_DENY");
  });

  test("a full-access shell command still cannot write outside the workspace via /etc", async () => {
    const res = await ToolGateway.execute(
      { name: "shell", args: { command: "echo pwn > /etc/toolnet-phase4-f" } },
      { cwd: ws(), workspaceRoot: ws(), sandboxMode: "full-access", userApproved: true }
    );
    expect(res.allowed).toBe(false);
    expect(fs.existsSync("/etc/toolnet-phase4-f")).toBe(false);
  });

  test("capability locks still gate dynamic execution in ask/workspace modes", () => {
    expect(securityEngine.evaluate("shell", { command: "bash -c 'ls | wc -l'" }, "workspace", ws(), ws()).allowed).toBe(false);
    expect(securityEngine.evaluate("shell", { command: "bash -c 'ls | wc -l'" }, "ask", ws(), ws()).needsApproval).toBe(true);
  });
});
