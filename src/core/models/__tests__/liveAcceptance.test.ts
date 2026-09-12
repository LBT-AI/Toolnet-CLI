import { describe, expect, it } from "bun:test";
import { ModelCatalog } from "../catalog";
import { ProviderRegistry } from "../registry";
import { classifyLiveFailure, runLiveAcceptance } from "../liveAcceptance";

const HAS_KEY = Boolean(process.env.OPENROUTER_API_KEY?.trim());

describe("Phase 79 — live acceptance classification", () => {
  it("classifies a missing credential as an environment limitation", () => {
    expect(classifyLiveFailure(new Error("HTTP 401: unauthorized"))).toBe("ENVIRONMENT");
    expect(classifyLiveFailure(new Error("missing OPENROUTER_API_KEY"))).toBe("ENVIRONMENT");
  });

  it("classifies a provider-side rejection as a protocol problem", () => {
    expect(classifyLiveFailure(new Error("HTTP 400: invalid model"))).toBe("PROVIDER_PROTOCOL");
    expect(classifyLiveFailure(new Error("HTTP 503: upstream down"))).toBe("PROVIDER_PROTOCOL");
    expect(classifyLiveFailure(new Error("fetch failed"))).toBe("PROVIDER_PROTOCOL");
  });

  it("reserves CORE_RUNTIME for unexpected internal failures", () => {
    expect(classifyLiveFailure(new Error("cannot read properties of undefined"))).toBe("CORE_RUNTIME");
  });
});

describe("Phase 79 — live acceptance without credentials", () => {
  it("reports skipped rather than a fake pass", async () => {
    const registry = new ProviderRegistry(new ModelCatalog());
    const catalog = new ModelCatalog();

    const report = await runLiveAcceptance({ registry, catalog, env: {} });
    expect(report.ran).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.failureClass).toBe("ENVIRONMENT");
    expect(report.error).toContain("not set");
  });
});

/**
 * The credentialed probe. When OPENROUTER_API_KEY is absent these are reported
 * as skipped — an environment limitation, never a pass. The probe performs
 * discovery only (a public read) and never issues a billed completion.
 */
const liveIt = HAS_KEY ? it : it.skip;

describe("Phase 79 — live OpenRouter acceptance", () => {
  liveIt(
    "discovers models, normalizes capabilities and binds the ModelAdapter path",
    async () => {
      const registry = new ProviderRegistry(new ModelCatalog());
      const catalog = new ModelCatalog();

      const report = await runLiveAcceptance({ registry, catalog, timeoutMs: 20_000 });

      if (!report.ok) {
        // Fail loudly with the classification instead of a vague assertion.
        throw new Error(`live acceptance failed [${report.failureClass}]: ${report.error}`);
      }

      expect(report.modelCount).toBeGreaterThan(0);
      expect(report.sampleModel).toBeString();
      expect(report.adapterBound).toBe(true);
      expect(report.steps).toContain("provider registered");
      expect(report.steps.some((step) => step.startsWith("router resolved"))).toBe(true);
    },
    30_000,
  );
});
