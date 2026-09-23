/**
 * `toolnet context` — model-visible context inspection and manual compaction.
 *
 * Formatting only. Budgeting, planning and compaction all run through the
 * canonical context manager, and the durable compaction record is written by it
 * through the session store; this file never reaches into session files, never
 * calls a provider and never mutates a transcript directly.
 *
 * `status` and `explain` are read-only and local: they estimate, they do not
 * send anything. `compact` performs a real bounded compaction, and if nothing
 * can be usefully reduced it is a no-op that says why rather than a fabricated
 * success.
 */

import { sessionStore } from "../core/session";
import { contextManager, type EstimatableMessage } from "../core/context";
import { contextEngine } from "../lib/context";

export interface ContextCliIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIO: ContextCliIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

interface Transcript {
  messages: EstimatableMessage[];
  model?: string;
  sessionId?: string;
}

/** Session transcript, narrowed to what estimation needs. */
function transcriptOf(sessionId: string | null): Transcript | { error: string } {
  if (!sessionId) return { messages: [] };
  const record = sessionStore.load(sessionId);
  if (!record) return { error: `session not found: ${sessionId}` };
  return {
    messages: record.messages as unknown as EstimatableMessage[],
    ...(record.model ? { model: record.model } : {}),
    sessionId: record.id,
  };
}

function pickSessionId(args: string[]): string | null {
  const index = args.indexOf("--session");
  if (index !== -1 && args[index + 1]) return args[index + 1];
  return sessionStore.lastSessionId();
}

function pickModel(args: string[], fallback?: string): string | undefined {
  const index = args.indexOf("--model");
  if (index !== -1 && args[index + 1]) return args[index + 1];
  return fallback;
}

function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round(((part / whole) * 100 + Number.EPSILON) * 10) / 10;
}

async function cmdStatus(io: ContextCliIO, args: string[]): Promise<number> {
  const json = args.includes("--json");
  const sessionId = pickSessionId(args);
  const resolved = transcriptOf(sessionId);
  if ("error" in resolved) {
    io.err(resolved.error);
    return 1;
  }
  const model = pickModel(args, resolved.model) ?? "default";
  const budget = contextManager.budget({ messages: resolved.messages, model });
  const plan = contextManager.plan({ messages: resolved.messages, budget });
  const projected = contextManager.projected(budget);
  const remaining = Math.max(0, budget.contextWindow - projected);

  if (json) {
    io.out(
      JSON.stringify(
        {
          sessionId: resolved.sessionId ?? null,
          model,
          contextWindow: budget.contextWindow,
          reservedOutput: budget.reservedOutput,
          reservedSystem: budget.reservedSystem,
          reservedTools: budget.reservedTools,
          usableInput: budget.usableInput,
          estimatedInput: budget.estimatedInput,
          projectedRequest: projected,
          remaining: budget.remaining,
          threshold: budget.threshold,
          overThreshold: budget.overThreshold,
          limitSource: budget.source,
          confidence: budget.confidence,
          compactionNeeded: plan.compactionNeeded,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  io.out("Context status");
  io.out("─".repeat(60));
  if (resolved.sessionId) io.out(`  Session:      ${resolved.sessionId}`);
  else io.out("  Session:      none active (budgeting an empty request)");
  io.out(`  Model:        ${model} (limits from ${budget.source})`);
  io.out(`  Window:       ${budget.contextWindow} tokens`);
  io.out(
    `  Reserved:     ${budget.reservedOutput} output · ${budget.reservedSystem} system · ${budget.reservedTools} tools`,
  );
  io.out(`  Usable input: ${budget.usableInput} tokens`);
  io.out(`  Projected:    ${projected} tokens (${percent(projected, budget.contextWindow)}% of window, ${remaining} remaining)`);
  io.out(`  Threshold:    ${budget.threshold}`);
  io.out(`  Estimate:     ${budget.estimatedInput} transcript tokens (${budget.confidence})`);
  io.out(`  Compaction:   ${plan.compactionNeeded ? "needed" : "not needed"}`);
  return 0;
}

async function cmdExplain(io: ContextCliIO, args: string[]): Promise<number> {
  const json = args.includes("--json");
  const sessionId = pickSessionId(args);
  const resolved = transcriptOf(sessionId);
  if ("error" in resolved) {
    io.err(resolved.error);
    return 1;
  }
  const model = pickModel(args, resolved.model) ?? "default";
  const budget = contextManager.budget({ messages: resolved.messages, model });
  const plan = contextManager.plan({ messages: resolved.messages, budget });

  const byCategory = new Map<string, { tokens: number; count: number; protected: boolean }>();
  for (const item of plan.included) {
    const current = byCategory.get(item.category) ?? { tokens: 0, count: 0, protected: item.protected };
    current.tokens += item.tokens;
    current.count += 1;
    byCategory.set(item.category, current);
  }
  const ranked = [...byCategory.entries()].sort((a, b) => b[1].tokens - a[1].tokens);

  if (json) {
    io.out(
      JSON.stringify(
        {
          model,
          estimatedTokens: plan.estimatedTokens,
          protectedTokens: plan.protectedTokens,
          prunableTokens: plan.prunableTokens,
          compactionNeeded: plan.compactionNeeded,
          reasons: plan.reasons,
          included: plan.included.map((item) => ({
            category: item.category,
            role: item.role,
            tokens: item.tokens,
            protected: item.protected,
            reason: item.reason,
          })),
          excluded: plan.excluded.map((item) => ({
            category: item.category,
            role: item.role,
            tokens: item.tokens,
            reason: item.reason,
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  io.out(`Context plan — ${model}`);
  io.out("─".repeat(60));
  io.out(`  Estimated:   ${plan.estimatedTokens} tokens`);
  io.out(`  Protected:   ${plan.protectedTokens} tokens`);
  io.out(`  Prunable:    ${plan.prunableTokens} tokens`);
  io.out(`  Compaction:  ${plan.compactionNeeded ? "needed" : "not needed"}`);
  if (plan.reasons.length > 0) {
    io.out("");
    io.out("  Why:");
    for (const reason of plan.reasons) io.out(`    · ${reason}`);
  }
  if (ranked.length > 0) {
    io.out("");
    io.out("  Largest contributors:");
    for (const [category, info] of ranked) {
      io.out(
        `    · ${category}: ${info.tokens} tokens across ${info.count} item(s)${info.protected ? " [protected]" : ""}`,
      );
    }
  }
  if (plan.excluded.length > 0) {
    io.out("");
    io.out("  Excluded:");
    const excludedByCategory = new Map<string, number>();
    for (const item of plan.excluded) {
      excludedByCategory.set(item.category, (excludedByCategory.get(item.category) ?? 0) + item.tokens);
    }
    for (const [category, tokens] of excludedByCategory) {
      io.out(`    · ${category}: ${tokens} tokens`);
    }
  }
  return 0;
}

async function cmdCompact(io: ContextCliIO, args: string[]): Promise<number> {
  const json = args.includes("--json");
  const force = args.includes("--force");
  const sessionId = pickSessionId(args);
  if (!sessionId) {
    io.err("No session to compact. Pass --session <id> or open one first.");
    return 1;
  }
  const resolved = transcriptOf(sessionId);
  if ("error" in resolved) {
    io.err(resolved.error);
    return 1;
  }
  const model = pickModel(args, resolved.model) ?? "default";
  const before = contextManager.budget({ messages: resolved.messages, model });

  const result = await contextEngine.prepareMessagesForApi(resolved.messages as never, {
    model,
    forceCompact: force,
    sessionId,
  });

  const after = contextManager.budget({ messages: result.messages as unknown as EstimatableMessage[], model });

  if (!result.compacted) {
    if (json) {
      io.out(
        JSON.stringify(
          { compacted: false, reason: "nothing_to_compact", beforeTokens: before.estimatedInput },
          null,
          2,
        ),
      );
    } else {
      io.out(
        `Nothing to compact: ${before.estimatedInput} transcript tokens are within the ${before.threshold}-token threshold.`,
      );
      io.out("Pass --force to compact anyway.");
    }
    return 0;
  }

  if (json) {
    io.out(
      JSON.stringify(
        {
          compacted: true,
          beforeTokens: before.estimatedInput,
          afterTokens: after.estimatedInput,
          savedTokens: Math.max(0, before.estimatedInput - after.estimatedInput),
          prunedCount: result.prunedCount,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  io.out(`Compacted ${sessionId}`);
  io.out("─".repeat(60));
  io.out(`  Estimate:    ${before.estimatedInput} → ${after.estimatedInput} tokens`);
  io.out(`  Pruned:      ${result.prunedCount} tool result(s)`);
  io.out(`  History:     preserved (original transcript remains on disk)`);
  return 0;
}

async function cmdCache(io: ContextCliIO, args: string[]): Promise<number> {
  const sub = args[0] ?? "status";
  if (sub === "clear") {
    contextManager.clearCache();
    io.out("Context cache cleared.");
    return 0;
  }
  if (sub !== "status") {
    io.err(`Unknown cache subcommand: ${sub}`);
    io.err("Try: status, clear");
    return 1;
  }
  const stats = contextManager.cacheStats();
  if (args.includes("--json")) {
    io.out(JSON.stringify(stats, null, 2));
    return 0;
  }
  io.out("Context cache");
  io.out("─".repeat(60));
  io.out(`  Entries:     ${stats.entries} / ${stats.maxEntries}`);
  io.out(`  Bytes:       ${stats.bytes} / ${stats.maxBytes}`);
  io.out(`  Hits/misses: ${stats.hits} / ${stats.misses}`);
  return 0;
}

const HELP = `ToolNet Context — token budgeting, planning and compaction

USAGE:
  toolnet context <subcommand>

SUBCOMMANDS:
  status [--session <id>] [--model <m>] [--json]
      Window, reservations, projection and compaction threshold.
  explain [--session <id>] [--model <m>] [--json]
      Largest context contributors, protected categories, exclusions.
  compact [--session <id>] [--force] [--json]
      Run a bounded compaction. No-op with a reason when nothing can be cut.
  cache status [--json]     Cache entries, bytes, hits and misses.
  cache clear               Drop every cached entry.

Read-only subcommands never contact a provider.`;

export async function runContextCli(argv: string[], io: ContextCliIO = defaultIO): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    for (const line of HELP.split("\n")) io.out(line);
    return sub ? 0 : 1;
  }
  try {
    switch (sub) {
      case "status":
        return await cmdStatus(io, rest);
      case "explain":
        return await cmdExplain(io, rest);
      case "compact":
        return await cmdCompact(io, rest);
      case "cache":
        return await cmdCache(io, rest);
      default:
        io.err(`Unknown context subcommand: ${sub}`);
        io.err("Try: status, explain, compact, cache");
        return 1;
    }
  } catch (error) {
    io.err(`context command failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
