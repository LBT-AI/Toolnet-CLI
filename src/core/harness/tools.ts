/**
 * Phase 81 §7 — tool policy.
 *
 * This module decides which of the ALREADY-REGISTERED tools the model is
 * offered, and in what order. It cannot decide permission.
 *
 * The invariant that makes that true: filtering happens before the request,
 * while every executed call still passes through
 * `securityEngine.evaluate` → ToolGateway. A profile can therefore only shrink
 * the exposed set. There is no code path here that can widen it, and the
 * harness never consults a policy when evaluating a permission decision.
 *
 * The module is deliberately free of registry, gateway and provider imports: a
 * structural `{ function: { name } }` is all it needs, which is also what the
 * architecture guard test asserts.
 */

import type { ToolPolicy } from "./types";

interface NamedToolSchema {
  function: { name: string };
}

/** Names the profile exposes, in registry order. */
export function exposedToolNames(
  allNames: string[],
  policy: ToolPolicy,
): string[] {
  let names = allNames;

  if (policy.allow) {
    const allowed = new Set(policy.allow);
    names = names.filter((name) => allowed.has(name));
  }

  if (policy.deny?.length) {
    const denied = new Set(policy.deny);
    names = names.filter((name) => !denied.has(name));
  }

  return orderByPreference(names, policy.prefer);
}

/**
 * Stable ordering hint: preferred tools first in the stated order, everything
 * else keeps its registry position. Ordering never removes a tool.
 */
export function orderByPreference(names: string[], prefer?: string[]): string[] {
  if (!prefer?.length) return [...names];
  const priority = new Map<string, number>();
  prefer.forEach((name, index) => priority.set(name, index));
  return [...names].sort((a, b) => {
    const pa = priority.has(a) ? priority.get(a)! : Number.MAX_SAFE_INTEGER;
    const pb = priority.has(b) ? priority.get(b)! : Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });
}

/** Whether a tool name is exposed by this policy. */
export function isToolExposed(name: string, policy: ToolPolicy): boolean {
  if (policy.allow && !policy.allow.includes(name)) return false;
  if (policy.deny?.includes(name)) return false;
  return true;
}

/** Apply the ordering policy to provider tool schemas. */
export function applyToolOrdering<T extends NamedToolSchema>(
  schemas: T[],
  policy: ToolPolicy,
): T[] {
  if (!policy.prefer?.length) return schemas;
  const order = new Map<string, number>();
  orderByPreference(
    schemas.map((schema) => schema.function.name),
    policy.prefer,
  ).forEach((name, index) => order.set(name, index));
  return [...schemas].sort(
    (a, b) =>
      (order.get(a.function.name) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(b.function.name) ?? Number.MAX_SAFE_INTEGER),
  );
}

/** Extra tool-use instruction from the profile, if any. */
export function toolGuidance(policy: ToolPolicy): string | undefined {
  const guidance = policy.guidance?.trim();
  return guidance ? guidance : undefined;
}

/**
 * True when a policy is a pure pass-through (no allow/deny/prefer/guidance).
 * The harness uses this to skip building a filtered schema list entirely for
 * the identity profile.
 */
export function isPassthroughToolPolicy(policy: ToolPolicy): boolean {
  return (
    policy.allow === undefined &&
    !policy.deny?.length &&
    !policy.prefer?.length &&
    !policy.guidance?.trim()
  );
}
