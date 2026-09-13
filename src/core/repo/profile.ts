import path from "node:path";
import fs from "node:fs";

export interface RepositoryProfile {
  root: string;
  vcs: "git" | "none";
  languages: string[];
  packageManagers: string[];
  buildSystems: string[];
  sourceRoots: string[];
  testRoots: string[];
  configFiles: string[];
  instructionFiles: string[];
  gitState: {
    clean: boolean;
    branch: string;
  };
}

export function detectRepositoryProfile(cwd: string): RepositoryProfile {
  const root = findProjectRoot(cwd);
  
  const vcs = fs.existsSync(path.join(root, ".git")) ? "git" : "none";
  let branch = "";
  let clean = true;
  
  if (vcs === "git") {
    try {
      const { execSync } = require("node:child_process");
      branch = execSync("git branch --show-current", { cwd: root, stdio: "pipe" }).toString().trim();
      const status = execSync("git status --porcelain", { cwd: root, stdio: "pipe" }).toString().trim();
      clean = status.length === 0;
    } catch {
      // Ignored
    }
  }

  const packageManagers: string[] = [];
  const buildSystems: string[] = [];
  const configFiles: string[] = [];

  if (fs.existsSync(path.join(root, "package.json"))) {
    configFiles.push("package.json");
    if (fs.existsSync(path.join(root, "bun.lockb")) || fs.existsSync(path.join(root, "bun.lock"))) {
      packageManagers.push("bun");
    } else if (fs.existsSync(path.join(root, "yarn.lock"))) {
      packageManagers.push("yarn");
    } else if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) {
      packageManagers.push("pnpm");
    } else {
      packageManagers.push("npm");
    }
  }

  if (fs.existsSync(path.join(root, "Cargo.toml"))) {
    configFiles.push("Cargo.toml");
    packageManagers.push("cargo");
    buildSystems.push("cargo");
  }

  if (fs.existsSync(path.join(root, "pyproject.toml"))) {
    configFiles.push("pyproject.toml");
    packageManagers.push("pip"); // Simplified
  }

  // Find instruction files (AGENTS.md)
  const instructionFiles: string[] = [];
  if (fs.existsSync(path.join(root, "AGENTS.md"))) {
    instructionFiles.push("AGENTS.md");
  }
  
  return {
    root,
    vcs,
    languages: detectLanguages(root),
    packageManagers,
    buildSystems,
    sourceRoots: ["src", "lib", "packages"].filter(d => fs.existsSync(path.join(root, d))),
    testRoots: ["tests", "__tests__", "test"].filter(d => fs.existsSync(path.join(root, d))),
    configFiles,
    instructionFiles,
    gitState: { clean, branch },
  };
}

function findProjectRoot(startDir: string): string {
  let current = startDir;
  while (current !== path.parse(current).root) {
    if (
      fs.existsSync(path.join(current, ".git")) ||
      fs.existsSync(path.join(current, "package.json")) ||
      fs.existsSync(path.join(current, "Cargo.toml")) ||
      fs.existsSync(path.join(current, "pyproject.toml"))
    ) {
      return current;
    }
    current = path.dirname(current);
  }
  // Default to startDir if no clear root found to avoid treating filesystem root as project root.
  return startDir;
}

function detectLanguages(root: string): string[] {
  const languages: string[] = [];
  if (fs.existsSync(path.join(root, "tsconfig.json"))) languages.push("typescript");
  else if (fs.existsSync(path.join(root, "package.json"))) languages.push("javascript");
  
  if (fs.existsSync(path.join(root, "Cargo.toml"))) languages.push("rust");
  if (fs.existsSync(path.join(root, "pyproject.toml"))) languages.push("python");
  if (fs.existsSync(path.join(root, "go.mod"))) languages.push("go");
  
  return languages;
}
