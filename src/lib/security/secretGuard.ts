import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export interface SecretFinding {
  type: string;
  severity: "low" | "medium" | "high" | "critical";
  file?: string;
  line?: number;
  redactedMatch: string;
}

const SENSITIVE_FILENAME_PATTERNS: Array<{ pattern: RegExp; description: string; severity: SecretFinding["severity"] }> = [
  { pattern: /^\.env(\..+)?$/i, description: "Environment configuration containing secrets (.env)", severity: "high" },
  { pattern: /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, description: "SSH Private/Public Key", severity: "critical" },
  { pattern: /\.(pem|key|p12|pfx|pkcs12)$/i, description: "Cryptographic Private Key or Certificate", severity: "critical" },
  { pattern: /\.(kdbx|vault|keychain)$/i, description: "Password database / Vault archive", severity: "critical" },
  { pattern: /^\.?(npmrc|netrc|git-credentials|\.pypirc|\.gemrc)$/i, description: "Authentication credential file", severity: "high" },
  { pattern: /^(master\.key|secret_key_base|credentials\.json)$/i, description: "Master Encryption Key / Credentials", severity: "critical" },
  { pattern: /^(service[-_]account.*\.json)$/i, description: "Cloud Service Account Key", severity: "high" },
  { pattern: /^(\.gcloud|\.azure)$/i, description: "Cloud SDK credentials", severity: "high" },
  { pattern: /^(Dockerfile|docker-compose\.ya?ml)$/i, description: "Docker configuration (may contain secrets)", severity: "medium" },
  { pattern: /^(values\.ya?ml|\.helm)$/i, description: "Helm chart configuration", severity: "medium" },
  { pattern: /\.(tfstate|tfvars)$/i, description: "Terraform state/variables (may contain secrets)", severity: "high" },
  { pattern: /^(\.gitlab-ci\.ya?ml|\.circleci\/config\.yml|\.travis\.yml|\.circleci\/config\.ya?ml)$/i, description: "CI/CD configuration (may contain secrets)", severity: "medium" },
  { pattern: /^(\.dockercfg|\.docker\/config\.json)$/i, description: "Docker registry credentials", severity: "high" },
];

const SENSITIVE_DIRECTORY_PATTERNS: Array<{ pattern: RegExp; description: string; severity: SecretFinding["severity"] }> = [
  { pattern: /(?:^|[\\/])\.ssh([\\/]|$)/i, description: "SSH Configuration Directory (~/.ssh)", severity: "critical" },
  { pattern: /(?:^|[\\/])\.aws([\\/]|$)/i, description: "AWS Credentials Directory (~/.aws)", severity: "critical" },
  { pattern: /(?:^|[\\/])\.kube([\\/]|$)/i, description: "Kubernetes Configuration Directory (~/.kube)", severity: "high" },
  { pattern: /(?:^|[\\/])\.gnupg([\\/]|$)/i, description: "GPG Keyring Directory (~/.gnupg)", severity: "critical" },
  { pattern: /(?:^|[\\/])\.config[\\/]gcloud([\\/]|$)/i, description: "Google Cloud SDK Credentials", severity: "high" },
  { pattern: /(?:^|[\\/])\.config[\\/]azure([\\/]|$)/i, description: "Azure CLI Credentials", severity: "high" },
  { pattern: /(?:^|[\\/])\.azure([\\/]|$)/i, description: "Azure Configuration Directory", severity: "high" },
  { pattern: /(?:^|[\\/])\.docker([\\/]|$)/i, description: "Docker Configuration Directory", severity: "high" },
  { pattern: /(?:^|[\\/])helm([\\/]|$)/i, description: "Helm Configuration Directory", severity: "medium" },
  { pattern: /(?:^|[\\/])\.circleci([\\/]|$)/i, description: "CircleCI configuration directory", severity: "medium" },
];

const SECRET_CONTENT_PATTERNS: Array<{ pattern: RegExp; type: string; severity: SecretFinding["severity"]; redactedMatch: string }> = [
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g, type: "pem_private_key", severity: "critical", redactedMatch: "[REDACTED_PRIVATE_KEY]" },
  { pattern: /-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+OPENSSH\s+PRIVATE\s+KEY-----/g, type: "openssh_private_key", severity: "critical", redactedMatch: "[REDACTED_OPENSSH_PRIVATE_KEY]" },
  { pattern: /-----BEGIN\s+EC\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+EC\s+PRIVATE\s+KEY-----/g, type: "ec_private_key", severity: "critical", redactedMatch: "[REDACTED_EC_PRIVATE_KEY]" },
  { pattern: /-----BEGIN\s+DSA\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+DSA\s+PRIVATE\s+KEY-----/g, type: "dsa_private_key", severity: "critical", redactedMatch: "[REDACTED_DSA_PRIVATE_KEY]" },
  { pattern: /\b[A-Za-z0-9_-]+\.gserviceaccount\.com\b/g, type: "gcp_service_account", severity: "high", redactedMatch: "[REDACTED_GCP_SA_EMAIL]" },
  { pattern: /"type":\s*"service_account"/gi, type: "gcp_service_account_json", severity: "high", redactedMatch: "[REDACTED_GCP_SA_JSON]" },
  { pattern: /\b(private_key|client_secret|client_id)\s*[:=]\s*["'][^"']{20,}["']/gi, type: "cloud_credential", severity: "high", redactedMatch: "[REDACTED_CLOUD_CREDENTIAL]" },
  { pattern: /\b(glpat-|glpt-)[A-Za-z0-9_]{20,}\b/g, type: "gitlab_token", severity: "high", redactedMatch: "[REDACTED_GITLAB_TOKEN]" },
  { pattern: /\b(DO[A-Za-z0-9]{40})\b/g, type: "digitalocean_token", severity: "high", redactedMatch: "[REDACTED_DO_TOKEN]" },
  { pattern: /\b(?:azure|az)\s+(?:storage\s+account|account|client|tenant|subscription|secret|key)\s+(?:key|id|secret|token)\s*[:=]\s*["'][^"']{8,}["']/gi, type: "azure_credential", severity: "high", redactedMatch: "[REDACTED_AZURE_CREDENTIAL]" },
  { pattern: /\b(?:gcloud|gcs|s3)\s+(?:access|secret|token|key)\s*[:=]\s*["'][^"']{8,}["']/gi, type: "cloud_storage_credential", severity: "high", redactedMatch: "[REDACTED_CLOUD_STORAGE_CRED]" },
];

const SECRET_REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:\s*)(?:(?:Bearer|Basic)\s+)?[^\s,;]+/gi, replacement: "$1[REDACTED_HEADER]" },
  { pattern: /((?<![A-Z_])(?:token|access_token|refresh_token|api_key|password|secret)\s*[=:]\s*["']?)([^"'\s&,}]+)/gi, replacement: "$1[REDACTED_SECRET]" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "[REDACTED_PRIVATE_KEY_BLOCK]" },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED_ANTHROPIC_KEY]" },
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replacement: "[REDACTED_OPENAI_KEY]" },
  { pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  { pattern: /\bnpm_[A-Za-z0-9]{20,}\b/g, replacement: "[REDACTED_NPM_TOKEN]" },
  { pattern: /\b(AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS_KEY_ID]" },
  { pattern: /(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/-]{20,}/gi, replacement: "$1[REDACTED_BEARER_TOKEN]" },
  { pattern: /((?:API_KEY|SECRET|PASSWORD|PASSWD|AUTH_TOKEN|PRIVATE_KEY|DATABASE_URL|ACCESS_TOKEN)\s*[:=]\s*["']?)[^"'\s\r\n]{8,}(["']?)/gi, replacement: "$1[REDACTED_SECRET]$2" },
  { pattern: /\b(glpat-|glpt-)[A-Za-z0-9_]{20,}\b/g, replacement: "[REDACTED_GITLAB_TOKEN]" },
  { pattern: /\b(DO[A-Za-z0-9]{40})\b/g, replacement: "[REDACTED_DO_TOKEN]" },
];

function matchesSensitiveFilename(filePath: string): { isSensitive: boolean; reason?: string; severity?: SecretFinding["severity"] } {
  if (!filePath) return { isSensitive: false };
  const normalized = filePath.replace(/\\/g, "/");
  const basename = path.basename(normalized);

  for (const { pattern, description, severity } of SENSITIVE_FILENAME_PATTERNS) {
    if (pattern.test(basename)) {
      return { isSensitive: true, reason: `Sensitive secret file detected: ${basename} (${description})`, severity };
    }
  }

  for (const { pattern, description, severity } of SENSITIVE_DIRECTORY_PATTERNS) {
    if (pattern.test(normalized)) {
      return { isSensitive: true, reason: `Target is inside protected credentials directory (${description})`, severity };
    }
  }

  const homeDir = os.homedir().replace(/\\/g, "/");
  if (normalized.startsWith(homeDir)) {
    const relFromHome = normalized.slice(homeDir.length);
    for (const { pattern, description, severity } of SENSITIVE_DIRECTORY_PATTERNS) {
      if (pattern.test(relFromHome)) {
        return { isSensitive: true, reason: `Target is inside protected credentials directory (${description})`, severity };
      }
    }
  }

  return { isSensitive: false };
}

export function isSensitiveFile(filePath: string): { isSensitive: boolean; reason?: string } {
  const result = matchesSensitiveFilename(filePath);
  if (result.isSensitive) {
    return { isSensitive: true, reason: result.reason };
  }
  return { isSensitive: false };
}

export function scanContentForSecrets(content: string, filePath?: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split("\n");

  // Scan full content first for multiline blocks (private keys, etc.)
  for (const { pattern, type, severity, redactedMatch } of SECRET_CONTENT_PATTERNS) {
    try {
      const regex = new RegExp(pattern.source, pattern.flags);
      const matches = content.match(regex);

      if (matches) {
        for (const match of matches) {
          const lineNumber = content.slice(0, content.indexOf(match)).split("\n").length;
          findings.push({
            type,
            severity,
            file: filePath,
            line: lineNumber,
            redactedMatch,
          });
        }
      }
    } catch {
      // Skip invalid patterns
    }
  }

  // Scan line-by-line for single-line secrets
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const lineNumber = lineIndex + 1;

    for (const { pattern, type, severity, redactedMatch } of SECRET_CONTENT_PATTERNS) {
      try {
        const regex = new RegExp(pattern.source, pattern.flags);
        const matches = line.match(regex);

        if (matches) {
          const alreadyFound = findings.some(
            (f) => f.file === filePath && f.line === lineNumber && f.type === type
          );

          if (!alreadyFound) {
            findings.push({
              type,
              severity,
              file: filePath,
              line: lineNumber,
              redactedMatch,
            });
          }
        }
      } catch {
        // Skip invalid patterns
      }
    }
  }

  return findings;
}

export function scanPathForSecrets(filePath: string): SecretFinding[] {
  const findings: SecretFinding[] = [];

  const filenameResult = matchesSensitiveFilename(filePath);
  if (filenameResult.isSensitive && filenameResult.severity) {
    findings.push({
      type: "sensitive_filename",
      severity: filenameResult.severity,
      file: filePath,
      redactedMatch: `[SENSITIVE_FILE: ${path.basename(filePath)}]`,
    });
  }

  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const content = fs.readFileSync(filePath, "utf-8");
      const contentFindings = scanContentForSecrets(content, filePath);
      findings.push(...contentFindings);
    }
  } catch {
    // Ignore read errors
  }

  return findings;
}

export function redactSecrets(text: string | null | undefined): string {
  if (!text) return "";
  let sanitized = String(text);

  for (const { pattern, replacement } of SECRET_REDACTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  return sanitized;
}

export function hasSecrets(content: string): boolean {
  const findings = scanContentForSecrets(content);
  return findings.length > 0;
}