import { afterEach, describe, expect, it } from "bun:test";
import { ROUTING_EVAL_CASES, runRoutingEval } from "../routingEval";
import { getRoutingConfig, resetRoutingConfig } from "../../models/router";

afterEach(() => {
  resetRoutingConfig();
});

describe("Phase 82 §14 — deterministic routing eval", () => {
  it("has a non-trivial case set with unique ids", () => {
    expect(ROUTING_EVAL_CASES.length).toBeGreaterThanOrEqual(18);
    const ids = ROUTING_EVAL_CASES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("passes every built-in case", () => {
    const report = runRoutingEval();
    const failures = report.results.filter((result) => !result.passed);
    expect(failures.map((entry) => `${entry.id}: ${entry.detail}`)).toEqual([]);
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(ROUTING_EVAL_CASES.length);
  });

  it("is deterministic: two runs produce identical decisions", () => {
    const first = runRoutingEval();
    const second = runRoutingEval();
    expect(second.results.map((r) => `${r.id}:${r.selectedRouteId ?? ""}`)).toEqual(
      first.results.map((r) => `${r.id}:${r.selectedRouteId ?? ""}`),
    );
  });

  it("never mutates the process-wide routing config", () => {
    const before = getRoutingConfig();
    runRoutingEval();
    expect(getRoutingConfig()).toEqual(before);
  });

  it("does not touch the live catalog or provider registry", () => {
    const { modelCatalog, providerRegistry } = require("../../models") as typeof import("../../models");
    const modelsBefore = modelCatalog.size();
    const providersBefore = providerRegistry.ids().slice().sort();
    runRoutingEval();
    expect(modelCatalog.size()).toBe(modelsBefore);
    expect(providerRegistry.ids().slice().sort()).toEqual(providersBefore);
  });

  it("reports per-case evidence, not just a boolean", () => {
    const report = runRoutingEval();
    for (const result of report.results) {
      expect(result.detail.length).toBeGreaterThan(0);
      expect(Array.isArray(result.rejected)).toBe(true);
    }
    // The healthy/unhealthy case must record the unavailable rejection.
    const healthy = report.results.find((result) => result.id === "healthy-beats-unhealthy")!;
    expect(healthy.selectedRouteId).toContain("aaa-provider");
    expect(healthy.rejected.join(",")).toContain("provider-unavailable");
  });
});
