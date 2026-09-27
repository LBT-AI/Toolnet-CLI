/**
 * Canonical slash-command inventory.
 *
 * Every registered command must be self-consistent across EVERY surface:
 * registry → parser → help → autocomplete → policy metadata. One registry, no
 * orphan metadata, no duplicate alias silently shadowing another command.
 */

import { describe, it, expect } from "bun:test";
import { getAllCommands, findCommand } from "../index";
import { getSuggestions } from "../../tui/input/inputHandler";
import { getNamespacePickerItems } from "../../tui/mcpPicker";
import {
  getCommandMeta,
  findAliasCollisions,
  suggestClosestCommand,
  CATEGORY_ORDER,
} from "../commandMeta";

describe("slash command inventory", () => {
  const cmds = getAllCommands();

  it("has unique canonical names", () => {
    const names = cmds.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("claims no alias twice (name or alias)", () => {
    expect(findAliasCollisions()).toEqual([]);
  });

  it("every command is complete and reachable from every surface", () => {
    for (const cmd of cmds) {
      expect(cmd.description.length, `${cmd.name} description`).toBeGreaterThan(0);
      expect(cmd.usage.length, `${cmd.name} usage`).toBeGreaterThan(0);
      expect(typeof cmd.handler, `${cmd.name} handler`).toBe("function");

      // Parser resolves the canonical name to itself.
      expect(findCommand("/" + cmd.name)?.command.name, `${cmd.name} parse`).toBe(cmd.name);

      // Policy metadata exists and is well-formed.
      const meta = getCommandMeta(cmd.name);
      expect(CATEGORY_ORDER, `${cmd.name} category`).toContain(meta.category);
      expect(typeof meta.allowedWhileBusy, `${cmd.name} busy policy`).toBe("boolean");

      // Autocomplete reaches it — directly, or through its namespace picker.
      const direct = getSuggestions("/" + cmd.name).map((s) => s.name);
      const namespaced = getNamespacePickerItems("/" + cmd.name);
      const reachable = direct.includes("/" + cmd.name) || Boolean(namespaced && namespaced.length > 0);
      expect(reachable, `${cmd.name} autocomplete`).toBe(true);
    }
  });

  it("resolves aliases to their canonical command and policy", () => {
    const aliasCases: Array<[string, string]> = [
      ["h", "help"],
      ["m", "model"],
      ["q", "queue"],
      ["perm", "policy"],
      ["security", "sandbox"],
      ["quit", "exit"],
    ];
    for (const [alias, canonical] of aliasCases) {
      expect(findCommand("/" + alias)?.command.name, "/" + alias).toBe(canonical);
      expect(getCommandMeta(alias).category).toBe(getCommandMeta(canonical).category);
      expect(getCommandMeta(alias).allowedWhileBusy).toBe(getCommandMeta(canonical).allowedWhileBusy);
    }
  });

  it("suggests a close command for a typo without auto-executing", () => {
    expect(suggestClosestCommand("mpc")).toBe("mcp");
    expect(suggestClosestCommand("hlep")).toBe("help");
    // A valid command never produces a suggestion.
    expect(suggestClosestCommand("mcp")).toBeUndefined();
    expect(suggestClosestCommand("status")).toBeUndefined();
  });

  it("declares an explicit busy policy per command", () => {
    for (const name of ["help", "status", "pwd", "workspace", "queue", "tools", "config", "history"]) {
      expect(getCommandMeta(name).allowedWhileBusy, `${name} safe`).toBe(true);
    }
    for (const name of ["model", "provider", "compact", "clear", "reset", "session", "mcp"]) {
      expect(getCommandMeta(name).allowedWhileBusy, `${name} unsafe`).toBe(false);
    }
  });

  it("drives `/help mcp` from the MCP subcommand metadata", () => {
    const mcp = findCommand("/mcp")?.command;
    expect(mcp?.subcommands?.length).toBeGreaterThan(0);
    expect(mcp?.subcommands?.map((s) => s.name)).toContain("show");
    expect(mcp?.subcommands?.map((s) => s.name)).toContain("logout");
  });
});
