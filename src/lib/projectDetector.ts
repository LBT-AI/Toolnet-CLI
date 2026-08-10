import fs from "node:fs";
import path from "node:path";

export type ProjectFramework =
  | "node"
  | "rust"
  | "python"
  | "go"
  | "java"
  | "make"
  | "unknown";

export interface ProjectDetectionResult {
  framework: ProjectFramework;
  /** Ordered list of commands to run for verification */
  verifyCommands: string[];
  /** Commands to build the project */
  buildCommands: string[];
  /** Commands to run tests */
  testCommands: string[];
  hasTypecheck: boolean;
  /** The config file that triggered detection, e.g. "package.json", "Cargo.toml" */
  configFile: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function readJson(filePath: string): Record<string, any> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function fileContainsLine(filePath: string, pattern: RegExp): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return pattern.test(content);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-framework detectors
// ---------------------------------------------------------------------------

function detectNode(dir: string): ProjectDetectionResult | null {
  const pkgPath = path.join(dir, "package.json");
  if (!exists(pkgPath)) return null;

  const pkg = readJson(pkgPath);
  const scripts: Record<string, string> = pkg?.scripts ?? {};

  // Prefer bun if bun.lock is present, otherwise npm
  const hasBunLock =
    exists(path.join(dir, "bun.lock")) ||
    exists(path.join(dir, "bun.lockb"));
  const runner = hasBunLock ? "bun run" : "npm run";

  // Resolve actual script names present in package.json
  const typecheckScript =
    scripts["typecheck"] != null
      ? "typecheck"
      : scripts["type-check"] != null
      ? "type-check"
      : null;

  const testScript = scripts["test"] != null ? "test" : null;
  const lintScript = scripts["lint"] != null ? "lint" : null;
  const buildScript = scripts["build"] != null ? "build" : null;

  const verifyCommands: string[] = [];
  if (typecheckScript) verifyCommands.push(`${runner} ${typecheckScript}`);
  if (lintScript) verifyCommands.push(`${runner} ${lintScript}`);

  const testCommands: string[] = [];
  if (testScript) testCommands.push(`${runner} ${testScript}`);

  const buildCommands: string[] = [];
  if (buildScript) buildCommands.push(`${runner} ${buildScript}`);

  return {
    framework: "node",
    verifyCommands,
    buildCommands,
    testCommands,
    hasTypecheck: typecheckScript !== null,
    configFile: "package.json",
  };
}

function detectRust(dir: string): ProjectDetectionResult | null {
  if (!exists(path.join(dir, "Cargo.toml"))) return null;
  return {
    framework: "rust",
    verifyCommands: ["cargo check"],
    buildCommands: ["cargo build"],
    testCommands: ["cargo test"],
    hasTypecheck: false,
    configFile: "Cargo.toml",
  };
}

function detectPython(dir: string): ProjectDetectionResult | null {
  const hasPyproject = exists(path.join(dir, "pyproject.toml"));
  const hasSetupPy = exists(path.join(dir, "setup.py"));
  const hasRequirements = exists(path.join(dir, "requirements.txt"));

  if (!hasPyproject && !hasSetupPy && !hasRequirements) return null;

  const configFile = hasPyproject
    ? "pyproject.toml"
    : hasSetupPy
    ? "setup.py"
    : "requirements.txt";

  const verifyCommands: string[] = [];
  // Detect mypy / ruff presence
  const pyprojectPath = path.join(dir, "pyproject.toml");
  const hasMypyConfig = hasPyproject && fileContainsLine(pyprojectPath, /mypy/i);
  const hasRuffConfig = hasPyproject && fileContainsLine(pyprojectPath, /ruff/i);

  if (hasRuffConfig) verifyCommands.push("ruff check .");
  if (hasMypyConfig) verifyCommands.push("mypy .");
  if (verifyCommands.length === 0) verifyCommands.push("python -m py_compile **/*.py");

  const testCommands: string[] = ["pytest"];

  return {
    framework: "python",
    verifyCommands,
    buildCommands: ["python -m build"],
    testCommands,
    hasTypecheck: hasMypyConfig,
    configFile,
  };
}

function detectGo(dir: string): ProjectDetectionResult | null {
  if (!exists(path.join(dir, "go.mod"))) return null;
  return {
    framework: "go",
    verifyCommands: ["go vet ./..."],
    buildCommands: ["go build ./..."],
    testCommands: ["go test ./..."],
    hasTypecheck: false,
    configFile: "go.mod",
  };
}

function detectJava(dir: string): ProjectDetectionResult | null {
  const hasGradle =
    exists(path.join(dir, "build.gradle")) ||
    exists(path.join(dir, "build.gradle.kts"));
  const hasMaven = exists(path.join(dir, "pom.xml"));

  if (!hasGradle && !hasMaven) return null;

  if (hasGradle) {
    return {
      framework: "java",
      verifyCommands: ["./gradlew check"],
      buildCommands: ["./gradlew build"],
      testCommands: ["./gradlew test"],
      hasTypecheck: false,
      configFile: "build.gradle",
    };
  }

  return {
    framework: "java",
    verifyCommands: ["mvn verify -q"],
    buildCommands: ["mvn package -q"],
    testCommands: ["mvn test -q"],
    hasTypecheck: false,
    configFile: "pom.xml",
  };
}

function detectMake(dir: string): ProjectDetectionResult | null {
  const makefilePath = path.join(dir, "Makefile");
  if (!exists(makefilePath)) return null;

  const hasTestTarget = fileContainsLine(makefilePath, /^test\s*:/m);

  return {
    framework: "make",
    verifyCommands: ["make"],
    buildCommands: ["make"],
    testCommands: hasTestTarget ? ["make test"] : [],
    hasTypecheck: false,
    configFile: "Makefile",
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detects the project framework for the given directory.
 *
 * Priority order: node > rust > python > go > java > make > unknown
 */
export function detectProjectFramework(dir: string): ProjectDetectionResult {
  const detectors = [
    detectNode,
    detectRust,
    detectPython,
    detectGo,
    detectJava,
    detectMake,
  ];

  for (const detector of detectors) {
    const result = detector(dir);
    if (result !== null) return result;
  }

  return {
    framework: "unknown",
    verifyCommands: [],
    buildCommands: [],
    testCommands: [],
    hasTypecheck: false,
    configFile: "",
  };
}
