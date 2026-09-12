import { afterAll, describe, expect, it } from "bun:test";
import { catalogCommand, parseCatalogArgs, renderCatalogLines } from "../catalog";
import { providerRegistry } from "../../core/models/registry";
import { formatModelRef } from "../../core/models/ref";
import type { CommandContext } from "../index";

const PROVIDER = "phase80catalog";

providerRegistry.register(
  {
    id: PROVIDER,
    name: "Phase 80 Catalog",
    kind: "openai-compatible",
    baseURL: "https://catalog.invalid/v1",
    models: [
      {
        id: formatModelRef(PROVIDER, "tool-model"),
        providerId: PROVIDER,
        apiModelId: "tool-model",
        capabilities: { tools: true, reasoning: true },
        contextWindow: 200_000,
        pricing: { input: 3, output: 15 },
        status: "active",
      },
      {
        id: formatModelRef(PROVIDER, "plain-model"),
        providerId: PROVIDER,
        apiModelId: "plain-model",
        capabilities: {},
        status: "active",
      },
    ],
  },
  { replace: true },
);

afterAll(() => {
  providerRegistry.unregister(PROVIDER);
});

function context(messages: string[]): CommandContext {
  return {
    addMessage: (_role, content) => messages.push(content),
    setModel: () => {},
    setStatusMsg: () => {},
    exit: () => {},
    currentModel: () => "",
  };
}

describe("Phase 80 — `/catalog`", () => {
  it("parses filters, capability validation and a selection target", () => {
    expect(parseCatalogArgs(["--provider", "openrouter", "--capability", "tools"])).toEqual({
      filter: { provider: "openrouter", capability: "tools" },
    });
    expect(parseCatalogArgs(["--free"])).toEqual({ filter: { pricing: "free" } });
    expect(parseCatalogArgs(["--paid"])).toEqual({ filter: { pricing: "paid" } });
    expect(parseCatalogArgs(["search text"])).toEqual({ filter: { search: "search text" } });
    expect(parseCatalogArgs(["--use", "openrouter/x"])).toEqual({ filter: {}, use: "openrouter/x" });

    const bad = parseCatalogArgs(["--capability", "nope"]);
    expect(bad.error).toContain("Unknown capability");
  });

  it("renders a table with tri-state capabilities and health", () => {
    const lines = renderCatalogLines({ filter: { provider: PROVIDER } }).join("\n");
    expect(lines).toContain("Model catalog");
    expect(lines).toContain("tool-model");
    expect(lines).toContain("PROVIDER");
    expect(lines).toContain("CONTEXT");
    expect(lines).toContain("PRICE");
    expect(lines).toContain("HEALTH");
    // Unknown capabilities must never render as yes.
    expect(lines).toContain("unknown");
  });

  it("reports an empty catalog distinctly from a filtered-out result", () => {
    const filtered = renderCatalogLines({ filter: { provider: PROVIDER, search: "nomatch" } }).join("\n");
    expect(filtered).toContain("No model matches the current filters");
  });

  it("prints the table into the conversation and never mutates state itself", async () => {
    const messages: string[] = [];
    await catalogCommand.handler(["--provider", PROVIDER], context(messages));
    expect(messages.join("\n")).toContain("tool-model");
  });

  it("delegates selection to the shared setModel path", async () => {
    const messages: string[] = [];
    const selected: string[] = [];
    const ctx = { ...context(messages), setModel: (model: string) => selected.push(model) };

    await catalogCommand.handler(["--use", "openrouter/some-model"], ctx);
    expect(selected).toEqual(["openrouter/some-model"]);
    expect(messages.join("\n")).toContain("Model set to");
  });

  it("surfaces a capability parse error instead of rendering", async () => {
    const messages: string[] = [];
    await catalogCommand.handler(["--capability", "nope"], context(messages));
    expect(messages.join("\n")).toContain("Unknown capability");
  });
});
