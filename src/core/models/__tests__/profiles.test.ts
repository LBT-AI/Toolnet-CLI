import { describe, expect, it } from "bun:test";
import {
  DEFAULT_ROUTING_PROFILE,
  ROUTING_PROFILES,
  ROUTING_PROFILE_NAMES,
  describeProfile,
  isRoutingProfileName,
  resolveRoutingProfile,
} from "../profiles";

describe("Phase 80 — Routing profiles", () => {
  it("defines every documented profile", () => {
    expect(ROUTING_PROFILE_NAMES).toEqual([
      "auto",
      "quality",
      "balanced",
      "fast",
      "cheap",
      "coding",
      "reasoning",
      "tool-heavy",
      "long-context",
    ]);
    for (const name of ROUTING_PROFILE_NAMES) {
      expect(ROUTING_PROFILES[name].id).toBe(name);
    }
  });

  it("keeps `auto` on the Phase 79 priority ordering", () => {
    const auto = ROUTING_PROFILES.auto;
    expect(DEFAULT_ROUTING_PROFILE).toBe("auto");
    expect(auto.ranking).toBe("policy");
    expect(auto.policy).toBe("priority");
  });

  it("maps fast/cheap to the dedicated deterministic policies", () => {
    expect(ROUTING_PROFILES.fast.policy).toBe("fastest");
    expect(ROUTING_PROFILES.cheap.policy).toBe("cheapest");
    // Latency must dominate the fast profile, cost the cheap profile.
    expect(ROUTING_PROFILES.fast.weights.latency).toBeGreaterThan(ROUTING_PROFILES.fast.weights.cost);
    expect(ROUTING_PROFILES.cheap.weights.cost).toBeGreaterThan(ROUTING_PROFILES.cheap.weights.latency);
  });

  it("never binds a profile to a concrete model", () => {
    const serialized = JSON.stringify(ROUTING_PROFILES).toLowerCase();
    for (const forbidden of ["claude", "gpt-", "gemini", "llama", "mistral"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("requires tools for coding and tool-heavy profiles", () => {
    expect(ROUTING_PROFILES.coding.requiredCapabilities?.tools).toBe(true);
    expect(ROUTING_PROFILES["tool-heavy"].requiredCapabilities?.tools).toBe(true);
    expect(ROUTING_PROFILES.reasoning.requiredCapabilities?.reasoning).toBe(true);
  });

  it("resolves unknown profile names back to auto instead of throwing", () => {
    expect(resolveRoutingProfile("nope").id).toBe("auto");
    expect(resolveRoutingProfile(undefined).id).toBe("auto");
    expect(resolveRoutingProfile("CODING").id).toBe("coding");
  });

  it("recognizes profile names case-insensitively", () => {
    expect(isRoutingProfileName("Quality")).toBe(true);
    expect(isRoutingProfileName("nope")).toBe(false);
  });

  it("describes a profile with its active weights", () => {
    const description = describeProfile(ROUTING_PROFILES.coding);
    expect(description).toContain("coding:");
    expect(description).toContain("ranking=score");
    expect(description).toContain("capability=");
  });

  it("gives every scoring profile at least one positive weight", () => {
    for (const name of ROUTING_PROFILE_NAMES) {
      const profile = ROUTING_PROFILES[name];
      const total = Object.values(profile.weights).reduce((sum, value) => sum + value, 0);
      expect(total).toBeGreaterThan(0);
    }
  });
});
