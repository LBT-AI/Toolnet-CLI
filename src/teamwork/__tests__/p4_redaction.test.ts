import { test, it, expect, describe } from "bun:test";
import { redactOutputSecrets } from "../../lib/security/outputRedactor";
import { JsonlWriter } from "../../lib/structuredOutput";
import { auditLogger, SecurityAuditLogger } from "../../lib/security/auditLogger";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("P4.7 & P4.8 — Output Secret Redaction & False-Positive Controls", () => {
  it("11. OpenAI API key is redacted", () => {
    const raw = "The key is sk-1234567890abcdef1234567890xyz and sk-proj-1234567890abcdef1234567890xyz";
    const redacted = redactOutputSecrets(raw);
    expect(redacted).not.toContain("sk-1234567890abcdef1234567890xyz");
    expect(redacted).toContain("sk-****xyz");
    expect(redacted).toContain("sk-proj-****xyz");
  });

  it("12. GitHub token is redacted", () => {
    const raw = "Authorization token: ghp_1234567890abcdefghijklmnopqrstuvwxyz12 and github_pat_1234567890abcdefghijklmnopqrstuvwxyz123456";
    const redacted = redactOutputSecrets(raw);
    expect(redacted).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwxyz12");
    expect(redacted).toContain("ghp_****z12");
    expect(redacted).toContain("github_pat_****456");
  });

  it("13. AWS Access Key ID is redacted", () => {
    const raw = "Config: aws_access_key_id = AKIA1234567890123456";
    const redacted = redactOutputSecrets(raw);
    expect(redacted).not.toContain("AKIA1234567890123456");
    expect(redacted).toContain("AKIA****3456");
  });

  it("14. Private key block is redacted", () => {
    const raw = `
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y1+examplePrivateContentHere
-----END RSA PRIVATE KEY-----
`;
    const redacted = redactOutputSecrets(raw);
    expect(redacted).not.toContain("MIIEowIBAAKCAQEA0Y1+examplePrivateContentHere");
    expect(redacted).toContain("[REDACTED_PRIVATE_KEY]");
  });

  it("15. False-positive samples remain unchanged", () => {
    const normalUuid = "c73bcdcc-2669-4bf6-81d3-e4ae73fb11fd";
    const gitCommitSha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const placeholder1 = "YOUR_API_KEY";
    const placeholder2 = "sk-placeholder";
    const placeholder3 = "sk-xxx";

    const text = `ID: ${normalUuid}, Commit: ${gitCommitSha}, Example: ${placeholder1}, ${placeholder2}, ${placeholder3}`;
    const redacted = redactOutputSecrets(text);

    expect(redacted).toContain(normalUuid);
    expect(redacted).toContain(gitCommitSha);
    expect(redacted).toContain(placeholder1);
    expect(redacted).toContain(placeholder2);
    expect(redacted).toContain(placeholder3);
  });

  it("16. JSON output structure is redacted before serialization", () => {
    const data = {
      model: "openai/gpt-4o",
      response: "Here is your key: sk-1234567890abcdef1234567890xyz",
    };
    const jsonStr = JSON.stringify(data);
    const cleanJson = redactOutputSecrets(jsonStr);

    expect(cleanJson).not.toContain("sk-1234567890abcdef1234567890xyz");
    expect(cleanJson).toContain("sk-****xyz");
  });

  it("17. JSONL writer automatically redacts secrets from all emitted events", () => {
    const writer = new JsonlWriter();
    writer.write({
      type: "assistant_delta",
      text: "Found secret: ghp_1234567890abcdefghijklmnopqrstuvwxyz12",
    });

    const lines = (writer as any).buffer as string[];
    expect(lines.length).toBe(1);
    expect(lines[0]).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwxyz12");
    expect(lines[0]).toContain("ghp_****z12");
  });

  it("18. Audit log events redact secrets before appending to JSONL", () => {
    const tmpLogDir = path.join(os.tmpdir(), "toolnet-audit-redact-test-" + Date.now());
    fs.mkdirSync(tmpLogDir, { recursive: true });
    const logFile = path.join(tmpLogDir, "audit.jsonl");

    const customLogger = new SecurityAuditLogger(logFile);
    customLogger.logEvent({
      action: "write_file",
      mode: "workspace",
      allowed: true,
      args: {
        path: "config.json",
        apiKey: "sk-1234567890abcdef1234567890xyz",
      },
    });

    const content = fs.readFileSync(logFile, "utf8");
    expect(content).not.toContain("sk-1234567890abcdef1234567890xyz");
    expect(content).toContain("sk-****xyz");

    fs.rmSync(tmpLogDir, { recursive: true, force: true });
  });
});
