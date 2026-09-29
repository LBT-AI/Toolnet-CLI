import { test, expect } from "bun:test";
import { classifyShellCommand } from "../commandClassifier";
import { securityEngine } from "../securityEngine";

const cap = (cmd: string) => (securityEngine as any).determineShellCapability(cmd) as string;

// ── Phase 4 / TN-R0-007A ──────────────────────────────────────────────────
// Inline interpreters (php -r, python -c, node -e, bash -c …) are classified
// by the INTENT of their inline script, never by the interpreter's name alone.
// Read-only inspection is usable under workspace policy; process spawning and
// workspace mutation stay gated; destructive system payloads stay forbidden.

test("Safe php -r read-only inspection is usable in workspace mode", () => {
  const cmd = "php -r 'echo \"hello\";'";

  const analysis = classifyShellCommand(cmd);
  expect(analysis.riskLevel).not.toBe("CRITICAL_DENY");
  expect(analysis.riskLevel).not.toBe("DANGEROUS");

  expect(cap(cmd)).toBe("EXECUTE");

  const result = securityEngine.evaluate("shell", { command: cmd }, "workspace");
  expect(result.decision).toBe("ALLOW");
  expect(result.allowed).toBe(true);
});

test("Read-only WordPress inspection fixture is usable in workspace mode", () => {
  const cmd = "php -r 'require \"wp-load.php\"; echo \"ok\";'";

  const analysis = classifyShellCommand(cmd);
  expect(analysis.riskLevel).not.toBe("CRITICAL_DENY");
  expect(analysis.riskLevel).not.toBe("DANGEROUS");

  expect(cap(cmd)).toBe("EXECUTE");

  const result = securityEngine.evaluate("shell", { command: cmd }, "workspace");
  expect(result.decision).toBe("ALLOW");
});

test("Control case: destructive php -r payload stays permanently blocked", () => {
  const cmd = "php -r 'shell_exec(\"rm -rf /\");'";
  const analysis = classifyShellCommand(cmd);
  expect(analysis.riskLevel).toBe("CRITICAL_DENY");

  const result = securityEngine.evaluate("shell", { command: cmd }, "workspace");
  expect(result.decision).toBe("DENY");
  expect(result.riskLevel).toBe("CRITICAL_DENY");
});

test("Control case: process-spawning / mutating php -r payload is gated, never blanket-allowed", () => {
  const spawn = "php -r 'shell_exec(\"ls\");'";
  expect(cap(spawn)).toBe("DYNAMIC_EXECUTION");
  expect(securityEngine.evaluate("shell", { command: spawn }, "workspace").decision).toBe("DENY");
  expect(securityEngine.evaluate("shell", { command: spawn }, "ask").decision).toBe("ASK");

  const mutate = "php -r 'file_put_contents(\"a.txt\",\"b\");'";
  expect(cap(mutate)).toBe("MODIFY");
  expect(securityEngine.evaluate("shell", { command: mutate }, "workspace").decision).toBe("DENY");
  expect(securityEngine.evaluate("shell", { command: mutate }, "ask").decision).toBe("ASK");
});

test("Other interpreters: read-only scripts fall through to normal classification", () => {
  for (const cmd of [
    "python -c 'print(1)'",
    "python3 -c 'import os; print(os.getcwd())'",
    "node -e 'console.log(1)'",
    "bash -c 'echo 1'",
    "sh -c 'echo 1'",
    "perl -e 'print 1'",
    "ruby -e 'puts 1'",
  ]) {
    expect(cap(cmd)).toBe("EXECUTE");
    const result = securityEngine.evaluate("shell", { command: cmd }, "workspace");
    expect(result.decision).toBe("ALLOW");
  }
});

test("Other interpreters: spawning and mutating scripts keep their gated capability", () => {
  expect(cap("python -c 'import os; os.system(\"ls\")'")).toBe("DYNAMIC_EXECUTION");
  expect(cap("node -e 'require(\"child_process\").execSync(\"ls\")'")).toBe("DYNAMIC_EXECUTION");
  expect(cap("bash -c 'cat a | wc -l'")).toBe("DYNAMIC_EXECUTION");
  expect(cap("python -c 'open(\"out.txt\",\"w\").write(\"x\")'")).toBe("MODIFY");

  for (const cmd of [
    "python -c 'import os; os.system(\"ls\")'",
    "node -e 'require(\"child_process\").execSync(\"ls\")'",
    "bash -c 'cat a | wc -l'",
  ]) {
    expect(securityEngine.evaluate("shell", { command: cmd }, "workspace").decision).toBe("DENY");
  }
});

test("Other interpreters: destructive system payloads stay CRITICAL_DENY in every mode", () => {
  for (const cmd of [
    "python3 -c 'import shutil; shutil.rmtree(\"/\")'",
    "python -c 'import os; os.system(\"rm -rf /\")'",
    "bash -c 'rm -rf /'",
    "bash -c 'bash -c \"rm -rf /\"'",
  ]) {
    expect(classifyShellCommand(cmd).riskLevel).toBe("CRITICAL_DENY");
    expect(securityEngine.evaluate("shell", { command: cmd }, "workspace").decision).toBe("DENY");
    expect(securityEngine.evaluate("shell", { command: cmd }, "ask").decision).toBe("DENY");
    expect(securityEngine.evaluate("shell", { command: cmd }, "full-access").decision).toBe("DENY");
  }
});
