/**
 * Child Environment Scrubber — Phase 1 (Layer 4)
 *
 * Provides a hardened allowlist-based environment for child processes spawned
 * by shell execution. Host secrets (API keys, tokens, cloud credentials) are
 * NEVER inherited by children spawned via the ToolGateway shell path.
 *
 * Policy:
 *  - Default child env = minimal allowlist (PATH, HOME, USER, SHELL, LANG, LC_*, TERM, TMPDIR).
 *  - Explicit env vars (tool args) are merged ONLY if they don't collide with
 *    the secret deny-list. Explicit env can never smuggle credentials in.
 *  - Values are never logged (callers must not log returned env values).
 */

const CHILD_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "LANG",
  "TZ",
]);

const LANG_PREFIX = "LC_";

/** Secret deny-list suffixes matched against upper-cased env var names. */
const SECRET_DENY_SUFFIXES = [
  "API_KEY",
  "_APIKEY",
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PRIVATE_KEY",
  "ACCESS_KEY",
  "CREDENTIAL",
  "CREDENTIALS",
  "AUTH",
];

/** Secret deny-list exact names (upper-cased). */
const SECRET_DENY_EXACT = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "NPM_TOKEN",
  "NPM_CONFIG__AUTH",
  "GIT_TOKEN",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_TTY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_API_KEY",
  "AZURE_CLIENT_SECRET",
  "AZURE_ACCESS_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "DATABASE_URL",
  "REDIS_URL",
  "MONGODB_URI",
  "SENTRY_AUTH_TOKEN",
  "SLACK_BOT_TOKEN",
  "STRIPE_SECRET_KEY",
  "VERCEL_TOKEN",
  "NETLIFY_AUTH_TOKEN",
  "HUGGING_FACE_HUB_TOKEN",
  "HF_TOKEN",
  "TOOLNETAPI_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "TOGETHER_API_KEY",
  "COHERE_API_KEY",
  "PERPLEXITY_API_KEY",
]);

/** Well-known cloud provider prefixes whose vars are credential-bearing. */
const SECRET_DENY_PREFIXES = ["AWS_", "AZURE_", "SSH_", "GPG_", "GCLOUD_"];

function looksLikeSecret(name: string): boolean {
  const upper = name.toUpperCase();

  if (SECRET_DENY_EXACT.has(upper)) return true;
  if (SECRET_DENY_PREFIXES.some((p) => upper.startsWith(p))) return true;

  // *KEY, *_KEY (e.g. STRIPE_KEY, ENCRYPTION_KEY)
  if (upper.endsWith("KEY") || upper.endsWith("_KEY")) return true;

  if (SECRET_DENY_SUFFIXES.some((s) => upper.endsWith(s))) return true;

  // Bearer-style blobs: long random tokens stored in generic vars
  if (/^(BEARER|AUTHORIZATION)$/.test(upper)) return true;

  return false;
}

/**
 * Builds a scrubbed child environment.
 *
 * @param processEnv the parent process.env (source of allowlisted values)
 * @param explicitEnv optional explicit env requested by the tool caller —
 *        merged only if each entry passes the same secret deny-list.
 */
export function scrubChildEnv(
  processEnv: NodeJS.ProcessEnv,
  explicitEnv?: Record<string, string>
): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};

  // 1. Allowlist from parent env
  for (const [name, value] of Object.entries(processEnv)) {
    if (value === undefined) continue;
    if (CHILD_ENV_ALLOWLIST.has(name) || name.startsWith(LANG_PREFIX)) {
      scrubbed[name] = value;
    }
  }

  // 2. Merge explicit env only through the same secret deny-list
  if (explicitEnv) {
    for (const [name, value] of Object.entries(explicitEnv)) {
      if (typeof value !== "string") continue;
      if (looksLikeSecret(name)) continue;
      scrubbed[name] = value;
    }
  }

  return scrubbed;
}

/** Test/diagnostic helper: reports whether a var name would be dropped. */
export function isSecretEnvVar(name: string): boolean {
  return looksLikeSecret(name);
}
