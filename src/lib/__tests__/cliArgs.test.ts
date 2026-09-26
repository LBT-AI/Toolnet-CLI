import { describe, test, expect } from "bun:test";
import { isSimpleMode } from "../cliArgs";

describe("isSimpleMode — the overloaded -s flag", () => {
  test("bare -s is the lightweight REPL", () => {
    expect(isSimpleMode(["-s"])).toBe(true);
  });

  test("-s followed by another flag is still the REPL", () => {
    expect(isSimpleMode(["-s", "--verbose"])).toBe(true);
  });

  test("-s <id> opens a session, not the REPL", () => {
    expect(isSimpleMode(["-s", "sess_123"])).toBe(false);
  });

  test("--simple is always the REPL", () => {
    expect(isSimpleMode(["--simple"])).toBe(true);
    expect(isSimpleMode(["--simple", "sess_123"])).toBe(true);
  });

  test("no -s at all is not simple mode", () => {
    expect(isSimpleMode([])).toBe(false);
    expect(isSimpleMode(["--session", "sess_123"])).toBe(false);
  });
});
