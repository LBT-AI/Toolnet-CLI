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

NOTES:
  · A harness profile is POLICY: prompt strategy, tool EXPOSURE, loop bounds and
    the completion contract. It is not a second runtime and never selects a model.
  · A profile can only narrow the exposed tool set. Permission, sandbox, the
    ToolGateway and hook policy are unchanged by any profile.
  · Harness selection and model routing are independent:
    'toolnet routing' chooses the model, 'toolnet harness' chooses the policy.`;

export interface HarnessCliDeps {
  io?: HarnessCliIO;
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
    default:
      io.err(`Unknown harness subcommand: ${action}`);
      io.err(HARNESS_CLI_USAGE);
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
