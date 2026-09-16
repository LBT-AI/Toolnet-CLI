import { describe, it, expect } from "bun:test";
import { findCommand, getAllCommands } from "../../../src/commands";
import { computeLayoutGeometry } from "../../../src/tui/layout";

/**
 * Slash-command workflow: tokenizing, matching, palette geometry, and the
 * no-match path — the exact interaction loop the command palette drives.
 */
describe("Tier 4 Scenario: Slash Command Workflow", () => {
  it("T4.5: every registered command has palette-presentable metadata", () => {
    const commands = getAllCommands();
    expect(commands.length).toBeGreaterThan(0);

    for (const cmd of commands) {
      expect(cmd.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(cmd.description.length).toBeGreaterThan(0);
      expect(Array.isArray(cmd.aliases)).toBe(true);
    }

    // Command names must be unique — the palette cannot render two entries
    // for the same name. (Aliases may intentionally overlap between related
    // commands; resolution order is registry order, which findCommand owns.)
    const names = commands.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);

    // Every name and alias must resolve to SOME command.
    for (const cmd of commands) {
      for (const key of [cmd.name, ...cmd.aliases]) {
        expect(findCommand(`/${key}`)).not.toBeNull();
      }
    }
  });

  it("T4.6: exact command, alias, and argument tokenization resolve correctly", () => {
    const direct = findCommand("/help");
    expect(direct?.command.name).toBe("help");

    const aliased = findCommand("/session");
    expect(aliased).not.toBeNull();

    const withArgs = findCommand("/model sonnet-4.6");
    expect(withArgs?.command.name).toBe("model");
    expect(withArgs?.args).toEqual(["sonnet-4.6"]);

    const quoted = findCommand('/session "my work session"');
    expect(quoted?.args).toEqual(["my work session"]);
  });

  it("T4.7: unknown or malformed input resolves to null without throwing", () => {
    expect(findCommand("/definitely-not-a-command-xyz")).toBeNull();
    expect(findCommand("not a slash command")).toBeNull();
    expect(findCommand("/")).toBeNull();
    expect(findCommand("   ")).toBeNull();
  });

  it("T4.8: typing a slash prefix opens the palette without breaking the frame", () => {
    // Palette hint state ("my /mo…") must produce usable popup geometry even
    // in the smallest supported terminal.
    for (const [cols, rows] of [[80, 24], [60, 20], [40, 15]] as Array<[number, number]>) {
      const geo = computeLayoutGeometry(cols, rows, 5, 4, 4, false, 1);
      expect(geo.popupRows).toBeGreaterThan(0);
      expect(geo.popupRows).toBeLessThan(geo.rows);
      expect(geo.chatRows).toBeGreaterThanOrEqual(2);
      expect(geo.inputRows).toBeGreaterThanOrEqual(2);
    }
  });
});
