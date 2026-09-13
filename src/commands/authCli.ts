/**
 * — `toolnet auth`.
 *
 * Formatting + prompts only. Every read and write goes through
 * `authOperations` / `AuthProfileRegistry` / `CredentialResolver`, so the CLI
 * never touches the credential file and never re-implements precedence.
 *
 * Secret handling rules enforced here:
 *  - a key is never accepted on the command line (it would land in shell
 *    history and the process list) — only a hidden TTY prompt or an explicitly
 *    requested stdin import;
 *  - nothing secret is ever printed: status shows `source`, ids and booleans;
 *  - `--env` registers an environment-backed profile that stores NO secret.
 */

import {
  authOperations,
  AuthError,
  loginOpenRouter,
  credentialResolver,
  pinSessionAuthProfile,
  parseProfileId,
  providerCredentialEnv,
  validateProviderSegment,
} from "../core/auth";

export interface AuthCliIO {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Hidden secret entry; returns null when no TTY is available. */
  promptHidden?: (question: string) => Promise<string | null>;
  /** Visible one-line prompt (headless OAuth code entry). */
  promptText?: (question: string) => Promise<string | null>;
  /** Open a URL in the browser; injected for tests. */
  openBrowser?: (url: string) => void;
  env?: NodeJS.ProcessEnv;
}

/** Hidden secret prompt — no echo, no history, raw-mode single line. */
async function promptHiddenDefault(question: string): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return await new Promise<string | null>((resolve) => {
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003" || ch === "\u0004") {
          cleanup();
          process.stdout.write("\n");
          resolve(null);
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** Visible one-line prompt (headless OAuth code entry). */
async function promptTextDefault(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return await new Promise<string | null>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Best-effort browser open; failures are non-fatal and never leak the URL. */
function openBrowserDefault(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    /* the URL is printed anyway */
  }
}

const defaultIo: AuthCliIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  promptHidden: promptHiddenDefault,
  promptText: promptTextDefault,
  openBrowser: openBrowserDefault,
  env: process.env,
};

export const AUTH_CLI_USAGE = `ToolNet auth — provider credentials and auth profiles

USAGE:
  toolnet auth list                            List providers and profiles
  toolnet auth status [<provider>]             Auth status (no secrets shown)
  toolnet auth login openrouter [--no-browser] [--profile <name>]
                                               OAuth PKCE login (stores a key)
  toolnet auth add <provider> --profile <name> [--env <VAR>] [--secret-stdin]
                                               Add a manual key or env profile
  toolnet auth use <provider>/<profile>        Switch the active profile
  toolnet auth logout <provider>/<profile>     Forget the active pointer
  toolnet auth remove <provider>/<profile>     Delete profile + stored credential
  toolnet auth doctor                          Store/permission/config diagnostics

NOTES:
  - keys are never accepted as arguments; you are prompted without echo;
  - \`--env OPENROUTER_API_KEY\` stores no secret — the variable is read at call
    time, so existing environment setups keep working unchanged;
  - secrets are never printed, logged, or included in status output.`;

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.findIndex((arg) => arg === flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/** Providers recognised without any stored profile. */
function defaultProviders(env: NodeJS.ProcessEnv): string[] {
  const ids = new Set<string>(["openrouter", "toolnet"]);
  if (env.OPENROUTER_API_KEY) ids.add("openrouter");
  return [...ids];
}

export async function runAuthCli(argv: string[], io: AuthCliIO = defaultIo): Promise<number> {
  const args = [...argv];
  const sub = args.shift() ?? "status";

  try {
    switch (sub) {
      case "help":
      case "--help":
      case "-h":
        io.out(AUTH_CLI_USAGE);
        return 0;
      case "list":
        return cmdList(args, io);
      case "status":
        return cmdStatus(args, io);
      case "login":
        return await cmdLogin(args, io);
      case "add":
        return await cmdAdd(args, io);
      case "use":
        return cmdUse(args, io);
      case "logout":
        return cmdLogout(args, io);
      case "remove":
        return cmdRemove(args, io);
      case "doctor":
        return cmdDoctor(io);
      default:
        io.err(`Unknown auth command: ${sub}`);
        io.err(AUTH_CLI_USAGE);
        return 1;
    }
  } catch (error) {
    io.err(formatAuthError(error));
    return 1;
  }
}

function cmdList(args: string[], io: AuthCliIO): number {
  const views = authOperations.list(args.length > 0 ? args : defaultProviders(io.env ?? process.env));
  if (views.length === 0) {
    io.out("No providers configured. Run 'toolnet auth login openrouter' or set OPENROUTER_API_KEY.");
    return 0;
  }
  for (const view of views) {
    const activeMark = view.activeProfileId ? ` active: ${view.activeProfileId}` : "";
    io.out(`${view.providerId}  [${view.status}]  source: ${view.source}${activeMark}`);
    if (view.profiles.length === 0) {
      io.out("  (no profiles — using environment/legacy credentials)");
      continue;
    }
    for (const profile of view.profiles) {
      const isActive = view.activeProfileId === profile.id ? " *" : "  ";
      io.out(`  ${isActive} ${profile.id}  type: ${profile.type}`);
    }
  }
  return 0;
}

function cmdStatus(args: string[], io: AuthCliIO): number {
  const requested = args.filter((arg) => !arg.startsWith("--"));
  const providers = requested.length > 0 ? requested : defaultProviders(io.env ?? process.env);
  for (const providerId of providers) {
    const view = authOperations.view(providerId);
    io.out(`${view.providerId}`);
    io.out(`  status: ${view.status}`);
    io.out(`  source: ${view.source}`);
    io.out(`  profiles: ${view.profileCount}`);
    if (view.activeProfileId) io.out(`  active: ${view.activeProfileId}`);
    if (view.envName) io.out(`  env: ${view.envName} (${view.envPresent ? "set" : "unset"})`);
    io.out(`  configured: ${view.configured ? "yes" : "no"}`);
  }
  return 0;
}

async function cmdLogin(args: string[], io: AuthCliIO): Promise<number> {
  const providerArg = args.find((arg) => !arg.startsWith("-"));
  const providerId = (providerArg ?? "openrouter").trim().toLowerCase();
  if (providerId !== "openrouter") {
    io.err(`OAuth login is only implemented for 'openrouter' (received '${providerId}').`);
    return 1;
  }
  const noBrowser = hasFlag(args, "--no-browser") || Boolean(io.env?.TOOLNET_NO_BROWSER);
  const profileName = flagValue(args, "--profile") ?? "default";

  io.out("Starting OpenRouter OAuth (PKCE S256)…");
  const result = await loginOpenRouter({
    profileName,
    noBrowser,
    onAuthorizationUrl: (url) => {
      io.out("");
      io.out("Authorize ToolNet at:");
      io.out(`  ${url}`);
      io.out("");
      if (!noBrowser) {
        try {
          io.openBrowser?.(url);
        } catch {
          io.err("Could not open a browser automatically — open the URL above manually.");
        }
      }
    },
    onStatus: (message) => io.out(message),
    ...(noBrowser
      ? {
          requestCode: async () => {
            const prompt =
              io.promptText ??
              (async () => {
                throw new AuthError({
                  code: "AUTH_PROMPT_UNAVAILABLE",
                  message: "no interactive prompt is available to enter the authorization code",
                });
              });
            const code = await prompt("Paste the authorization code shown by OpenRouter: ");
            if (!code?.trim()) {
              throw new AuthError({
                code: "AUTH_CODE_MISSING",
                message: "no authorization code provided — nothing was stored",
              });
            }
            return code.trim();
          },
        }
      : {}),
  });

  io.out(`Authenticated. Profile '${result.profileId}' is now active.`);
  io.out("The credential was stored with mode 0600 and is never printed.");
 // — the running session keeps its identity: pin explicitly to switch it.
  if (result.activated) {
    try {
      const { providerId: provider } = parseProfileId(result.profileId);
      pinSessionAuthProfile(provider, result.profileId);
    } catch {
      /* session pinning is best-effort outside a session */
    }
  }
  return 0;
}

async function cmdAdd(args: string[], io: AuthCliIO): Promise<number> {
  const providerArg = args.find((arg) => !arg.startsWith("-"));
  if (!providerArg) {
    io.err("usage: toolnet auth add <provider> --profile <name> [--env <VAR>] [--secret-stdin]");
    return 1;
  }
  const providerId = validateProviderSegment(providerArg);
  const profileName = flagValue(args, "--profile") ?? "default";
  const envFlag = flagValue(args, "--env");

 // — environment-backed profile: no secret is stored at all.
  if (envFlag !== undefined || hasFlag(args, "--env-profile")) {
    const envName = envFlag ?? providerCredentialEnv(providerId);
    if (!envName) {
      io.err(`No standard environment variable for '${providerId}'. Pass --env <VAR_NAME>.`);
      return 1;
    }
    const profile = authOperations.addEnv({ providerId, name: profileName, envName });
    const present = io.env?.[envName] ? "set" : "unset";
    io.out(`Registered env profile '${profile.id}' → $${envName} (currently ${present}).`);
    io.out("No secret was stored; the variable is read at call time.");
    return 0;
  }

  if (hasFlag(args, "--key") || args.some((arg) => arg.startsWith("--key="))) {
    io.err(
      "Refusing a key on the command line: it would be recorded in shell history and the process list.",
    );
    io.err("Run without --key to be prompted securely, or use --secret-stdin for automation.");
    return 1;
  }

  let secret: string | null = null;
  if (hasFlag(args, "--secret-stdin")) {
    secret = await readSecretFromStdin();
  } else if (io.promptHidden) {
    secret = await io.promptHidden(`API key for ${providerId} (input hidden): `);
  }
  if (!secret) {
    io.err("No secret provided — nothing was stored.");
    io.err("Run in a terminal for a hidden prompt, or pass --secret-stdin to read one line from stdin.");
    return 1;
  }

  const profile = await authOperations.addApiKey({ providerId, name: profileName, secret });
  io.out(`Stored credential for profile '${profile.id}'.`);
  io.out("The value is not echoed, logged, or shown in any status output.");
  return 0;
}

function cmdUse(args: string[], io: AuthCliIO): number {
  const profileId = args.find((arg) => !arg.startsWith("-"));
  if (!profileId) {
    io.err("usage: toolnet auth use <provider>/<profile>");
    return 1;
  }
  const profile = authOperations.use(profileId);
  io.out(`Active profile for '${profile.providerId}' is now '${profile.id}'.`);
  try {
    pinSessionAuthProfile(profile.providerId, profile.id);
  } catch {
    /* outside a session this is a no-op */
  }
  return 0;
}

function cmdLogout(args: string[], io: AuthCliIO): number {
  const profileId = args.find((arg) => !arg.startsWith("-"));
  if (!profileId) {
    io.err("usage: toolnet auth logout <provider>/<profile>");
    return 1;
  }
  const result = authOperations.logout(profileId);
  io.out(`Logged out of '${result.profileId}'.`);
  io.out("The stored credential was kept — 'toolnet auth use' can switch back to it.");
  return 0;
}

async function cmdRemove(args: string[], io: AuthCliIO): Promise<number> {
  const profileId = args.find((arg) => !arg.startsWith("-"));
  if (!profileId) {
    io.err("usage: toolnet auth remove <provider>/<profile>");
    return 1;
  }
  if (!hasFlag(args, "--yes")) {
    io.err(`Refusing to delete '${profileId}' without --yes (this removes the stored credential).`);
    return 1;
  }
  const result = await authOperations.remove(profileId);
  io.out(`Removed '${result.profileId}'${result.credentialDeleted ? " and its stored credential" : ""}.`);
  return 0;
}

function cmdDoctor(io: AuthCliIO): number {
  const report = authOperations.doctor();
  io.out("ToolNet auth doctor");
  io.out(`  store: ${report.storePath}`);
  io.out(`  permissions: ${report.permissions}`);
  if (report.quarantined) {
    io.out(`  quarantined: ${report.quarantined.quarantinedPath}`);
    io.out(`  reason: ${report.quarantined.reason}`);
    io.out("  (contents were never read or logged — re-authenticate to rebuild)");
  }
  for (const view of report.providers) {
    const envNote = view.envName
      ? `  env: ${view.envName} (${view.envPresent ? "set" : "unset"})`
      : "";
    io.out(`  ${view.providerId}: ${view.status} (source: ${view.source})${envNote}`);
  }
  for (const entry of report.envOnly) {
    io.out(`  ${entry.providerId}: environment only (${entry.envName}) — no stored credential`);
  }
  io.out("  No secret values were read or displayed.");
  return 0;
}

/**
 * Read one secret line from stdin for non-interactive automation. The value is
 * never echoed and never becomes an argument.
 */
async function readSecretFromStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer | string));
  }
  const line = Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
  const trimmed = line.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Secret-free error rendering (AuthError messages are already redacted). */
export function formatAuthError(error: unknown): string {
  if (error instanceof AuthError) {
    const parts = [`${error.code}:`, error.message];
    if (error.retryable) parts.push("(retryable)");
    return parts.join(" ");
  }
  return `AUTH_ERROR: ${error instanceof Error ? error.message : String(error)}`;
}

/** True when a provider has any resolvable credential (used by other commands). */
export function providerHasCredential(providerId: string): boolean {
  try {
    return Boolean(credentialResolver.lookup({ providerId }).credential);
  } catch {
    return false;
  }
}
