/**
 * Auto-update system for ToolNet CLI.
 *
 * Strategy:
 * - npm install method  → `npm install -g toolnetcli@latest`
 * - binary install      → download GitHub Release artifact + SHA256 check + atomic rename
 * - dev install         → prints instructions (no auto-update)
 *
 * Background check cadence: at most once per 24 h (configurable in appConfig).
 * Timestamps are cached in ~/.toolnetcli/cache/update-check.json.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfigDir } from "./appConfig";
import { detectInstallMethod, type InstallMethod } from "./installMethod";
import { getPlatform, getVersion } from "./version";

export { detectInstallMethod, type InstallMethod } from "./installMethod";

const GITHUB_REPO = "LBT-AI/Toolnet-CLI";
const NPM_PACKAGE = "toolnetcli";
const CHECK_TIMEOUT_MS = 4_000;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 h

/* ------------------------------------------------------------------ */
/*  Semver helpers (major.minor.patch only, ignore pre-release)       */
/* ------------------------------------------------------------------ */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/** Parse a version string like "1.0.5" or "v1.0.5" — returns null if unparseable. */
export function parseSemver(raw: string): Semver | null {
  const m = raw.replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

/** Returns 1 if a > b, -1 if a < b, 0 if equal. */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  return 0;
}

/* ------------------------------------------------------------------ */
/*  Cache helpers                                                     */
/* ------------------------------------------------------------------ */

interface CheckCache { lastCheckMs: number; latestVersion: string | null }

function cachePath(): string {
  return path.join(getConfigDir(), "cache", "update-check.json");
}

function loadCache(): CheckCache {
  try { return JSON.parse(fs.readFileSync(cachePath(), "utf8")); } catch {}
  return { lastCheckMs: 0, latestVersion: null };
}

function saveCache(cache: CheckCache): void {
  try {
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(cache), "utf8");
  } catch {}
}

/* ------------------------------------------------------------------ */
/*  Fetch latest version from registry / GitHub API                   */
/* ------------------------------------------------------------------ */

async function fetchLatestNpmVersion(): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return typeof data.version === "string" ? data.version : null;
  } catch { return null; }
}

async function fetchLatestGitHubVersion(): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return typeof data.tag_name === "string" ? data.tag_name.replace(/^v/i, "") : null;
  } catch { return null; }
}

/**
 * Fetch latest version. Uses GitHub Releases API for binary installs
 * and npm registry for npm installs. Falls back to the other if one fails.
 */
export async function fetchLatestVersion(method?: InstallMethod): Promise<string | null> {
  const m = method ?? detectInstallMethod();
  if (m === "npm") {
    return (await fetchLatestNpmVersion()) ?? (await fetchLatestGitHubVersion());
  }
  return (await fetchLatestGitHubVersion()) ?? (await fetchLatestNpmVersion());
}

/* ------------------------------------------------------------------ */
/*  Background check (non-blocking)                                   */
/* ------------------------------------------------------------------ */

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
}

/**
 * Check if an update is available, respecting cache cadence.
 * Returns null if: (a) offline / error, (b) already checked recently,
 * (c) auto-update is disabled in config.
 */
export async function backgroundCheck(): Promise<UpdateInfo | null> {
  try {
    const { getAppConfig } = await import("./appConfig");
    const cfg = getAppConfig();
    if (!cfg.updateCheckEnabled) return null;

    const cache = loadCache();
    const intervalMs = Math.max(1, cfg.updateCheckIntervalHours) * 60 * 60 * 1000;
    if (Date.now() - cache.lastCheckMs < intervalMs) {
      if (cache.latestVersion) {
        const cur = parseSemver(getVersion());
        const lat = parseSemver(cache.latestVersion);
        if (cur && lat) return { currentVersion: getVersion(), latestVersion: cache.latestVersion, hasUpdate: compareSemver(lat, cur) > 0 };
      }
      return null;
    }

    const latest = await fetchLatestVersion();
    const now = Date.now();

    if (!latest) { saveCache({ lastCheckMs: now, latestVersion: null }); return null; }

    saveCache({ lastCheckMs: now, latestVersion: latest });

    const cur = parseSemver(getVersion());
    const lat = parseSemver(latest);
    if (!cur || !lat) return null;

    return { currentVersion: getVersion(), latestVersion: latest, hasUpdate: compareSemver(lat, cur) > 0 };
  } catch {
    return null; // offline / error → silent
  }
}

/* ------------------------------------------------------------------ */
/*  Artifact helpers for binary install                               */
/* ------------------------------------------------------------------ */

function artifactNameFor(platform: string, arch: string): string {
  const ext = platform === "windows" ? ".exe" : "";
  return `toolnet-${platform}-${arch}${ext}`;
}

function artifactTarName(platform: string, arch: string): string {
  if (platform === "windows") return `toolnet-windows-${arch}.zip`;
  return `toolnet-${platform}-${arch}.tar.gz`;
}

function githubDownloadUrl(tag: string, filename: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/download/v${tag}/${filename}`;
}

function githubChecksumUrl(tag: string): string {
  return githubDownloadUrl(tag, "checksums.txt");
}

/* ------------------------------------------------------------------ */
/*  SHA-256 helpers                                                   */
/* ------------------------------------------------------------------ */

function sha256File(filePath: string): string | null {
  try {
    // crypto - file
    const content = fs.readFileSync(filePath);
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    return createHash("sha256").update(content).digest("hex");
  } catch { return null; }
}

function sha256String(data: string): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(data).digest("hex");
}

function verifyChecksum(filePath: string, checksumsText: string): boolean {
  const filename = path.basename(filePath);
  const hash = sha256File(filePath);
  if (!hash) return false;
  // Lines: <hash>  <filename>
  const lines = checksumsText.split("\n").filter(l => l.includes(filename));
  return lines.some(line => line.startsWith(hash) || line.includes(hash));
}

/* ------------------------------------------------------------------ */
/*  Perform the update                                                */
/* ------------------------------------------------------------------ */

export interface UpdateResult {
  success: boolean;
  message: string;
}

export async function performUpdate(latestVersion: string): Promise<UpdateResult> {
  const method = detectInstallMethod();

  if (method === "dev") {
    return { success: false, message: "Run `git pull` to update a development checkout." };
  }

  if (method === "npm") {
    try {
      execSync(`npm install -g ${NPM_PACKAGE}@${latestVersion}`, {
        stdio: "pipe",
        timeout: 120_000,
      });
      return { success: true, message: `Updated to v${latestVersion} via npm.` };
    } catch (err: any) {
      return { success: false, message: `npm update failed: ${err?.message ?? err}\nTry: npm install -g ${NPM_PACKAGE}@latest` };
    }
  }

  // Binary install
  const { platform, arch } = getPlatform();
  const tarName = artifactTarName(platform, arch);
  const url = githubDownloadUrl(latestVersion, tarName);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-update-"));
  const tmpFile = path.join(tmpDir, tarName);

  try {
    // Download
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tmpFile, buf);

    // Verify checksum
    const checksumUrl = githubChecksumUrl(latestVersion);
    const ckRes = await fetch(checksumUrl, { signal: AbortSignal.timeout(10_000) });
    if (ckRes.ok) {
      const checksumText = await ckRes.text();
      if (!verifyChecksum(tmpFile, checksumText)) {
        return { success: false, message: "SHA-256 checksum verification failed. Aborting update." };
      }
    }

    // Extract
    const { execSync: exec } = { execSync };
    if (tarName.endsWith(".zip")) {
      exec(`unzip -o -d ${tmpDir} "${tmpFile}"`, { stdio: "pipe" });
    } else {
      exec(`tar -xzf "${tmpFile}" -C ${tmpDir}`, { stdio: "pipe" });
    }

    const extractedBin = path.join(tmpDir, artifactNameFor(platform, arch));
    if (!fs.existsSync(extractedBin)) {
      return { success: false, message: `Extracted binary not found: ${extractedBin}` };
    }

    // Determine target path
    const selfPath = process.execPath || process.argv[0];
    const targetPath = selfPath;
    const backupPath = `${targetPath}.bak.${Date.now()}`;

    // Atomic replace: rename current → backup, new → target
    fs.renameSync(targetPath, backupPath);
    fs.copyFileSync(extractedBin, targetPath);
    fs.chmodSync(targetPath, 0o755);
    try { fs.unlinkSync(backupPath); } catch {}

    return { success: true, message: `Updated to v${latestVersion} (${platform}-${arch}).` };
  } catch (err: any) {
    return { success: false, message: `Binary update failed: ${err?.message ?? err}` };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/* ------------------------------------------------------------------ */
/*  CLI update command handler                                        */
/* ------------------------------------------------------------------ */

export async function handleUpdate(args: string[]): Promise<void> {
  const checkOnly = args.includes("--check");

  console.log("Checking for updates...");
  const info = await backgroundCheck();
  if (!info) {
    console.log("Unable to check for updates (offline or cached).");
    return;
  }
  if (!info.hasUpdate) {
    console.log(`ToolNet CLI is up to date (v${info.currentVersion}).`);
    return;
  }

  console.log(
    `ToolNet CLI ${info.latestVersion} available (current ${info.currentVersion})`
  );
  if (checkOnly) return;

  const yes = args.includes("--yes") || args.includes("-y");
  if (!yes) {
    const answer = await promptUser("Update now? [y/N] ");
    if (!answer || !answer.toLowerCase().startsWith("y")) {
      console.log("Update cancelled.");
      return;
    }
  }

  const result = await performUpdate(info.latestVersion);
  console.log(result.message);
}

function promptUser(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const { createInterface } = require("node:readline") as typeof import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(prompt, (answer: string) => {
        rl.close();
        resolve(answer);
      });
    } catch {
      resolve(null);
    }
  });
}
