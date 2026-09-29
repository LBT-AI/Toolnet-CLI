import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";

let mockChromium: any = {
  executablePath: () => "/fake/path/chrome",
  launch: async () => ({})
};

mock.module("playwright", () => ({ chromium: mockChromium }));
mock.module("playwright-core", () => { throw new Error("not implemented") });

const originalExistsSync = fs.existsSync;
let mockExistsSync: ((path: fs.PathLike) => boolean) | null = null;
// @ts-ignore
fs.existsSync = (path: any) => {
  if (mockExistsSync) return mockExistsSync(path);
  return originalExistsSync(path);
};

import { getBrowserCapability, resetBrowserStateForTests, executeBrowserTool } from "../browserTool";

beforeEach(() => {
  resetBrowserStateForTests();
  mockExistsSync = null;
});

afterEach(() => {
  resetBrowserStateForTests();
});

test("Capability B - Playwright present, binary missing", async () => {
  mockChromium.executablePath = () => "/fake/path/chrome";
  mockExistsSync = (p) => p === "/fake/path/chrome" ? false : originalExistsSync(p);

  const cap = await getBrowserCapability();
  expect(cap.available).toBe(false);
  expect(cap.reason).toContain("Chromium executable unavailable");

  const res = await executeBrowserTool({});
  expect(res.success).toBe(false);
  expect(res.error).toContain("TOOL_UNAVAILABLE: Chromium executable unavailable");
});

test("Capability C - Available", async () => {
  mockChromium.executablePath = () => "/fake/path/chrome";
  mockChromium.launch = async () => ({
       newContext: async () => ({
           newPage: async () => ({ url: () => "https://example.com" })
       }),
       isConnected: () => true,
       close: async () => {}
  });
  mockExistsSync = (p) => p === "/fake/path/chrome" ? true : originalExistsSync(p);

  const cap = await getBrowserCapability();
  expect(cap.available).toBe(true);
});

test("Capability D - Runtime launch failure", async () => {
  mockChromium.executablePath = () => "/fake/path/chrome";
  mockChromium.launch = async () => { throw new Error("Sandbox restriction"); };
  mockExistsSync = (p) => p === "/fake/path/chrome" ? true : originalExistsSync(p);

  const cap = await getBrowserCapability();
  expect(cap.available).toBe(true);

  const res = await executeBrowserTool({});
  expect(res.success).toBe(false);
  expect(res.error).toContain("Sandbox restriction");
});

test("Capability A - No Playwright module", async () => {
  // We simulate no playwright by making executablePath not a function
  mockChromium.executablePath = undefined;
  
  const cap = await getBrowserCapability();
  expect(cap.available).toBe(false);
  expect(cap.reason).toContain("Playwright runtime unavailable");

  const res = await executeBrowserTool({});
  expect(res.success).toBe(false);
  expect(res.error).toContain("TOOL_UNAVAILABLE: Playwright runtime unavailable");
});


import { afterAll } from "bun:test";
afterAll(() => {
  mock.restore();
});

afterEach(() => {
  mockExistsSync = null;
});
