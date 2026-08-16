import path from "node:path";
import os from "node:os";

const SENSITIVE_FILENAME_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /^\.env(\..+)?$/i, description: "Environment configuration containing secrets (.env)" },
  { pattern: /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, description: "SSH Private/Public Key" },
  { pattern: /\.(pem|key|p12|pfx|pkcs12)$/i, description: "Cryptographic Private Key or Certificate" },
  { pattern: /\.(kdbx|vault|keychain)$/i, description: "Password database / Vault archive" },
  { pattern: /^\.?(npmrc|netrc|git-credentials)$/i, description: "Authentication credential file" },
  { pattern: /^(master\.key|secret_key_base|credentials\.json)$/i, description: "Master Encryption Key / Credentials" },
  { pattern: /^(service[-_]account.*\.json)$/i, description: "Cloud Service Account Key" },
];

const SENSITIVE_DIRECTORY_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /[\\/]\.ssh([\\/]|$)/i, description: "SSH Configuration Directory (~/.ssh)" },
  { pattern: /[\\/]\.aws([\\/]|$)/i, description: "AWS Credentials Directory (~/.aws)" },
  { pattern: /[\\/]\.kube([\\/]|$)/i, description: "Kubernetes Configuration Directory (~/.kube)" },
  { pattern: /[\\/]\.gnupg([\\/]|$)/i, description: "GPG Keyring Directory (~/.gnupg)" },
  { pattern: /[\\/]\.config[\\/]gcloud([\\/]|$)/i, description: "Google Cloud SDK Credentials" },
];

/**
 * Checks if a given file path points to a sensitive secret or credential store.
 */
export function isSensitiveFile(filePath: string): { isSensitive: boolean; reason?: string } {
  if (!filePath) return { isSensitive: false };
  const normalized = filePath.replace(/\\/g, "/");
  const basename = path.basename(normalized);

  // Check filename patterns
  for (const { pattern, description } of SENSITIVE_FILENAME_PATTERNS) {
    if (pattern.test(basename)) {
      return { isSensitive: true, reason: `Sensitive secret file detected: ${basename} (${description})` };
    }
  }

  // Check sensitive directory patterns
  for (const { pattern, description } of SENSITIVE_DIRECTORY_PATTERNS) {
    if (pattern.test(normalized)) {
      return { isSensitive: true, reason: `Target is inside protected credentials directory (${description})` };
    }
  }

  // Expand home directory if starts with ~
  const homeDir = os.homedir().replace(/\\/g, "/");
  if (normalized.startsWith(homeDir)) {
    const relFromHome = normalized.slice(homeDir.length);
    for (const { pattern, description } of SENSITIVE_DIRECTORY_PATTERNS) {
      if (pattern.test(relFromHome)) {
        return { isSensitive: true, reason: `Target is inside protected credentials directory (${description})` };
      }
    }
  }

  return { isSensitive: false };
}

/**
 * Regex patterns to detect and mask API keys, tokens, and private keys in output text.
 */
const SECRET_REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Private Key Blocks
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY_BLOCK]",
  },
  // Anthropic API Key
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED_ANTHROPIC_KEY]" },
  // OpenAI API Key
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED_OPENAI_KEY]" },
  // GitHub Personal Access Token
  { pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  // NPM Access Token
  { pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, replacement: "[REDACTED_NPM_TOKEN]" },
  // AWS Access Key ID
  { pattern: /\b(AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS_KEY_ID]" },
  // Bearer Token Header
  { pattern: /(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/-]{20,}/gi, replacement: "$1[REDACTED_BEARER_TOKEN]" },
  // Key / Secret assignment in config/env
  {
    pattern: /((?:API_KEY|SECRET|PASSWORD|PASSWD|AUTH_TOKEN|PRIVATE_KEY|DATABASE_URL|ACCESS_TOKEN)\s*[:=]\s*["']?)[^"'\s\r\n]{8,}(["']?)/gi,
    replacement: "$1[REDACTED_SECRET]$2",
  },
];

/**
 * Redacts secret credentials, API keys, and private key blocks from text before logging or transmission.
 */
export function redactSecrets(text: string | null | undefined): string {
  if (!text) return "";
  let sanitized = String(text);

  for (const { pattern, replacement } of SECRET_REDACTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  return sanitized;
}
