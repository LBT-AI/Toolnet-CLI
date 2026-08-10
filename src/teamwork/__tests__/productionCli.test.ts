import { describe, test, expect } from "bun:test";
import { doctorCommand } from "../../commands/doctor";
import { updateCommand } from "../../commands/update";
import { getAllCommands, findCommand } from "../../commands/index";

describe("Production CLI Features (/doctor, /update, commands)", () => {
  test("findCommand locates /doctor and /update commands", () => {
    const doc = findCommand("/doctor");
    expect(doc).not.toBeNull();
    expect(doc?.command.name).toBe("doctor");

    const up = findCommand("/update");
    expect(up).not.toBeNull();
    expect(up?.command.name).toBe("update");
  });

  test("doctorCommand executes diagnostic check without crashing", async () => {
    let outputMsg = "";
    const mockCtx: any = {
      currentModel: () => "openai/gpt-4o",
      gateway: {
        getBaseUrl: () => "http://127.0.0.1:20127",
        checkConnection: async () => false,
      },
      addMessage: (_role: string, content: string) => {
        outputMsg = content;
      },
    };

    await doctorCommand.handler([], mockCtx);
    expect(outputMsg).toContain("ToolNet API CLI Doctor Report");
    expect(outputMsg).toContain("Node.js");
    expect(outputMsg).toContain("Sandbox Mode");
  });

  test("updateCommand checks npm version without crashing", async () => {
    let outputMsg = "";
    const mockCtx: any = {
      setStatusMsg: () => {},
      addMessage: (_role: string, content: string) => {
        outputMsg = content;
      },
    };

    await updateCommand.handler([], mockCtx);
    expect(outputMsg).toBeDefined();
    expect(outputMsg.length).toBeGreaterThan(0);
  });
});
