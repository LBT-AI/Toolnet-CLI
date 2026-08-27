import { loadCliKeys } from "../keys";

const PLACEHOLDER_STRINGS = new Set([
  "YOUR_API_KEY",
  "YOUR_TOKEN",
  "YOUR_KEY",
  "INSERT_KEY_HERE",
  "MY_SECRET_TOKEN",
  "sk-xxx",
  "sk-placeholder",
  "sk-ant-placeholder",
  "ghp_placeholder",
  "AKIAEXAMPLE",
]);

function isPlaceholder(value: string): boolean {
  if (!value || value.length < 5) return true;
  if (PLACEHOLDER_STRINGS.has(value) || PLACEHOLDER_STRINGS.has(value.toUpperCase())) return true;
  if (/^sk-[xX]+$/.test(value)) return true;
  if (/^sk-placeholder/i.test(value)) return true;
  if (/^sk-ant-placeholder/i.test(value)) return true;
  if (/^<.*>$/.test(value) || /^\[.*\]$/.test(value)) return true;
  if (/^fake[-_]/i.test(value) || /^test[-_]token/i.test(value)) return true;
  return false;
}

function maskWithEnds(val: string, prefixLen = 3, suffixLen = 3): string {
  if (val.length <= prefixLen + suffixLen) {
    return "****";
  }
  const prefix = val.slice(0, prefixLen);
  const suffix = val.slice(-suffixLen);
  return `${prefix}****${suffix}`;
}

export function redactOutputSecrets(text: string | null | undefined): string {
  if (!text) return "";
  let sanitized = String(text);

  // 1. Private Key Blocks (RSA, OPENSSH, EC, DSA, PGP, Generic)
  sanitized = sanitized.replace(
    /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9_-]+ )?PRIVATE KEY(?: BLOCK)?-----/g,
    "[REDACTED_PRIVATE_KEY]"
  );
  sanitized = sanitized.replace(
    /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]"
  );

  // 2. Anthropic API keys
  sanitized = sanitized.replace(/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, (match) => {
    if (isPlaceholder(match)) return match;
    const prefix = match.startsWith("sk-ant-api03-") ? "sk-ant-api03-" : "sk-ant-";
    const remainder = match.slice(prefix.length);
    const suffix = remainder.slice(-3);
    return `${prefix}****${suffix}`;
  });

  // 3. OpenAI-style API keys (sk-..., sk-proj-...)
  sanitized = sanitized.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, (match) => {
    if (isPlaceholder(match)) return match;
    if (match.startsWith("sk-ant-")) return match;
    const prefix = match.startsWith("sk-proj-") ? "sk-proj-" : "sk-";
    const remainder = match.slice(prefix.length);
    const suffix = remainder.slice(-3);
    return `${prefix}****${suffix}`;
  });

  // 4. GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_)
  sanitized = sanitized.replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}\b/g, (match, pfx) => {
    if (isPlaceholder(match)) return match;
    const remainder = match.slice(pfx.length + 1);
    const suffix = remainder.slice(-3);
    return `${pfx}_****${suffix}`;
  });
  sanitized = sanitized.replace(/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, (match) => {
    if (isPlaceholder(match)) return match;
    const remainder = match.slice("github_pat_".length);
    const suffix = remainder.slice(-3);
    return `github_pat_****${suffix}`;
  });

  // 5. AWS Access Key IDs (AKIA..., ABIA..., ACCA..., ASIA...)
  sanitized = sanitized.replace(/\b(AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g, (match, pfx) => {
    if (match === "AKIAIOSFODNN7EXAMPLE" || isPlaceholder(match)) return match;
    const suffix = match.slice(-4);
    return `${pfx}****${suffix}`;
  });

  // 6. Bearer tokens in headers
  sanitized = sanitized.replace(/((?:Bearer|authorization:\s*Bearer)\s+)([A-Za-z0-9._~+/-]{20,})/gi, (match, prefix, token) => {
    if (isPlaceholder(token) || token.toLowerCase().includes("placeholder")) {
      return match;
    }
    const suffix = token.slice(-3);
    return `${prefix}****${suffix}`;
  });

  // 7. Generic API key assignments
  sanitized = sanitized.replace(
    /(\b(?:api[_-]?key|apiKey|secret[_-]?key|auth[_-]?token|access[_-]?token)\s*[:=]\s*["'])([^"'\s\r\n]{16,})(["'])/gi,
    (match, prefix, val, suffix) => {
      if (isPlaceholder(val)) return match;
      return `${prefix}****${suffix}`;
    }
  );

  // 8. Stored CLI keys in KeyManager
  try {
    const keys = loadCliKeys();
    for (const [, keyVal] of Object.entries(keys)) {
      if (typeof keyVal === "string" && keyVal.length >= 8) {
        if (sanitized.includes(keyVal)) {
          sanitized = sanitized.replaceAll(keyVal, maskWithEnds(keyVal, 3, 3));
        }
      }
    }
  } catch {}

  return sanitized;
}
