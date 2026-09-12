import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { runModelsCli } from "../modelsCli";
import { formatModelRef, providerRegistry, resetRoutingConfig, setRoutingConfig } from "../../core/models";

const TEST_PROVIDER = "phase79cli";
const ENV_VAR = "PHASE79_CLI_SECRET";
const SECRET = "SUPER_SECRET_MCP_123";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
  };
}

function registerFixture(): void {
  providerRegistry.register(
    {
      id: TEST_PROVIDER,
      name: "Phase 79 CLI Fixture",
      kind: "openai-compatible",
      baseURL: "https://fixture.invalid/v1",
      authentication: { apiKeyEnv: ENV_VAR, scheme: "bearer", hasApiKey: true },
      priority: 7,
      models: [
        {
          id: formatModelRef(TEST_PROVIDER, "tool-model"),
          providerId: TEST_PROVIDER,
          apiModelId: "tool-model",
          displayName: "Tool Model",
          contextWindow: 128_000,
          capabilities: { tools: true, nativeToolCalls: true, reasoning: true },
          pricing: { input: 3, output: 15, currency: "USD" },
          status: "active",
        },
        {
          id: formatModelRef(TEST_PROVIDER, "plain-model"),
          providerId: TEST_PROVIDER,
          apiModelId: "plain-model",
          capabilities: {},
          status: "active",
        },
      ],
    },
    { replace: true },
  );
}

registerFixture();

afterAll(() => {
  providerRegistry.unregister(TEST_PROVIDER);
  resetRoutingConfig();
});

afterEach(() => {
  resetRoutingConfig();
  delete process.env[ENV_VAR];
});

describe("Phase 79 — `toolnet providers`", () => {
  it("lists a registered provider with status, model count and key presence", async () => {
    const { io, stdout } = capture();
    const code = await runModelsCli(["providers"], { io });

    expect(code).toBe(0);
    expect(stdout()).toContain(TEST_PROVIDER);
    expect(stdout()).toContain("kind=openai-compatible");
    expect(stdout()).toContain("models=2");
    expect(stdout()).toContain(`auth=${ENV_VAR}:set`);
  });

  it("never prints the key value, only the env var name", async () => {
    process.env[ENV_VAR] = SECRET;
    const { io, stdout } = capture();
    await runModelsCli(["providers"], { io });

    expect(stdout()).toContain(ENV_VAR);
    expect(stdout()).not.toContain(SECRET);
  });

  it("emits machine-readable diagnostics", async () => {
    const { io, stdout } = capture();
    await runModelsCli(["providers", "--json"], { io });

    const parsed = JSON.parse(stdout()) as Array<{ id: string; modelCount: number; auth: { configured: boolean } | null }>;
    const entry = parsed.find((p) => p.id === TEST_PROVIDER);
    expect(entry?.modelCount).toBe(2);
    expect(entry?.auth?.configured).toBe(true);
    expect(stdout()).not.toContain(SECRET);
  });

  it("reports an unknown provider with a non-zero exit", async () => {
    const { io, stderr } = capture();
    const code = await runModelsCli(["providers", "no-such-provider"], { io });
    expect(code).toBe(1);
    expect(stderr()).toContain("no-such-provider");
  });
});

describe("Phase 79 — `toolnet models`", () => {
  it("lists catalog models with tri-state capability rendering", async () => {
    const { io, stdout } = capture();
    const code = await runModelsCli(["models", "--provider", TEST_PROVIDER], { io });

    expect(code).toBe(0);
    const output = stdout();
    // Declared capabilities only — unknown is never printed as supported.
    expect(output).toMatch(/tool-model\s+.*tools,nativeToolCalls,reasoning/);
    expect(output).toContain("128000");
    expect(output).toContain("plain-model");
  });

  it("emits tri-state capabilities as JSON so `unknown` stays distinguishable", async () => {
    const { io, stdout } = capture();
    await runModelsCli(["models", "--provider", TEST_PROVIDER, "--json"], { io });

    const parsed = JSON.parse(stdout()) as Array<{ model: string; capabilities: Record<string, boolean | undefined> }>;
    const tool = parsed.find((m) => m.model === "tool-model");
    const plain = parsed.find((m) => m.model === "plain-model");

    expect(tool?.capabilities.tools).toBe(true);
    expect(tool?.capabilities.nativeToolCalls).toBe(true);
    expect(plain?.capabilities.tools).toBeUndefined();
    expect(plain?.capabilities.reasoning).toBeUndefined();
  });
});

describe("Phase 79 — `toolnet model`", () => {
  it("prints the resolved reference, capabilities and pricing", async () => {
    const { io, stdout } = capture();
    const code = await runModelsCli(["model", `${TEST_PROVIDER}/tool-model`], { io });

    expect(code).toBe(0);
    const output = stdout();
    expect(output).toContain(`${TEST_PROVIDER}/tool-model`);
    expect(output).toContain("tools=yes");
    expect(output).toContain("nativeToolCalls=yes");
    expect(output).toContain("unknown");
    expect(output).toContain("USD");
  });

  it("reports an unresolvable reference without crashing", async () => {
    const { io, stderr } = capture();
    const code = await runModelsCli(["model", "ghost/nope"], { io });
    expect(code).toBe(1);
    expect(stderr()).toContain("Could not resolve");
  });
});

describe("Phase 79 — `toolnet routing`", () => {
  it("prints the active policy and fallback chain", async () => {
    setRoutingConfig({ policy: "cheapest", fallback: [], maxAttempts: 2 });
    const { io, stdout } = capture();
    const code = await runModelsCli(["routing"], { io });

    expect(code).toBe(0);
    expect(stdout()).toContain("Routing policy:     cheapest");
    expect(stdout()).toContain("Max attempts:       2");
  });

  it("emits routing config as JSON", async () => {
    setRoutingConfig({ policy: "fastest" });
    const { io, stdout } = capture();
    await runModelsCli(["routing", "--json"], { io });
    expect(JSON.parse(stdout()).policy).toBe("fastest");
  });
});

describe("Phase 79 — CLI surface", () => {
  it("prints usage for --help", async () => {
    const { io, stdout } = capture();
    const code = await runModelsCli(["providers", "--help"], { io });
    expect(code).toBe(0);
    expect(stdout()).toContain("toolnet providers");
    expect(stdout()).toContain("toolnet models refresh");
  });

  it("rejects an unknown subcommand", async () => {
    const { io, stderr } = capture();
    const code = await runModelsCli(["nonsense"], { io });
    expect(code).toBe(1);
    expect(stderr()).toContain("Unknown models subcommand");
  });
});
