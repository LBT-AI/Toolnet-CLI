/**
 * Phase 81 §18 — `toolnet harness`.
 *
 * Formatting + orchestration only. Every read comes from the canonical
 * `harnessRegistry`, every write goes through `src/core/harness/store.ts`
 * (validated, atomic, persisted in the existing config owner).
 *
 * This command never constructs a harness, never calls a provider and never
 * touches the router: selecting a harness profile is independent of model
 * routing.
 */

import {
  harnessRegistry,
  currentHarnessSettings,
  persistHarnessProfile,
  resetPersistedHarness,
  summarizeHarnessProfile,
  AUTO_HARNESS_BY_TASK,
  type HarnessProfile,
} from "../core/harness";
import {
  externalHarnessRegistry,
  externalHarnessRunner,
  HarnessNotFoundError,
  parseNamespacedSession,
} from "../core/externalHarness";

export interface HarnessCliIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIo: HarnessCliIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export const HARNESS_CLI_USAGE = `ToolNet harness — policy profiles for the one AgentHarness

USAGE:
  toolnet harness list              List profiles and mark the active one.
  toolnet harness show <id>         Show one profile's full policy contract.
  toolnet harness current           Show the configured profile.
  toolnet harness use <id>          Persist a profile for future runs.
  toolnet harness reset             Restore the default profile.
  toolnet harness external list     List external harnesses and availability.
  toolnet harness external status   Detailed status for every external harness.
  toolnet harness external show <id>  Show one external harness's capabilities.
  toolnet harness external run <id> --prompt "..." [--model p/m] [--cwd dir]
                                    [--session external:harness:id] [--fork]
                                    [--timeout ms] [-- extra args...]

NOTES:
  · A harness profile is POLICY: prompt strategy, tool EXPOSURE, loop bounds and
    the completion contract. It is not a second runtime and never selects a model.
  · A profile can only narrow the exposed tool set. Permission, sandbox, the
    ToolGateway and hook policy are unchanged by any profile.
  · Harness selection and model routing are independent:
    'toolnet routing' chooses the model, 'toolnet harness' chooses the policy.
  · EXTERNAL harnesses (opencode, codex, …) are independent executables whose
    tools are OUTSIDE ToolNet's permission system. They never run implicitly:
    invoking one is always an explicit user action.`;

export interface HarnessCliDeps {
  io?: HarnessCliIO;
  /** Phase 83 — external run injection seam (tests); defaults to the canonical runner. */
  externalRun?: typeof externalHarnessRunner.run;
  /** Cancellation source for an external run. */
  signal?: AbortSignal;
}

function pad(value: string, width: number): string {
  const text = value.length > width - 1 ? `${value.slice(0, width - 2)}…` : value;
  return text.padEnd(width, " ");
}

function profileSummary(profile: HarnessProfile) {
  return {
    id: profile.id,
    version: profile.version,
    displayName: profile.displayName,
    description: profile.description,
    promptVerbosity: profile.promptPolicy.verbosity,
    toolAllow: profile.toolPolicy.allow ?? null,
    toolDeny: profile.toolPolicy.deny ?? null,
    maxTurns: profile.continuationPolicy.maxTurns ?? null,
    maxRepeatedToolCalls: profile.continuationPolicy.maxRepeatedToolCalls,
    maxConsecutiveNoProgressTurns: profile.continuationPolicy.maxConsecutiveNoProgressTurns,
    contextMode: profile.contextPolicy.mode,
    enforceEvidence: profile.completionPolicy.enforceEvidence,
    autoFor: profile.autoFor ?? [],
  };
}

export async function runHarnessCli(
  args: string[],
  deps: HarnessCliDeps = {},
): Promise<number> {
  const io = deps.io ?? defaultIo;
  const json = args.includes("--json");
  const help = args.includes("--help") || args.includes("-h");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const action = (positional[0] ?? "list").toLowerCase();

  if (help) {
    io.out(HARNESS_CLI_USAGE);
    return 0;
  }

  switch (action) {
    case "list":
      return listProfiles(io, json);
    case "show":
      return showProfile(io, json, positional[1]);
    case "current":
      return showCurrent(io, json);
    case "use":
    case "set":
      return useProfile(io, json, positional[1]);
    case "reset":
      return resetProfile(io, json);
    case "external":
      return runExternalSubcommand(io, json, positional.slice(1), args, deps);
    default:
      io.err(`Unknown harness subcommand: ${action}`);
      io.err(HARNESS_CLI_USAGE);
      return 1;
  }
}

// ── external ────────────────────────────────────────────────────────────────────

/**
 * Phase 83 §20 — external harness subcommands. Args after `--` are forwarded
 * verbatim as argv elements (never joined into a shell string).
 */
async function runExternalSubcommand(
  io: HarnessCliIO,
  json: boolean,
  rest: string[],
  allArgs: string[],
  deps: HarnessCliDeps,
): Promise<number> {
  const sub = (rest[0] ?? "status").toLowerCase();

  switch (sub) {
    case "list":
    case "status":
      return externalStatus(io, json, sub === "list");
    case "show":
      return externalShow(io, json, rest[1]);
    case "run":
      return externalRun(io, json, rest.slice(1), allArgs, deps);
    default:
      io.err(`Unknown harness external subcommand: ${sub}`);
      io.err(HARNESS_CLI_USAGE);
      return 1;
  }
}

async function externalStatus(io: HarnessCliIO, json: boolean, listMode: boolean): Promise<number> {
  const ids = externalHarnessRegistry.ids();
  const statuses = await Promise.all(
    ids.map(async (id) => {
      try {
        return await externalHarnessRegistry.statusOf(id);
      } catch {
        return null;
      }
    }),
  );
  const rows = statuses.filter((row): row is NonNullable<typeof row> => row !== null);

  if (json) {
    io.out(JSON.stringify(rows, null, 2));
    return 0;
  }

  io.out(`External harnesses (${rows.length})${listMode ? "" : "   trust: external_managed — ToolNet permissions do NOT apply"}`);
  io.out("─".repeat(78));
  for (const row of rows) {
    const availability = row.detection.available ? row.detection.version ?? "installed" : "unavailable";
    io.out(
      `${pad(row.id, 12)}${pad(availability, 16)}${pad(`json:${row.capabilities.structuredOutput ? "yes" : "no"}`, 9)}` +
        `${pad(`model:${row.capabilities.modelOverride ? "yes" : "no"}`, 10)}` +
        `${row.displayName}`,
    );
    if (!row.detection.available && row.detection.detail) io.out(`${pad("", 12)}↳ ${row.detection.detail}`);
  }
  return 0;
}

async function externalShow(io: HarnessCliIO, json: boolean, id: string | undefined): Promise<number> {
  if (!id) {
    io.err("Usage: toolnet harness external show <id>");
    io.err(`External: ${externalHarnessRegistry.ids().join(", ")}`);
    return 1;
  }
  let definition;
  try {
    definition = externalHarnessRegistry.resolve(id);
  } catch (error) {
    if (error instanceof HarnessNotFoundError) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
  const detection = await externalHarnessRegistry.detect(definition.id);

  if (json) {
    io.out(JSON.stringify({ ...definition, detection, detect: undefined, buildInvocation: undefined, parseEvent: undefined, normalizeResult: undefined, isFrameComplete: undefined }, null, 2));
    return 0;
  }

  io.out(`${definition.displayName} (${definition.id})   executable: ${definition.executable}`);
  io.out("─".repeat(78));
  io.out(`available: ${detection.available ? detection.version ?? "yes" : `no${detection.detail ? ` (${detection.detail})` : ""}`}`);
  io.out(`execution trust: ${definition.executionTrust} — tools run OUTSIDE ToolNet's permission system`);
  io.out("");
  io.out("Capabilities:");
  for (const [key, value] of Object.entries(definition.capabilities)) {
    io.out(`  ${pad(key, 20)}${typeof value === "boolean" ? (value ? "yes" : "no") : String(value)}`);
  }
  io.out("");
  io.out(`Env passthrough (names only): ${definition.envAllowlist.join(", ")}`);
  return 0;
}

async function externalRun(
  io: HarnessCliIO,
  json: boolean,
  rest: string[],
  allArgs: string[],
  deps: HarnessCliDeps,
): Promise<number> {
  const id = rest[0];
  if (!id) {
    io.err("Usage: toolnet harness external run <id> --prompt \"...\" [-- extra args...]");
    return 1;
  }

  // Split forwarded args at `--`; everything after goes to the harness verbatim.
  const separator = allArgs.indexOf("--");
  const forwarded = separator >= 0 ? allArgs.slice(separator + 1) : [];
  const flagOf = (name: string): string | undefined => {
    const index = allArgs.indexOf(name);
    return index >= 0 ? allArgs[index + 1] : undefined;
  };
  const prompt = flagOf("--prompt");
  if (!prompt) {
    io.err("Usage: toolnet harness external run <id> --prompt \"...\" [-- extra args...]");
    return 1;
  }
  const model = flagOf("--model");
  const cwd = flagOf("--cwd");
  const session = flagOf("--session");
  const timeoutFlag = flagOf("--timeout");
  const fork = allArgs.includes("--fork");

  // §15 — resume identity must carry the same harness namespace.
  let resume: { harnessId: string; externalSessionId: string } | undefined;
  if (session) {
    const parsed = parseNamespacedSession(session);
    if (!parsed) {
      io.err(`Invalid external session id '${session}'. Expected external:<harness>:<id>.`);
      return 1;
    }
    resume = parsed;
  }

  const signal = deps.signal;
  try {
    const runner = deps.externalRun ?? ((request: Parameters<typeof externalHarnessRunner.run>[0]) => externalHarnessRunner.run(request));
    const outcome = await runner({
      harnessId: id.trim().toLowerCase(),
      prompt,
      ...(cwd ? { cwd } : {}),
      ...(model ? { model: { logicalModel: model } } : {}),
      ...(resume ? { resume } : {}),
      ...(fork ? { forkSession: true } : {}),
      ...(forwarded.length > 0 ? { extraArgs: forwarded } : {}),
      ...(timeoutFlag !== undefined && Number.isFinite(Number(timeoutFlag)) ? { timeoutMs: Number(timeoutFlag) } : {}),
      ...(signal ? { signal } : {}),
    });

    if (json) {
      io.out(JSON.stringify(outcome, null, 2));
    } else {
      io.out(`harness: ${outcome.harnessId}   status: ${outcome.status}   exit: ${outcome.exitCode ?? "signal"}   ${outcome.durationMs}ms`);
      if (outcome.finalText) {
        io.out("");
        io.out(outcome.finalText);
      }
      if (outcome.sessionId) io.out("");
      if (outcome.sessionId) io.out(`session: ${outcome.sessionId}`);
      if (outcome.stderr) io.out(`stderr: ${outcome.stderr}`);
    }
    return outcome.status === "SUCCESS" ? 0 : 1;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

// ── list ────────────────────────────────────────────────────────────────────

function listProfiles(io: HarnessCliIO, json: boolean): number {
  const active = currentHarnessSettings().profile;
  const profiles = harnessRegistry.list();

  if (json) {
    io.out(
      JSON.stringify(
        { active, profiles: profiles.map(profileSummary) },
        null,
        2,
      ),
    );
    return 0;
  }

  io.out(`Harness profiles (${profiles.length})   active: ${active}`);
  io.out("─".repeat(78));
  io.out(`${pad("", 3)}${pad("PROFILE", 12)}${pad("VERSION", 9)}${pad("AUTO FOR", 26)}DESCRIPTION`);
  for (const profile of profiles) {
    const marker = profile.id === active ? "*" : " ";
    io.out(
      `${pad(marker, 3)}${pad(profile.id, 12)}${pad(`v${profile.version}`, 9)}` +
        `${pad(profile.autoFor?.join(", ") ?? "—", 26)}${profile.description}`,
    );
  }
  io.out("");
  io.out("Auto-resolution table (task type → profile):");
  for (const [taskType, profileId] of Object.entries(AUTO_HARNESS_BY_TASK)) {
    io.out(`  ${pad(taskType, 16)}→ ${profileId}`);
  }
  return 0;
}

// ── show ────────────────────────────────────────────────────────────────────

function showProfile(io: HarnessCliIO, json: boolean, id: string | undefined): number {
  if (!id) {
    io.err("Usage: toolnet harness show <id>");
    io.err(`Profiles: ${harnessRegistry.ids().join(", ")}`);
    return 1;
  }
  const profile = harnessRegistry.get(id.trim().toLowerCase());
  if (!profile) {
    io.err(`Unknown harness profile '${id}'. Known: ${harnessRegistry.ids().join(", ")}.`);
    return 1;
  }

  if (json) {
    io.out(JSON.stringify(profileSummary(profile), null, 2));
    return 0;
  }

  io.out(`${profile.displayName} (${profile.id}) v${profile.version}`);
  io.out("─".repeat(78));
  io.out(profile.description);
  io.out("");
  for (const line of summarizeHarnessProfile(profile)) io.out(line);
  if (profile.promptPolicy.instructions) {
    io.out("");
    io.out("Instructions:");
    io.out(profile.promptPolicy.instructions);
  }
  return 0;
}

// ── current ─────────────────────────────────────────────────────────────────

function showCurrent(io: HarnessCliIO, json: boolean): number {
  const settings = currentHarnessSettings();
  const profile = harnessRegistry.get(settings.profile);
  const known = harnessRegistry.has(settings.profile);

  if (json) {
    io.out(
      JSON.stringify(
        {
          configured: settings.profile,
          resolved: known ? settings.profile : harnessRegistry.defaultProfile.id,
          known,
          profile: profile ? profileSummary(profile) : null,
        },
        null,
        2,
      ),
    );
    return known ? 0 : 1;
  }

  if (!known) {
    // Loud, not silent: a configured id the registry does not know is reported
    // rather than quietly replaced.
    io.err(
      `Configured harness profile '${settings.profile}' is not registered. ` +
        `Runs fall back to '${harnessRegistry.defaultProfile.id}'. Known: ${harnessRegistry.ids().join(", ")}.`,
    );
    return 1;
  }

  io.out(`Harness profile: ${settings.profile}`);
  io.out("─".repeat(78));
  for (const line of summarizeHarnessProfile(profile!)) io.out(line);
  return 0;
}

// ── use / reset ─────────────────────────────────────────────────────────────

function useProfile(io: HarnessCliIO, json: boolean, id: string | undefined): number {
  if (!id) {
    io.err("Usage: toolnet harness use <id>");
    io.err(`Profiles: ${harnessRegistry.ids().join(", ")}`);
    return 1;
  }
  const result = persistHarnessProfile(id);
  if (!result.ok) {
    for (const error of result.errors) io.err(error);
    return 1;
  }
  if (json) {
    io.out(JSON.stringify(result.settings, null, 2));
    return 0;
  }
  io.out(`Harness profile set to '${result.settings.profile}'.`);
  io.out("Applies to new runs. Existing sessions keep the profile they started with.");
  return 0;
}

function resetProfile(io: HarnessCliIO, json: boolean): number {
  const settings = resetPersistedHarness();
  if (json) {
    io.out(JSON.stringify(settings, null, 2));
    return 0;
  }
  io.out(`Harness profile reset to '${settings.profile}'.`);
  return 0;
}
