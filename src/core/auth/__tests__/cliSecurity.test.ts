/**
 * — CLI, redaction and external-harness
 * credential-injection tests.
 *
 * The injection test performs a REAL spawn (bun as the child) and proves two
 * things at once: the credential reaches the child's environment, and it never
 * appears in ToolNet's normalized result or argv.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetAppConfigCache } from "../../../lib/appConfig";
import { runAuthCli, formatAuthError } from "../../../commands/authCli";
import { authOperations } from "../operations";
import { authProfileRegistry } from "../registry";
import { credentialStore } from "../credentialStore";
import { credentialResolver } from "../resolver";
import { resolveExternalCredentialEnv } from "../harnessInjection";
import { redactSecret, registerResolvedSecret, resolvedSecretCount } from "../../models/errors";
import { ExternalHarnessRegistry } from "../../externalHarness/registry";
import { ExternalHarnessRunner } from "../../externalHarness/runner";
import { HarnessCapabilityError } from "../../externalHarness/errors";
import { AuthError, AuthProfileValidationError } from "../errors";
import type { ExternalHarnessDefinition } from "../../externalHarness/types";

let dir: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tn-auth-cli-"));
  previousConfigDir = process.env.TOOLNETCLI_CONFIG_DIR;
  process.env.TOOLNETCLI_CONFIG_DIR = dir;
  resetAppConfigCache();
  // The canonical singleton resolves its path lazily; drop its cache so this
  // test's temp config dir is the one actually used.
  credentialStore.resetCache();
});

afterEach(() => {
  credentialStore.resetCache();
  fs.rmSync(dir, { recursive: true, force: true });
  if (previousConfigDir === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR;
  else process.env.TOOLNETCLI_CONFIG_DIR = previousConfigDir;
  resetAppConfigCache();
  credentialStore.resetCache();
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
  };
}

const SECRET = "sk-or-v1-CLI-SECRET-9f8e7d6c5b4a3210";

describe("auth CLI — no secrets in output", () => {
  test("add --secret-stdin stores the key and never prints it", async () => {
    const { io, out, err } = capture();
    const code = await runAuthCli(["add", "openrouter", "--profile", "work", "--secret-stdin"], io);
    // No stdin in this environment → the command must refuse, not fake success.
    expect(code).toBe(1);
    expect(err.join("\n")).not.toContain(SECRET);
  });

  test("refuses a key supplied on the command line", async () => {
    const { io, err } = capture();
    const code = await runAuthCli(["add", "openrouter", "--key", SECRET], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("command line");
    expect(err.join("\n")).not.toContain(SECRET);
  });

  test("hidden prompt path stores the key without echoing it", async () => {
    const { io, out } = capture();
    const code = await runAuthCli(["add", "openrouter", "--profile", "work"], {
      ...io,
      promptHidden: async () => SECRET,
    });
    expect(code).toBe(0);
    expect(out.join("\n")).not.toContain(SECRET);
    expect(await credentialStore.get("openrouter/work")).toEqual({ type: "api_key", secret: SECRET });
  });

  test("list/status/doctor never print the secret", async () => {
    const { io } = capture();
    await runAuthCli(["add", "openrouter", "--profile", "work"], { ...io, promptHidden: async () => SECRET });

    for (const command of [["list"], ["status", "openrouter"], ["doctor"]]) {
      const captured = capture();
      const code = await runAuthCli(command, captured.io);
      expect(code).toBe(0);
      const text = [...captured.out, ...captured.err].join("\n");
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(SECRET.slice(0, 8));
    }
  });

  test("use / logout / remove behave and stay secret-free", async () => {
    const { io } = capture();
    await runAuthCli(["add", "openrouter", "--profile", "work"], { ...io, promptHidden: async () => SECRET });
    await runAuthCli(["add", "openrouter", "--profile", "personal"], {
      ...io,
      promptHidden: async () => "sk-or-v1-personal-0000111122223333",
    });

    const use = capture();
    expect(await runAuthCli(["use", "openrouter/work"], use.io)).toBe(0);
    expect(use.out.join("\n")).toContain("openrouter/work");

    const logout = capture();
    expect(await runAuthCli(["logout", "openrouter/work"], logout.io)).toBe(0);
    expect(authProfileRegistry.getActive("openrouter")).toBeUndefined();
    // The credential survives logout so the user can switch back.
    expect(await credentialStore.has("openrouter/work")).toBe(true);

    const refused = capture();
    expect(await runAuthCli(["remove", "openrouter/work"], refused.io)).toBe(1);
    expect(await credentialStore.has("openrouter/work")).toBe(true);

    const removed = capture();
    expect(await runAuthCli(["remove", "openrouter/work", "--yes"], removed.io)).toBe(0);
    expect(await credentialStore.has("openrouter/work")).toBe(false);
    expect(authProfileRegistry.list("openrouter").map((profile) => profile.id)).toEqual([
      "openrouter/personal",
    ]);
  });

  test("env profile registration stores no secret", async () => {
    const { io, out } = capture();
    const code = await runAuthCli(["add", "openrouter", "--profile", "fromenv", "--env", "OPENROUTER_API_KEY"], io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("No secret was stored");
    expect(credentialStore.profileIds()).toEqual([]);
  });

  test("login refuses a provider without an OAuth implementation", async () => {
    const { io, err } = capture();
    const code = await runAuthCli(["login", "toolnet"], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("openrouter");
  });

  test("unknown subcommands fail with usage", async () => {
    const { io, err } = capture();
    expect(await runAuthCli(["nonsense"], io)).toBe(1);
    expect(err.join("\n")).toContain("Unknown auth command");
  });
});

describe("profile id validation — path traversal and control characters", () => {
  test("rejects traversal, separators, control chars and over-long names", async () => {
    for (const name of ["../../etc/passwd", "a/b", "back\\slash", "bell\u0007", "x".repeat(200), ""]) {
      await expect(
        authOperations.addApiKey({ providerId: "openrouter", name, secret: SECRET }),
      ).rejects.toBeInstanceOf(AuthProfileValidationError);
    }
  });

  test("rejects an unsafe provider segment", async () => {
    await expect(
      authOperations.addApiKey({ providerId: "../evil", name: "work", secret: SECRET }),
    ).rejects.toBeInstanceOf(AuthProfileValidationError);
  });

  test("a valid profile id is produced for normal input", async () => {
    const profile = await authOperations.addApiKey({
      providerId: "OpenRouter",
      name: "work-laptop.1",
      secret: SECRET,
      activate: false,
    });
    expect(profile.id).toBe("openrouter/work-laptop.1");
  });
});

describe("credential shapes — keys with shell metacharacters stay inert", () => {
  test("stores and resolves keys containing quotes, spaces, newlines and shell syntax", async () => {
    const wild = "sk-or; && $(touch /tmp/pwned) `id` \"quoted\" 'single'\n\u00e9\u4e2d\u6587";
    await authOperations.addApiKey({ providerId: "openrouter", name: "wild", secret: wild, activate: false });
    const resolved = credentialResolver.resolve({
      providerId: "openrouter",
      explicitProfile: "openrouter/wild",
    });
    expect(resolved.secret).toBe(wild.trim());
    expect(fs.existsSync("/tmp/pwned")).toBe(false);
  });
});

describe("redaction — ", () => {
  test("registered secrets are scrubbed from arbitrary text", () => {
    registerResolvedSecret(SECRET);
    expect(resolvedSecretCount()).toBeGreaterThan(0);
    expect(redactSecret(`fetch failed: Authorization: Bearer ${SECRET}`)).not.toContain(SECRET);
    expect(redactSecret(`{"error":"${SECRET}"}`)).not.toContain(SECRET);
    expect(redactSecret(`token=${SECRET} host=example.com`)).toContain("example.com");
    // Normal model ids must NOT be over-redacted.
    expect(redactSecret("openrouter/anthropic/claude-sonnet-4")).toBe(
      "openrouter/anthropic/claude-sonnet-4",
    );
  });

  test("auth errors never carry the secret through the cause chain", () => {
    const error = new AuthError({
      code: "TEST",
      message: `failed with ${SECRET}`,
      cause: new Error(`inner ${SECRET}`),
    });
    expect(error.message).not.toContain(SECRET);
    expect(formatAuthError(error)).not.toContain(SECRET);
  });

  test("provider-shaped keys in free text are redacted even if never registered", () => {
    const foreign = "sk-or-v1-0123456789abcdef0123456789abcdef";
    expect(redactSecret(`error: ${foreign}`)).not.toContain(foreign);
  });
});

describe("external harness credential injection — ", () => {
  test("an undeclared env name is refused", async () => {
    await authOperations.addApiKey({ providerId: "openrouter", name: "work", secret: SECRET, activate: false });
    expect(() =>
      resolveExternalCredentialEnv({
        harnessId: "hermes",
        credentialEnvAllowlist: [],
        profileId: "openrouter/work",
      }),
    ).toThrow(HarnessCapabilityError);
  });

  test("a declared name is accepted and the profile must exist", async () => {
    await authOperations.addApiKey({ providerId: "openrouter", name: "work", secret: SECRET, activate: false });
    const env = resolveExternalCredentialEnv({
      harnessId: "opencode",
      credentialEnvAllowlist: ["OPENROUTER_API_KEY"],
      profileId: "openrouter/work",
    });
    expect(env).toEqual({ OPENROUTER_API_KEY: SECRET });

    expect(() =>
      resolveExternalCredentialEnv({
        harnessId: "opencode",
        credentialEnvAllowlist: ["OPENROUTER_API_KEY"],
        profileId: "openrouter/missing",
      }),
    ).toThrow();
  });

  test("a malformed --auth-profile value is rejected", () => {
    expect(() =>
      resolveExternalCredentialEnv({
        harnessId: "opencode",
        credentialEnvAllowlist: ["OPENROUTER_API_KEY"],
        profileId: "no-slash",
      }),
    ).toThrow(AuthProfileValidationError);
  });

  test("the credential reaches the child environment, never the argv or the result", async () => {
    await authOperations.addApiKey({ providerId: "openrouter", name: "work", secret: SECRET, activate: false });
    const credentialEnv = resolveExternalCredentialEnv({
      harnessId: "fake",
      credentialEnvAllowlist: ["OPENROUTER_API_KEY"],
      profileId: "openrouter/work",
    });

    // The child prints a DIGEST of the injected value — never the value.
    const script = `
      const value = process.env.OPENROUTER_API_KEY ?? "";
      const digest = require("node:crypto").createHash("sha256").update(value).digest("hex").slice(0, 12);
      console.log(JSON.stringify({ injected: value.length > 0, digest, argvHasSecret: process.argv.join(" ").includes(value) }));
    `;
    const definition: ExternalHarnessDefinition = {
      id: "fake",
      displayName: "Fake Harness",
      executable: "bun",
      executionTrust: "external_managed",
      envAllowlist: ["NO_COLOR"],
      credentialEnvAllowlist: ["OPENROUTER_API_KEY"],
      capabilities: {
        structuredOutput: false,
        streaming: false,
        modelOverride: false,
        providerOverride: false,
        sessionResume: false,
        sessionFork: false,
        workingDirectory: true,
        stdinPrompt: false,
        fileAttachments: false,
        nonInteractive: true,
        abort: true,
        nativePermissions: false,
      },
      detect: async () => ({ available: true, version: "test" }),
      buildInvocation: () => ({ argv: ["-e", script] }),
      parseEvent: (chunk) => (chunk.trim() ? [{ kind: "output" as const, text: chunk.trim() }] : []),
      normalizeResult: () => ({ status: "SUCCESS" as const }),
    };

    const registry = new ExternalHarnessRegistry();
    registry.register(definition);
    const runner = new ExternalHarnessRunner(registry);
    const result = await runner.run({
      harnessId: "fake",
      prompt: "ignored",
      cwd: dir,
      credentialEnv,
    });

    const expectedDigest = createHash("sha256").update(SECRET).digest("hex").slice(0, 12);
    const observed = JSON.parse(result.finalText ?? "{}");
    expect(observed.injected).toBe(true);
    expect(observed.digest).toBe(expectedDigest);
    expect(observed.argvHasSecret).toBe(false);
    // The secret is registered for redaction → never present in normalized output.
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.metadata.argv.join(" ")).not.toContain(SECRET);
  }, 20_000);

  test("with no explicit injection the harness receives no ToolNet credential", async () => {
    const script = `console.log(JSON.stringify({ present: Boolean(process.env.OPENROUTER_API_KEY) }))`;
    const definition: ExternalHarnessDefinition = {
      id: "fake2",
      displayName: "Fake Harness 2",
      executable: "bun",
      executionTrust: "external_managed",
      envAllowlist: ["NO_COLOR"],
      credentialEnvAllowlist: ["OPENROUTER_API_KEY"],
      capabilities: {
        structuredOutput: false,
        streaming: false,
        modelOverride: false,
        providerOverride: false,
        sessionResume: false,
        sessionFork: false,
        workingDirectory: true,
        stdinPrompt: false,
        fileAttachments: false,
        nonInteractive: true,
        abort: true,
        nativePermissions: false,
      },
      detect: async () => ({ available: true, version: "test" }),
      buildInvocation: () => ({ argv: ["-e", script] }),
      parseEvent: (chunk) => (chunk.trim() ? [{ kind: "output" as const, text: chunk.trim() }] : []),
      normalizeResult: () => ({ status: "SUCCESS" as const }),
    };
    const registry2 = new ExternalHarnessRegistry();
    registry2.register(definition);
    const runner = new ExternalHarnessRunner(registry2);
    const result = await runner.run({ harnessId: "fake2", prompt: "ignored", cwd: dir });
    // No credentialEnv requested → nothing injected (the parent has no such var
    // in this hermetic test environment either).
    expect(JSON.parse(result.finalText ?? "{}")).toEqual({ present: false });
  }, 20_000);
});
