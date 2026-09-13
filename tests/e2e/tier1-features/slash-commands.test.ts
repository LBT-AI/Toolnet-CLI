import { describe, it, expect } from "bun:test";
import { getAllCommands, findCommand, dispatchCommand, type CommandContext } from "../../../src/commands/index";

describe("Tier 1 Feature Coverage: Centralized Slash Command Registry", () => {
  it("F13.1: Canonical command registry contains all registered commands", () => {
    const commands = getAllCommands();
    expect(commands.length).toBeGreaterThanOrEqual(30);

    const names = commands.map((c) => c.name);
    expect(names).toContain("help");
    expect(names).toContain("model");
    expect(names).toContain("session");
    expect(names).toContain("compact");
    expect(names).toContain("status");
    expect(names).toContain("exit");
  });

  it("F13.2: findCommand parses primary command name and unquoted arguments", () => {
    const found = findCommand("/model openai/gpt-4o");
    expect(found).not.toBeNull();
    expect(found?.command.name).toBe("model");
    expect(found?.args).toEqual(["openai/gpt-4o"]);
  });

  it("F13.3: findCommand handles quoted arguments with spaces cleanly", () => {
    const found = findCommand('/session rename "My Production Session"');
    expect(found).not.toBeNull();
    expect(found?.command.name).toBe("session");
    expect(found?.args).toEqual(["rename", "My Production Session"]);
  });

  it("F13.4: Alias resolution correctly identifies commands through alias tokens", () => {
    const commands = getAllCommands();
    const cmdWithAlias = commands.find((c) => c.aliases.length > 0);
    expect(cmdWithAlias).toBeDefined();

    if (cmdWithAlias) {
      const alias = cmdWithAlias.aliases[0];
      const found = findCommand(`/${alias}`);
      expect(found).not.toBeNull();
      expect(found?.command.name).toBe(cmdWithAlias.name);
    }
  });

  it("F13.5: Unknown or non-slash inputs return null and dispatchCommand returns false", async () => {
    const notSlash = findCommand("plain text prompt");
    expect(notSlash).toBeNull();

    const unknown = findCommand("/nonexistentcommand12345");
    expect(unknown).toBeNull();

    const mockCtx: CommandContext = {
      addMessage: () => {},
      setModel: () => {},
      setStatusMsg: () => {},
      exit: () => {},
      currentModel: () => "default",
    };

    const dispatched = await dispatchCommand("/nonexistentcommand12345", mockCtx);
    expect(dispatched).toBe(false);
  });
});
