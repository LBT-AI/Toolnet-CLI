/**
 * Input-ownership regression guards:
 *  - exactly ONE production keyboard router (inputHandler) feeds from stdin;
 *  - the stateful VT decoder is the only escape-sequence parser in src/tui;
 *  - modal/picker keys never leak into the composer or global handlers.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { handleKey, resetInputState, getInputState } from "../../../src/tui/input/inputHandler";
import { tuiState } from "../../../src/tui/state";

function walk(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, into);
    else into.push(full);
  }
  return into;
}

describe("Input ownership — one router, one decoder", () => {
  it("no production module parses raw escape sequences itself", () => {
    // Everything under src/tui except the decoder must not scan for ESC in
    // raw byte arrays. (handleKey still pattern-matches the canonical decoded
    // string "\u001b[..", which is fine — that IS the one logical key.)
    const offenders: string[] = [];
    for (const f of walk("src/tui")) {
      if (!f.endsWith(".ts") || f.includes("__tests__")) continue;
      if (f.endsWith("input/keyDecoder.ts")) continue;
      const src = readFileSync(f, "utf8");
      if (/0x5b\s*\|\|\s*0x4f|charCodeAt\(1\)\s*===\s*0x5b/.test(src)) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the legacy keyboard router is gone", () => {
    expect(() => statSync("src/tui/input/keyboard.ts")).toThrow();
  });
});

describe("Modal focus routing — keys never leak", () => {
  it("model picker open: Down moves selection and leaks nothing into the composer", () => {
    resetInputState();
    tuiState.showModelPicker = true;
    tuiState.modelPickerStage = "model";
    tuiState.pendingProviderId = "toolnet";
    tuiState.filteredModels = ["m1", "m2", "m3"];
    tuiState.modelPickerIdx = 0;

    const sent: string[] = [];
    handleKey(Buffer.from("\u001b[B", "latin1"), {
      renderAll: () => {},
      sendMessage: (t: string) => sent.push(t),
      exitApp: () => {
        throw new Error("Down must never exit");
      },
      openModelPicker: async () => {},
    } as any);

    expect(tuiState.modelPickerIdx).toBe(1);
    expect(tuiState.showModelPicker).toBe(true);
    expect(tuiState.modelPickerStage).toBe("model");
    expect(getInputState().buffer).toBe("");
    expect(sent).toEqual([]);
    tuiState.showModelPicker = false;
    tuiState.pendingProviderId = null;
  });

  it("model picker open: Esc closes the picker only — no exit, no composer change", () => {
    resetInputState();
    tuiState.showModelPicker = true;
    let exited = false;
    handleKey(Buffer.from("\u001b", "latin1"), {
      renderAll: () => {},
      sendMessage: () => {},
      exitApp: () => {
        exited = true;
      },
      openModelPicker: async () => {},
    } as any);
    expect(tuiState.showModelPicker).toBe(false);
    expect(exited).toBe(false);
    expect(getInputState().buffer).toBe("");
  });

  it("model picker: arrow bytes never enter the search query", () => {
    resetInputState();
    tuiState.showModelPicker = true;
    tuiState.modelSearchQuery = "gp";
    tuiState.filteredModels = ["m1"];
    handleKey(Buffer.from("\u001b[C", "latin1"), {
      renderAll: () => {},
      sendMessage: () => {},
      exitApp: () => {},
      openModelPicker: async () => {},
    } as any);
    expect(tuiState.modelSearchQuery).toBe("gp");
    tuiState.showModelPicker = false;
  });
});
