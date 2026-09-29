import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { AgentHarness } from "../harness/agentHarness";

const mockChromium: any = {
  executablePath: () => "/fake/path/chrome"
};

mock.module("playwright", () => ({ chromium: mockChromium }));
mock.module("playwright-core", () => { throw new Error("not implemented") });

import fs from "node:fs";
const originalExistsSync = fs.existsSync;
let mockExistsSync: ((path: fs.PathLike) => boolean) | null = null;
// @ts-ignore
fs.existsSync = (path: any) => {
  if (mockExistsSync) return mockExistsSync(path);
  return originalExistsSync(path);
};

import { resetBrowserStateForTests } from "../browserTool";

beforeEach(() => {
  resetBrowserStateForTests();
  mockExistsSync = null;
});

afterEach(() => {
  resetBrowserStateForTests();
});

test("browser schema is omitted when unavailable", async () => {
  mockChromium.executablePath = () => "/fake/path/chrome";
  mockExistsSync = (p) => p === "/fake/path/chrome" ? false : originalExistsSync(p);

  const harness = new AgentHarness({
    currentCwd: "/",
    model: "test-model",
    harness: "default"
  });

  let toolsForRequest: any = null;

  // We mock completeModel to just capture the tools and return early
  harness["completeModel"] = async (provider: any, request: any) => {
    toolsForRequest = request.tools;
    return { response: { content: "test", toolCalls: [] }, hadMessage: true };
  };

  await harness.run("test request");

  expect(toolsForRequest).toBeDefined();
  const browserTool = toolsForRequest.find((t: any) => t.function?.name === "browser");
  expect(browserTool).toBeUndefined();
});

test("browser schema is included when available", async () => {
  mockChromium.executablePath = () => "/fake/path/chrome";
  mockExistsSync = (p) => p === "/fake/path/chrome" ? true : originalExistsSync(p);

  const harness = new AgentHarness({
    currentCwd: "/",
    model: "test-model",
    harness: "default"
  });
  let toolsForRequest: any = null;

  harness["completeModel"] = async (provider: any, request: any) => {
    toolsForRequest = request.tools;
    return { response: { content: "test", toolCalls: [] }, hadMessage: true };
  };

  await harness.run("test request");

  expect(toolsForRequest).toBeDefined();
  const browserTool = toolsForRequest.find((t: any) => t.function?.name === "browser");
  expect(browserTool).toBeDefined();
});

import { afterAll } from "bun:test";
afterAll(() => {
  mock.restore();
});

afterEach(() => {
  mockExistsSync = null;
});
