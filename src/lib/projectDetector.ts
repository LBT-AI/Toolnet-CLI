import fs from "node:fs";
import path from "node:path";

export type ProjectFramework =
  | "node"
  | "rust"
  | "python"
  | "go"
  | "java"
  | "dotnet"
  | "cpp"
  | "php"
  | "kotlin"
  | "swift"
  | "ruby"
  | "dart"
  | "scala"
  | "make"
  | "unknown";

export interface ProjectDetectionResult {
  framework: ProjectFramework;
  verifyCommands: string[];
  buildCommands: string[];
  testCommands: string[];
  hasTypecheck: boolean;
  configFile: string;
  /** 0..1 — how much evidence the detection is based on. */
  confidence: number;
}

export interface ProjectContext {
  workspaceRoot: string;
  cwd: string;
  gitRoot?: string;
  language: string[];
  primaryLanguage?: string;
  packageManager?: string;
  framework: string[];
  manifestFiles: string[];
  testCommands: string[];
  buildCommands: string[];
  lintCommands: string[];
  typecheckCommands: string[];
  hasTypecheck: boolean;
  readmeFiles: string[];
  agentFiles: string[];
  /** 0..1 — how much evidence the detection is based on. */
  confidence: number;
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
    confidence: 0.95,
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
    confidence: 0.95,
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
    confidence: hasPyproject ? 0.95 : 0.8,
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
    confidence: 0.95,
  };
}

function detectJava(dir: string): ProjectDetectionResult | null {
  // build.gradle.kts belongs to Kotlin detection, not Java — keep the two
  // build systems disjoint so a Kotlin project is never mislabeled as Java.
  const hasGradle = exists(path.join(dir, "build.gradle"));
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
      confidence: 0.9,
    };
  }

  return {
    framework: "java",
    verifyCommands: ["mvn verify -q"],
    buildCommands: ["mvn package -q"],
    testCommands: ["mvn test -q"],
    hasTypecheck: false,
    configFile: "pom.xml",
    confidence: 0.9,
  };
}

function detectDotnet(dir: string): ProjectDetectionResult | null {
  const csproj = listFiles(dir, /\.csproj$/);
  const hasSln = listFiles(dir, /\.sln$/).length > 0;
  if (csproj.length === 0 && !hasSln) return null;

  return {
    framework: "dotnet",
    verifyCommands: ["dotnet build --no-restore"],
    buildCommands: ["dotnet build"],
    testCommands: ["dotnet test"],
    hasTypecheck: false,
    configFile: csproj[0] || "*.sln",
    confidence: 0.9,
  };
}

function detectCpp(dir: string): ProjectDetectionResult | null {
  const hasCMake = exists(path.join(dir, "CMakeLists.txt"));
  const hasMeson = exists(path.join(dir, "meson.build"));
  if (!hasCMake && !hasMeson) return null;

  const verifyCommands = hasCMake ? ["cmake --build ."] : ["meson compile -C build"];
  return {
    framework: "cpp",
    verifyCommands,
    buildCommands: verifyCommands,
    testCommands: hasCMake ? ["ctest"] : ["meson test -C build"],
    hasTypecheck: false,
    configFile: hasCMake ? "CMakeLists.txt" : "meson.build",
    confidence: 0.9,
  };
}

function detectPhp(dir: string): ProjectDetectionResult | null {
  const hasComposer = exists(path.join(dir, "composer.json"));
  if (!hasComposer) return null;
  return {
    framework: "php",
    verifyCommands: ["php -l src"],
    buildCommands: [],
    testCommands: ["vendor/bin/phpunit"],
    hasTypecheck: false,
    configFile: "composer.json",
    confidence: 0.9,
  };
}

function detectKotlin(dir: string): ProjectDetectionResult | null {
  const hasGradleKts =
    exists(path.join(dir, "build.gradle.kts")) ||
    exists(path.join(dir, "settings.gradle.kts"));
  if (!hasGradleKts) return null;
  return {
    framework: "kotlin",
    verifyCommands: ["./gradlew compileKotlin"],
    buildCommands: ["./gradlew build"],
    testCommands: ["./gradlew test"],
    hasTypecheck: false,
    configFile: "build.gradle.kts",
    confidence: 0.85,
  };
}

function detectSwift(dir: string): ProjectDetectionResult | null {
  if (!exists(path.join(dir, "Package.swift"))) return null;
  return {
    framework: "swift",
    verifyCommands: ["swift build"],
    buildCommands: ["swift build"],
    testCommands: ["swift test"],
    hasTypecheck: false,
    configFile: "Package.swift",
    confidence: 0.9,
  };
}

function detectRuby(dir: string): ProjectDetectionResult | null {
  const hasGemfile = exists(path.join(dir, "Gemfile"));
  const hasGemspec = listFiles(dir, /\.gemspec$/).length > 0;
  if (!hasGemfile && !hasGemspec) return null;
  return {
    framework: "ruby",
    verifyCommands: ["bundle exec rubocop"],
    buildCommands: [],
    testCommands: ["bundle exec rspec"],
    hasTypecheck: false,
    configFile: hasGemfile ? "Gemfile" : "*.gemspec",
    confidence: 0.85,
  };
}

function detectDart(dir: string): ProjectDetectionResult | null {
  if (!exists(path.join(dir, "pubspec.yaml"))) return null;
  return {
    framework: "dart",
    verifyCommands: ["dart analyze"],
    buildCommands: ["dart build"],
    testCommands: ["dart test"],
    hasTypecheck: false,
    configFile: "pubspec.yaml",
    confidence: 0.9,
  };
}

function detectScala(dir: string): ProjectDetectionResult | null {
  const hasSbt = exists(path.join(dir, "build.sbt"));
  if (!hasSbt) return null;
  return {
    framework: "scala",
    verifyCommands: ["sbt compile"],
    buildCommands: ["sbt compile"],
    testCommands: ["sbt test"],
    hasTypecheck: false,
    configFile: "build.sbt",
    confidence: 0.9,
  };
}

function listFiles(dir: string, pattern: RegExp): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && pattern.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
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
    confidence: 0.7,
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
    detectKotlin,
    detectJava,
    detectDotnet,
    detectCpp,
    detectPhp,
    detectSwift,
    detectRuby,
    detectDart,
    detectScala,
    detectMake,
  ];

  let best: ProjectDetectionResult | null = null;
  for (const detector of detectors) {
    const result = detector(dir);
    if (result === null) continue;
    if (best === null || (result.confidence ?? 1) > (best.confidence ?? 1)) {
      best = result;
    }
  }

  if (best) return best;

  return {
    framework: "unknown",
    verifyCommands: [],
    buildCommands: [],
    testCommands: [],
    hasTypecheck: false,
    configFile: "",
    confidence: 0,
  };
}

/**
 * Detect ALL frameworks present in a directory (monorepo / multi-language).
 * Returns one result per detected framework, sorted by confidence descending.
 */
export function detectAllFrameworks(dir: string): ProjectDetectionResult[] {
  const detectors = [
    detectNode,
    detectRust,
    detectPython,
    detectGo,
    detectKotlin,
    detectJava,
    detectDotnet,
    detectCpp,
    detectPhp,
    detectSwift,
    detectRuby,
    detectDart,
    detectScala,
    detectMake,
  ];

  const results: ProjectDetectionResult[] = [];
  const seen = new Set<ProjectFramework>();
  for (const detector of detectors) {
    const result = detector(dir);
    if (result !== null && !seen.has(result.framework)) {
      seen.add(result.framework);
      results.push(result);
    }
  }
  return results.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
}

// ---------------------------------------------------------------------------
// Lightweight ProjectContext builder
// ---------------------------------------------------------------------------

const MANIFEST_FILES = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "go.mod",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
  "pubspec.yaml",
  "Package.swift",
  "build.sbt",
  "build.gradle",
  "build.gradle.kts",
  "CMakeLists.txt",
  "meson.build",
  "tsconfig.json",
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
];

const AGENT_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"];

function detectGitRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 12; depth++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function listExisting(dir: string, names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (fs.existsSync(path.join(dir, name))) out.push(name);
  }
  return out;
}

export function buildProjectContext(workspaceRoot: string, cwd?: string): ProjectContext {
  const root = workspaceRoot || process.cwd();
  const cwdDir = cwd || root;
  const gitRoot = detectGitRoot(cwdDir);
  const detections = detectAllFrameworks(root);
  const detection = detections[0] || detectProjectFramework(root);

  const pkgJsonPath = path.join(root, "package.json");
  let packageManager: string | undefined;
  let language: string[] = [];
  let framework: string[] = detections.map((d) => d.framework);

  if (fs.existsSync(pkgJsonPath)) {
    const pkg = readJson(pkgJsonPath);
    if (pkg) {
      language.push("javascript", "typescript");
      if (exists(path.join(root, "bun.lock")) || exists(path.join(root, "bun.lockb"))) {
        packageManager = "bun";
      } else if (exists(path.join(root, "pnpm-lock.yaml"))) {
        packageManager = "pnpm";
      } else if (exists(path.join(root, "yarn.lock"))) {
        packageManager = "yarn";
      } else {
        packageManager = "npm";
      }
    }
  }

  const FRAMEWORK_LANG: Record<string, string> = {
    node: "typescript",
    python: "python",
    rust: "rust",
    go: "go",
    java: "java",
    dotnet: "csharp",
    cpp: "cpp",
    php: "php",
    kotlin: "kotlin",
    swift: "swift",
    ruby: "ruby",
    dart: "dart",
    scala: "scala",
    make: "c",
  };

  for (const d of detections) {
    const lang = FRAMEWORK_LANG[d.framework];
    if (lang && !language.includes(lang)) language.push(lang);
  }

  const manifestFiles = listExisting(root, MANIFEST_FILES);
  const readmeFiles = listExisting(root, ["README.md", "README", "readme.md"]);
  const agentFiles = listExisting(root, AGENT_FILES);

  const typecheckCommands: string[] = [];
  const allCommands = (d: ProjectDetectionResult, key: "verifyCommands" | "testCommands" | "buildCommands"): string[] => d[key];
  for (const d of detections) {
    if (d.framework === "node") {
      const scripts = (readJson(pkgJsonPath) as Record<string, any>)?.scripts ?? {};
      if (scripts["typecheck"]) typecheckCommands.push(`${packageManager || "npm"} run typecheck`);
      else if (scripts["type-check"]) typecheckCommands.push(`${packageManager || "npm"} run type-check`);
      else if (fs.existsSync(path.join(root, "tsconfig.json"))) typecheckCommands.push("tsc --noEmit");
    } else if (d.framework === "python") {
      if (manifestFiles.includes("pyproject.toml")) {
        typecheckCommands.push("mypy .");
      } else {
        typecheckCommands.push("python -m py_compile **/*.py");
      }
    } else if (d.framework === "rust") {
      typecheckCommands.push("cargo check");
    } else if (d.framework === "go") {
      typecheckCommands.push("go vet ./...");
    } else if (d.framework === "dotnet") {
      typecheckCommands.push("dotnet build --no-restore");
    } else if (d.framework === "dart") {
      typecheckCommands.push("dart analyze");
    } else if (d.framework === "swift") {
      typecheckCommands.push("swift build");
    } else if (d.framework === "scala") {
      typecheckCommands.push("sbt compile");
    }
  }

  // Merge verification/build/test commands from every detected framework so
  // the agent can verify each language present in a monorepo.
  const testCommands: string[] = [];
  const buildCommands: string[] = [];
  const lintCommands: string[] = [];
  const verifyCommands: string[] = [];
  for (const d of detections) {
    for (const c of allCommands(d, "testCommands")) if (!testCommands.includes(c)) testCommands.push(c);
    for (const c of allCommands(d, "buildCommands")) if (!buildCommands.includes(c)) buildCommands.push(c);
    for (const c of allCommands(d, "verifyCommands")) if (!verifyCommands.includes(c)) verifyCommands.push(c);
  }
  if (framework.includes("node")) lintCommands.push(`${packageManager || "npm"} run lint`);
  for (const c of verifyCommands) if (!typecheckCommands.includes(c)) typecheckCommands.push(c);

  return {
    workspaceRoot: root,
    cwd: cwdDir,
    gitRoot,
    language: [...new Set(language)],
    primaryLanguage: detection.framework === "unknown" ? undefined : FRAMEWORK_LANG[detection.framework],
    packageManager,
    framework,
    manifestFiles,
    testCommands,
    buildCommands,
    lintCommands,
    typecheckCommands,
    hasTypecheck: detection.hasTypecheck || typecheckCommands.length > 0,
    readmeFiles,
    agentFiles,
    confidence: detection.framework === "unknown" ? 0 : detection.confidence ?? 0.7,
  };
}

