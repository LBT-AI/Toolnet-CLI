/**
 * Installation-method detection for ToolNet CLI.
 *
 * Standalone in its own module so both `version` and `updater` can use it
 * without circular imports.
 */

export type InstallMethod = "binary" | "npm" | "dev" | "unknown";

import fs from "node:fs";

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/**
 * Detects how the currently-running CLI was installed:
 * - "binary": standalone compiled executable (bun --compile artifact)
 * - "npm": installed via npm install -g toolnetcli (bin/toolnet.js launcher)
 * - "dev": running from a source checkout (`bun src/index.tsx`)
 *
 * TOOLNET_INSTALL_METHOD env var overrides (useful for tests and unusual
 * packaging such as Homebrew or Scoop).
 */
export function detectInstallMethod(): InstallMethod {
  const override = process.env.TOOLNET_INSTALL_METHOD;
  if (
    override === "binary" ||
    override === "npm" ||
    override === "dev" ||
    override === "unknown"
  ) {
    return override;
  }

  const execPath = normalizePath(process.execPath || "");
  const argv0 = normalizePath(process.argv[0] || "");
  const base = execPath.split("/").pop() || "";

  // bun --compile: the executable IS our binary (argv[0] points at it too).
  if (base.startsWith("toolnet") && execPath === argv0) return "binary";

  // npm install: launched through bin/toolnet.js with node/bun runtime.
  if (/\/(node|bun)(\.exe)?$/.test(execPath) && !execPath.includes("/src/")) {
    return "npm";
  }

  // Running straight from source: `bun src/index.tsx`
  if (execPath.includes("/bun") || /\/bun(\.exe)?$/.test(execPath)) {
    try {
      const cwd = normalizePath(process.cwd() + "/package.json");
      const pkg = JSON.parse(fs.readFileSync(cwd, "utf8"));
      if (pkg?.name === "toolnetcli") return "dev";
    } catch {}
    return "unknown";
  }

  if (base.startsWith("toolnet")) return "binary";
  return "unknown";
}
