import { test, expect, describe } from "bun:test";
import {
  isSensitiveFile,
  redactSecrets,
  scanContentForSecrets,
  scanPathForSecrets,
} from "../../lib/security/secretGuard";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("SecretScanner — Broader Secret Scanning", () => {
  test("detects expanded sensitive filenames and directories", () => {
    expect(isSensitiveFile(".gcloud").isSensitive).toBe(true);
    expect(isSensitiveFile(".azure").isSensitive).toBe(true);
    expect(isSensitiveFile(".gitlab-ci.yml").isSensitive).toBe(true);
    expect(isSensitiveFile(".gitlab-ci.yaml").isSensitive).toBe(true);
    expect(isSensitiveFile(".circleci/config.yml").isSensitive).toBe(true);
    expect(isSensitiveFile(".travis.yml").isSensitive).toBe(true);
    expect(isSensitiveFile("Dockerfile").isSensitive).toBe(true);
    expect(isSensitiveFile("docker-compose.yml").isSensitive).toBe(true);
    expect(isSensitiveFile("docker-compose.yaml").isSensitive).toBe(true);
    expect(isSensitiveFile("values.yaml").isSensitive).toBe(true);
    expect(isSensitiveFile("main.tfstate").isSensitive).toBe(true);
    expect(isSensitiveFile("prod.tfvars").isSensitive).toBe(true);
    expect(isSensitiveFile(".dockercfg").isSensitive).toBe(true);
    expect(isSensitiveFile(".docker/config.json").isSensitive).toBe(true);
    expect(isSensitiveFile("/home/user/.config/gcloud/credentials.db").isSensitive).toBe(true);
    expect(isSensitiveFile("/home/user/.config/azure/azureProfile.json").isSensitive).toBe(true);
    expect(isSensitiveFile("/home/user/.azure/azureProfile.json").isSensitive).toBe(true);
    expect(isSensitiveFile("/home/user/.docker/config.json").isSensitive).toBe(true);
    expect(isSensitiveFile("/home/user/helm/my-values.yaml").isSensitive).toBe(true);

    expect(isSensitiveFile("package.json").isSensitive).toBe(false);
    expect(isSensitiveFile("src/index.ts").isSensitive).toBe(false);
    expect(isSensitiveFile("README.md").isSensitive).toBe(false);
    expect(isSensitiveFile(".gitignore").isSensitive).toBe(false);
  });

  test("detects cloud/CI/CD secrets in file content", () => {
    const gcpContent = `{
  "type": "service_account",
  "project_id": "my-project",
  "private_key_id": "abc123",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7...\n-----END PRIVATE KEY-----"
}`;

    const gcpFindings = scanContentForSecrets(gcpContent, "service-account.json");
    const gcpTypes = gcpFindings.map((f) => f.type);
    expect(gcpTypes).toContain("gcp_service_account_json");
    expect(gcpTypes).toContain("pem_private_key");

    const gitlabContent = "API_TOKEN=glpat-1234567890abcdefghijklmnopqrstuvwxyz";
    const gitlabFindings = scanContentForSecrets(gitlabContent, ".gitlab-ci.yml");
    expect(gitlabFindings.some((f) => f.type === "gitlab_token")).toBe(true);

    const doContent = "DIGITALOCEAN_TOKEN=DO0000000000000000000000000000000000000000";
    const doFindings = scanContentForSecrets(doContent, "do.env");
    expect(doFindings.some((f) => f.type === "digitalocean_token")).toBe(true);

    const azureContent = `azure storage account key = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ"`;
    const azureFindings = scanContentForSecrets(azureContent, "azure.env");
    expect(azureFindings.some((f) => f.type === "azure_credential")).toBe(true);
  });

  test("detects generic cloud credential blocks", () => {
    const content = `client_secret = "super-secret-value-1234567890"
client_id = "00000000-0000-0000-0000-000000000000"
private_key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----"`;

    const findings = scanContentForSecrets(content, "cloud.json");
    const types = findings.map((f) => f.type);
    expect(types).toContain("cloud_credential");
    expect(types).toContain("pem_private_key");
  });

  test("redacts secrets from strings without leaking raw values", () => {
    const text = `GITLAB=glpat-abcdefghijklmnopqrstuvwxyz123456
DO=DO0000000000000000000000000000000000000000
OPENAI=sk-abcdef1234567890`;

    const redacted = redactSecrets(text);
    expect(redacted).not.toContain("glpat-abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted).not.toContain("DO0000000000000000000000000000000000000000");
    expect(redacted).not.toContain("sk-abcdef1234567890");
    expect(redacted).toContain("[REDACTED_GITLAB_TOKEN]");
    expect(redacted).toContain("[REDACTED_DO_TOKEN]");
    expect(redacted).toContain("[REDACTED_OPENAI_KEY]");
  });

  test("scanPathForSecrets returns typed findings with file/line", () => {
    const tmpFile = path.join(os.tmpdir(), "toolnet-secret-scan-test-" + Math.random().toString(36).slice(2) + ".json");
    fs.writeFileSync(tmpFile, JSON.stringify({
      type: "service_account",
      project_id: "my-project",
      private_key: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Y1+\n-----END RSA PRIVATE KEY-----",
    }));

    const findings = scanPathForSecrets(tmpFile);
    expect(findings.length).toBeGreaterThanOrEqual(2);

    const pemFinding = findings.find((f) => f.type === "pem_private_key");
    expect(pemFinding).toBeDefined();
    expect(pemFinding?.file).toBe(tmpFile);
    expect(pemFinding?.line).toBeGreaterThan(0);
    expect(pemFinding?.redactedMatch).toBe("[REDACTED_PRIVATE_KEY]");

    fs.unlinkSync(tmpFile);
  });

  test("false-positive samples do not trigger secret findings", () => {
    const normalUuid = "c73bcdcc-2669-4bf6-81d3-e4ae73fb11fd";
    const gitCommitSha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const text = `ID: ${normalUuid}, Commit: ${gitCommitSha}, Example: YOUR_API_KEY, sk-placeholder, sk-xxx`;

    const findings = scanContentForSecrets(text);
    expect(findings.length).toBe(0);

    const redacted = redactSecrets(text);
    expect(redacted).toContain(normalUuid);
    expect(redacted).toContain(gitCommitSha);
    expect(redacted).toContain("YOUR_API_KEY");
  });
});
