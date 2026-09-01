/**
 * Version & build metadata for ToolNet CLI.
 *
 * package.json is the source of truth. The embedded constant below must match
 * package.json (enforced by a unit test) and acts as a fallback for
 * standalone compiled binaries where package.json is not present on disk.
 */

import fs from "node:fs";
import path from "node:path";

// @codebuff keep in sync with package.json "version" (guarded by test)
export const EMBEDDED_VERSION = "1.2.0";

const PACKAGE_NAME = "toolnetcli";

let cachedVersion: string | null = null;

function findPackageJson(): string | null {
  // Walk up from the executable/cwd looking for our own package.json.
  const startDirs: string[] = [];
  try {
    if (typeof process !== "undefined" && process.cwd) startDirs.push(process.cwd());
  } catch {}
  try {
    if (typeof import.meta !== "undefined" && import.meta.dir) startDirs.push(import.meta.dir);
  } catch {}

  for (const dir of startDirs) {
    let current = dir;
    for (let i = 0; i < 10; i++) {
      const candidate = path.join(current, "package.json");
      try {
        const raw = fs.readFileSync(candidate, "utf8");
        const pkg = JSON.parse(raw);
        if (pkg?.name === PACKAGE_NAME && typeof pkg.version === "string") {
          return pkg.version;
        }
      } catch {
        // not found / not ours — keep walking up
      }
      const parent = current.replace(/\/+[^/]*$/, "");
      if (parent === current || !parent) break;
      current = parent;
    }
  }
  return null;
}

/** Effective CLI version, e.g. "1.0.5". */
export function getVersion(): string {
  if (cachedVersion) return cachedVersion;
  cachedVersion = EMBEDDED_VERSION;
  const fromPkg = findPackageJson();
  if (fromPkg) cachedVersion = fromPkg;
  return cachedVersion;
}

export interface PlatformInfo {
  platform: "linux" | "darwin" | "windows";
  arch: "x64" | "arm64";
}

export function getPlatform(): PlatformInfo {
  const p = process.platform === "win32" ? "windows" : process.platform;
  return {
    platform: p as PlatformInfo["platform"],
    arch: process.arch === "arm64" ? "arm64" : "x64",
  };
}

/** Human-readable one-liner: `ToolNet CLI v1.0.5 (linux-x64)` */
export function getVersionString(): string {
  const { platform, arch } = getPlatform();
  return `ToolNet CLI v${getVersion()} (${platform}-${arch})`;
}

export interface VersionJson {
  version: string;
  platform: string;
  arch: string;
  installMethod: InstallMethod;
}

import type { InstallMethod } from "./installMethod";
import { detectInstallMethod } from "./installMethod";

export function getVersionJson(): VersionJson {
  const { platform, arch } = getPlatform();
  return {
    version: getVersion(),
    platform,
    arch,
    installMethod: detectInstallMethod(),
  };
}
