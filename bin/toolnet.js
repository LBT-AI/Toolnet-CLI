#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(__dirname, "..", "dist", "index.js");
const nodeBundlePath = join(__dirname, "..", "dist", "node", "index.js");
const args = process.argv.slice(2);

const home = os.homedir();
const bunBinDir = join(home, ".bun", "bin");
const sep = process.platform === "win32" ? ";" : ":";
const currentPath = process.env.PATH || "";

// Prepend Bun and standard binary paths while PRESERVING existing PATH (NVM, pnpm, ~/.local/bin, etc.)
const pathEntries = [bunBinDir, "/usr/local/bin", "/usr/bin", "/bin"];
if (currentPath) {
  pathEntries.push(currentPath);
}
const envPath = pathEntries.join(sep);

function findBunExecutable() {
  if (process.versions && process.versions.bun) {
    return process.execPath;
  }
  const localBun = join(bunBinDir, process.platform === "win32" ? "bun.exe" : "bun");
  if (fs.existsSync(localBun)) return localBun;

  try {
    const cmd = process.platform === "win32" ? "where bun" : "which bun";
    const res = execSync(cmd, { env: { ...process.env, PATH: envPath }, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (res) {
      const firstLine = res.split(/\r?\n/)[0];
      if (fs.existsSync(firstLine)) return firstLine;
    }
  } catch {}

  return null;
}

const bunBin = findBunExecutable();

if (bunBin) {
  const child = spawn(bunBin, [bundlePath, ...args], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: { ...process.env, PATH: envPath },
  });

  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    console.error("Failed to start ToolNet with Bun:", err.message);
    process.exit(1);
  });
} else if (fs.existsSync(nodeBundlePath)) {
  const child = spawn(process.execPath, [nodeBundlePath, ...args], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: { ...process.env, PATH: envPath },
  });

  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    console.error("Failed to start ToolNet with Node:", err.message);
    process.exit(1);
  });
} else {
  console.error("\x1b[31mToolNet CLI requires Bun runtime for high-performance execution.\x1b[0m");
  console.error("Please install Bun using:\n  curl -fsSL https://bun.sh/install | bash\nor visit https://bun.sh");
  process.exit(1);
}
