import { test, expect, describe, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { detectProjectFramework } from "../../lib/projectDetector";

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
