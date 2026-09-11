/**
 * Phase 77.24 — Sample plugin: deny secret files.
 *
 * Opt-in only. Copy into `<workspace>/.toolnet/plugins/` and list it in
 * `.toolnet/plugins.json`:
 *
 *   { "plugins": ["./plugins/deny-secret-files.ts"] }
 *
 * Behaviour:
 *   - hooks `tool.before` for the file-reading tools;
 *   - denies access to well-known credential files;
 *   - returns `{ action: "deny", reason }` so the call is stopped BEFORE any
 *     permission evaluation or filesystem access happens.
 *
 * IMPORTANT: this is an ADDITIONAL policy layer, not a replacement. The core
 * PermissionEngine still evaluates every call; this plugin can only make the
 * policy strictly stricter, never more permissive.
 */

import path from "node:path";

/** Tools whose `path` argument should be inspected. */
const FILE_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "replace_all",
  "grep",
  "glob",
  "list_dir",
  "file_exists",
  "delete_file",
]);

/** Exact basenames that always carry credentials. */
const DENIED_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.staging",
  "credentials.json",
  "credentials.yaml",
  "service-account.json",
  "id_rsa",
  "id_ed25519",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".htpasswd",
]);

/** Suffix patterns for env files with deployment qualifiers. */
function isDeniedFile(target: string): boolean {
  const base = path.basename(target).toLowerCase();
  if (DENIED_BASENAMES.has(base)) return true;
  if (base.startsWith(".env.") && !base.endsWith(".example")) return true;
  if (base.endsWith(".pem") || base.endsWith(".p12") || base.endsWith(".pfx")) return true;
  return false;
}

export default {
  id: "deny-secret-files",
  name: "Deny secret files",
  version: "1.0.0",

  setup(ctx: {
    logger: { info: (m: string, meta?: Record<string, unknown>) => void };
    registerHook: (
      name: string,
      handler: (invocation: { input: unknown }) => unknown,
    ) => void;
  }) {
    ctx.registerHook("tool.before", (invocation) => {
      const input = (invocation.input ?? {}) as { tool?: string; args?: Record<string, unknown> };
      if (!input.tool || !FILE_TOOLS.has(input.tool)) return;

      const target = input.args?.path ?? input.args?.root ?? input.args?.query;
      if (typeof target !== "string" || !target) return;

      // Directory listing of "." is fine; only an explicit denied file is blocked.
      if (!isDeniedFile(target)) return;

      ctx.logger.info("blocked access to a credential file", { tool: input.tool, path: target });
      return {
        action: "deny",
        reason: `'${path.basename(target)}' may contain credentials and is blocked by the deny-secret-files policy plugin`,
      };
    });
  },
};
