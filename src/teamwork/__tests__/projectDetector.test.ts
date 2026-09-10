import { test, expect, describe, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  detectProjectFramework,
  detectAllFrameworks,
  buildProjectContext,
} from "../../lib/projectDetector";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-pd-test-"));
}

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = makeTempDir();
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Node.js detection
// ---------------------------------------------------------------------------

describe("detectProjectFramework – Node.js", () => {
  test("detects node from package.json with bun.lock (uses bun run)", () => {
    const dir = createTempDir();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "test-pkg",
        scripts: {
          typecheck: "tsc --noEmit",
          test: "bun test",
          lint: "eslint .",
          build: "bun build src/index.ts",
        },
      })
    );
    fs.writeFileSync(path.join(dir, "bun.lock"), "");

    const result = detectProjectFramework(dir);

    expect(result.framework).toBe("node");
    expect(result.configFile).toBe("package.json");
    expect(result.hasTypecheck).toBe(true);
    expect(result.verifyCommands).toContain("bun run typecheck");
    expect(result.verifyCommands).toContain("bun run lint");
    expect(result.testCommands).toContain("bun run test");
    expect(result.buildCommands).toContain("bun run build");
  });

  test("detects node from package.json without bun.lock (uses npm run)", () => {
    const dir = createTempDir();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "npm-pkg",
        scripts: {
          "type-check": "tsc --noEmit",
          test: "jest",
        },
      })
    );

    const result = detectProjectFramework(dir);

    expect(result.framework).toBe("node");
    expect(result.hasTypecheck).toBe(true);
    expect(result.verifyCommands).toContain("npm run type-check");
    expect(result.testCommands).toContain("npm run test");
  });

  test("hasTypecheck is false when no typecheck/type-check script present", () => {
    const dir = createTempDir();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "no-tc", scripts: { build: "webpack" } })
    );

    const result = detectProjectFramework(dir);
    expect(result.framework).toBe("node");
    expect(result.hasTypecheck).toBe(false);
    expect(result.verifyCommands).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rust detection
// ---------------------------------------------------------------------------

describe("detectProjectFramework – Rust", () => {
  test("detects rust from Cargo.toml", () => {
    const dir = createTempDir();
    fs.writeFileSync(
      path.join(dir, "Cargo.toml"),
      "[package]\nname = \"my-crate\"\nversion = \"0.1.0\"\n"
    );

    const result = detectProjectFramework(dir);

    expect(result.framework).toBe("rust");
    expect(result.configFile).toBe("Cargo.toml");
    expect(result.verifyCommands).toContain("cargo check");
    expect(result.buildCommands).toContain("cargo build");
    expect(result.testCommands).toContain("cargo test");
    expect(result.hasTypecheck).toBe(false);
  });

  test("node takes priority over rust when both package.json and Cargo.toml exist", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "hybrid" }));
    fs.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\nname = \"hybrid\"\n");

    const result = detectProjectFramework(dir);
    expect(result.framework).toBe("node");
  });
});

// ---------------------------------------------------------------------------
// Python detection
// ---------------------------------------------------------------------------

describe("detectProjectFramework – Python", () => {
  test("detects python from pyproject.toml (no mypy/ruff → fallback verify)", () => {
    const dir = createTempDir();
    fs.writeFileSync(
      path.join(dir, "pyproject.toml"),
      "[build-system]\nrequires = [\"setuptools\"]\n"
    );

    const result = detectProjectFramework(dir);

    expect(result.framework).toBe("python");
    expect(result.configFile).toBe("pyproject.toml");
    expect(result.testCommands).toContain("pytest");
    expect(result.hasTypecheck).toBe(false);
    // Falls back to py_compile when no mypy/ruff config
    expect(result.verifyCommands[0]).toContain("py_compile");
  });

  test("detects ruff and mypy from pyproject.toml content", () => {
    const dir = createTempDir();
    fs.writeFileSync(
      path.join(dir, "pyproject.toml"),
      "[tool.ruff]\n[tool.mypy]\nstrict = true\n"
    );

    const result = detectProjectFramework(dir);

    expect(result.framework).toBe("python");
    expect(result.verifyCommands).toContain("ruff check .");
    expect(result.verifyCommands).toContain("mypy .");
    expect(result.hasTypecheck).toBe(true);
  });

  test("detects python from requirements.txt when no pyproject.toml", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "requirements.txt"), "flask\nrequests\n");

    const result = detectProjectFramework(dir);

    expect(result.framework).toBe("python");
    expect(result.configFile).toBe("requirements.txt");
  });
});

// ---------------------------------------------------------------------------
// Go detection
// ---------------------------------------------------------------------------

describe("detectProjectFramework – Go", () => {
  test("detects go from go.mod", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/myapp\n\ngo 1.21\n");

    const result = detectProjectFramework(dir);

    expect(result.framework).toBe("go");
    expect(result.configFile).toBe("go.mod");
    expect(result.verifyCommands).toContain("go vet ./...");
    expect(result.buildCommands).toContain("go build ./...");
    expect(result.testCommands).toContain("go test ./...");
  });
});

// ---------------------------------------------------------------------------
// Java detection
// ---------------------------------------------------------------------------

describe("detectProjectFramework – Java", () => {
  test("detects java/gradle from build.gradle", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "build.gradle"), "plugins { id 'java' }\n");

    const result = detectProjectFramework(dir);

    expect(result.framework).toBe("java");
    expect(result.configFile).toBe("build.gradle");
    expect(result.verifyCommands).toContain("./gradlew check");
    expect(result.testCommands).toContain("./gradlew test");
  });

  test("detects java/maven from pom.xml", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "pom.xml"), "<project></project>\n");

    const result = detectProjectFramework(dir);

    expect(result.framework).toBe("java");
    expect(result.configFile).toBe("pom.xml");
    expect(result.verifyCommands).toContain("mvn verify -q");
    expect(result.testCommands).toContain("mvn test -q");
  });
});

// ---------------------------------------------------------------------------
// Makefile detection
// ---------------------------------------------------------------------------

describe("detectProjectFramework – Make", () => {
  test("detects make from Makefile with test target", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "Makefile"), "all:\n\t@echo build\n\ntest:\n\t@echo test\n");

    const result = detectProjectFramework(dir);

    expect(result.framework).toBe("make");
    expect(result.configFile).toBe("Makefile");
    expect(result.verifyCommands).toContain("make");
    expect(result.testCommands).toContain("make test");
  });

  test("detects make from Makefile without test target → empty testCommands", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "Makefile"), "all:\n\t@echo build\n");

    const result = detectProjectFramework(dir);

    expect(result.framework).toBe("make");
    expect(result.testCommands).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// C# / .NET detection
// ---------------------------------------------------------------------------

describe("detectProjectFramework – C# / .NET", () => {
  test("detects dotnet from .csproj", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "App.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>\n");

    const result = detectProjectFramework(dir);

    expect(result.framework).toBe("dotnet");
    expect(result.configFile).toBe("App.csproj");
    expect(result.verifyCommands).toContain("dotnet build --no-restore");
    expect(result.testCommands).toContain("dotnet test");
  });

  test("detects dotnet from .sln", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "Solution.sln"), "Microsoft Visual Studio Solution File\n");

    const result = detectProjectFramework(dir);
    expect(result.framework).toBe("dotnet");
  });
});

// ---------------------------------------------------------------------------
// C / C++ detection
// ---------------------------------------------------------------------------

describe("detectProjectFramework – C / C++", () => {
  test("detects cpp from CMakeLists.txt", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)\n");

    const result = detectProjectFramework(dir);

    expect(result.framework).toBe("cpp");
    expect(result.configFile).toBe("CMakeLists.txt");
    expect(result.verifyCommands).toContain("cmake --build .");
    expect(result.testCommands).toContain("ctest");
  });
});

// ---------------------------------------------------------------------------
// PHP detection
// ---------------------------------------------------------------------------

describe("detectProjectFramework – PHP", () => {
  test("detects php from composer.json", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "composer.json"), JSON.stringify({ name: "app", require: { php: ">=8.1" } }));

    const result = detectProjectFramework(dir);

    expect(result.framework).toBe("php");
    expect(result.configFile).toBe("composer.json");
    expect(result.testCommands).toContain("vendor/bin/phpunit");
  });
});

// ---------------------------------------------------------------------------
// Kotlin detection
// ---------------------------------------------------------------------------

describe("detectProjectFramework – Kotlin", () => {
  test("detects kotlin from build.gradle.kts", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "build.gradle.kts"), "plugins { kotlin(\"jvm\") version \"1.9.0\" }\n");

    const result = detectProjectFramework(dir);

    expect(result.framework).toBe("kotlin");
    expect(result.configFile).toBe("build.gradle.kts");
    expect(result.verifyCommands).toContain("./gradlew compileKotlin");
    expect(result.testCommands).toContain("./gradlew test");
  });
});

// ---------------------------------------------------------------------------
// Swift detection
// ---------------------------------------------------------------------------

describe("detectProjectFramework – Swift", () => {
  test("detects swift from Package.swift", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "Package.swift"), "// swift-tools-version:5.9\n");

    const result = detectProjectFramework(dir);

    expect(result.framework).toBe("swift");
    expect(result.configFile).toBe("Package.swift");
    expect(result.verifyCommands).toContain("swift build");
    expect(result.testCommands).toContain("swift test");
  });
});

// ---------------------------------------------------------------------------
// Ruby detection
// ---------------------------------------------------------------------------

describe("detectProjectFramework – Ruby", () => {
  test("detects ruby from Gemfile", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "Gemfile"), "source 'https://rubygems.org'\n");

    const result = detectProjectFramework(dir);

    expect(result.framework).toBe("ruby");
    expect(result.configFile).toBe("Gemfile");
    expect(result.testCommands).toContain("bundle exec rspec");
  });
});

// ---------------------------------------------------------------------------
// Dart detection
// ---------------------------------------------------------------------------

describe("detectProjectFramework – Dart", () => {
  test("detects dart from pubspec.yaml", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "pubspec.yaml"), "name: my_app\nenvironment:\n  sdk: '>=3.0.0'\n");

    const result = detectProjectFramework(dir);

    expect(result.framework).toBe("dart");
    expect(result.configFile).toBe("pubspec.yaml");
    expect(result.verifyCommands).toContain("dart analyze");
    expect(result.testCommands).toContain("dart test");
  });
});

// ---------------------------------------------------------------------------
// Scala detection
// ---------------------------------------------------------------------------

describe("detectProjectFramework – Scala", () => {
  test("detects scala from build.sbt", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "build.sbt"), "name := \"my-app\"\n");

    const result = detectProjectFramework(dir);

    expect(result.framework).toBe("scala");
    expect(result.configFile).toBe("build.sbt");
    expect(result.testCommands).toContain("sbt test");
  });
});

// ---------------------------------------------------------------------------
// Multi-language monorepo (§7/§8/§36)
// ---------------------------------------------------------------------------

describe("Multi-language monorepo detection", () => {
  test("detectAllFrameworks finds every language in a monorepo", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "web", scripts: { test: "vitest" } }));
    fs.writeFileSync(path.join(dir, "pyproject.toml"), "[build-system]\n");
    fs.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\n");
    fs.writeFileSync(path.join(dir, "go.mod"), "module x\n");
    fs.writeFileSync(path.join(dir, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)\n");

    const results = detectAllFrameworks(dir);
    const frameworks = results.map((r) => r.framework);

    expect(frameworks).toContain("node");
    expect(frameworks).toContain("python");
    expect(frameworks).toContain("rust");
    expect(frameworks).toContain("go");
    expect(frameworks).toContain("cpp");
    // Sorted by confidence descending
    expect(results[0].confidence).toBeGreaterThanOrEqual(results[results.length - 1].confidence);
  });

  test("buildProjectContext exposes languages, primaryLanguage, frameworks, confidence", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fullstack", scripts: { test: "vitest" } }));
    fs.writeFileSync(path.join(dir, "pyproject.toml"), "[build-system]\n[tool.pytest.ini_options]\n");

    const ctx = buildProjectContext(dir, dir);

    expect(ctx.language).toContain("python");
    expect(ctx.language).toContain("typescript");
    expect(ctx.primaryLanguage).toBe("typescript"); // node detected first (highest confidence)
    expect(ctx.framework).toContain("node");
    expect(ctx.framework).toContain("python");
    expect(ctx.confidence).toBeGreaterThan(0.5);
    expect(ctx.testCommands).toContain("pytest");
  });

  test("single-language project gets primaryLanguage and confidence", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\nname = \"x\"\n");

    const ctx = buildProjectContext(dir, dir);

    expect(ctx.primaryLanguage).toBe("rust");
    expect(ctx.framework).toEqual(["rust"]);
    expect(ctx.confidence).toBeGreaterThan(0.5);
    expect(ctx.typecheckCommands).toContain("cargo check");
    expect(ctx.testCommands).toContain("cargo test");
  });

  test("empty project has zero confidence and no primary language", () => {
    const dir = createTempDir();
    const ctx = buildProjectContext(dir, dir);

    expect(ctx.primaryLanguage).toBeUndefined();
    expect(ctx.confidence).toBe(0);
    expect(ctx.language).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unknown
// ---------------------------------------------------------------------------

describe("detectProjectFramework – unknown", () => {
  test("returns unknown for empty directory", () => {
    const dir = createTempDir();

    const result = detectProjectFramework(dir);

    expect(result.framework).toBe("unknown");
    expect(result.verifyCommands).toHaveLength(0);
    expect(result.buildCommands).toHaveLength(0);
    expect(result.testCommands).toHaveLength(0);
    expect(result.configFile).toBe("");
    expect(result.hasTypecheck).toBe(false);
  });
});
