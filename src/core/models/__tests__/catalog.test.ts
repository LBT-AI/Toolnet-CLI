import { beforeEach, describe, expect, it } from "bun:test";
import { ModelCatalog } from "../catalog";
import { formatModelRef } from "../ref";
import type { ModelDefinition } from "../types";

function model(providerId: string, apiModelId: string, extra: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: formatModelRef(providerId, apiModelId),
    providerId,
    apiModelId,
    capabilities: {},
    status: "active",
    ...extra,
  };
}

describe("Phase 79 — ModelCatalog", () => {
  let catalog: ModelCatalog;

  beforeEach(() => {
    catalog = new ModelCatalog();
  });

  it("adds and reads a model by canonical id", () => {
    catalog.add(model("openrouter", "anthropic/claude-sonnet"));
    expect(catalog.size()).toBe(1);
    expect(catalog.get("openrouter/anthropic/claude-sonnet")?.apiModelId).toBe("anthropic/claude-sonnet");
  });

  it("never collides on slash-containing model ids", () => {
    catalog.add(model("openrouter", "anthropic/claude-sonnet"));
    catalog.add(model("openrouter", "openai/gpt-4o"));
    catalog.add(model("toolnet", "openai/gpt-4o"));
    expect(catalog.size()).toBe(3);
    expect(catalog.get("openrouter/openai/gpt-4o")?.providerId).toBe("openrouter");
    expect(catalog.get("toolnet/openai/gpt-4o")?.providerId).toBe("toolnet");
  });

  it("replaces (not duplicates) a model with the same canonical id", () => {
    catalog.add(model("toolnet", "alims-intl.llm", { displayName: "first" }));
    catalog.add(model("toolnet", "alims-intl.llm", { displayName: "second" }));
    expect(catalog.size()).toBe(1);
    expect(catalog.get("toolnet/alims-intl.llm")?.displayName).toBe("second");
  });

  it("isolates providers", () => {
    catalog.add(model("a", "m1"));
    catalog.add(model("a", "m2"));
    catalog.add(model("b", "m1"));

    expect(catalog.listByProvider("a").map((m) => m.apiModelId).sort()).toEqual(["m1", "m2"]);
    expect(catalog.listByProvider("b").map((m) => m.apiModelId)).toEqual(["m1"]);

    catalog.removeProvider("a");
    expect(catalog.listByProvider("a")).toEqual([]);
    expect(catalog.listByProvider("b").map((m) => m.apiModelId)).toEqual(["m1"]);
    expect(catalog.size()).toBe(1);
  });

  it("atomically replaces a provider's model set", () => {
    catalog.replaceProviderModels("a", [model("a", "m1"), model("a", "m2")]);
    expect(catalog.listByProvider("a").map((m) => m.apiModelId).sort()).toEqual(["m1", "m2"]);

    catalog.replaceProviderModels("a", [model("a", "m3")]);
    expect(catalog.listByProvider("a").map((m) => m.apiModelId)).toEqual(["m3"]);
    expect(catalog.get("a/m1")).toBeUndefined();
  });

  it("removes a single model", () => {
    catalog.add(model("a", "m1"));
    catalog.add(model("a", "m2"));
    expect(catalog.remove("a/m1")).toBe(true);
    expect(catalog.remove("a/m1")).toBe(false);
    expect(catalog.listByProvider("a").map((m) => m.apiModelId)).toEqual(["m2"]);
  });

  it("emits change events and survives a throwing listener", () => {
    const seen: string[] = [];
    catalog.onChange((change) => {
      seen.push(change.type);
      throw new Error("listener exploded");
    });
    catalog.onChange((change) => {
      seen.push(`${change.type}:${change.modelIds.length}`);
    });

    catalog.add(model("a", "m1"));
    catalog.remove("a/m1");
    expect(seen).toContain("added");
    expect(seen).toContain("added:1");
    expect(seen).toContain("removed:1");
  });

  it("snapshots a provider for rollback without sharing references", () => {
    catalog.add(model("a", "m1", { capabilities: { tools: true } }));
    const snapshot = catalog.snapshotProvider("a");
    snapshot[0].capabilities.tools = false;
    expect(catalog.get("a/m1")?.capabilities.tools).toBe(true);
  });
});
