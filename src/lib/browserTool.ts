import fs from "node:fs";
import path from "node:path";
import type { ToolResult } from "./codingAgent";

let playwrightModule: any = null;
let activeBrowser: any = null;
let activeContext: any = null;
let activePage: any = null;

async function getPlaywright(): Promise<any> {
  if (playwrightModule) return playwrightModule;
  try {
    // @ts-ignore
    playwrightModule = await import("playwright");
    return playwrightModule;
  } catch {}
  try {
    // @ts-ignore
    playwrightModule = await import("playwright-core");
    return playwrightModule;
  } catch {}
  return null;
}

async function ensurePage(): Promise<{ page: any; error?: string }> {
  const pw = await getPlaywright();
  if (!pw) {
    return {
      page: null,
      error:
        "Playwright is not installed. To enable real browser features (JS rendering, click, fill, screenshot), install Playwright by running:\n  npm install -g playwright\nor\n  npx playwright install chromium"
    };
  }

  try {
    if (!activeBrowser || !activeBrowser.isConnected()) {
      activeBrowser = await pw.chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
      });
      activeContext = await activeBrowser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      });
      activePage = await activeContext.newPage();
    }
    return { page: activePage };
  } catch (err: any) {
    return {
      page: null,
      error: `Failed to launch browser: ${err?.message || String(err)}\nMake sure Chromium binaries are installed via: npx playwright install chromium`
    };
  }
}

export async function executeBrowserTool(args: any): Promise<ToolResult> {
  const action = (args?.action || (args?.url ? "navigate" : "content")).toLowerCase();
  const url = args?.url;
  const selector = args?.selector;
  const text = args?.text;
  const script = args?.script;
  const targetPath = args?.path || `.artifacts/screenshot_${Date.now()}.png`;

  const { page, error } = await ensurePage();
  if (!page) {
    return { success: false, error };
  }

  try {
    if (url && (action === "navigate" || !page.url() || page.url() === "about:blank")) {
      let finalUrl = url;
      if (!finalUrl.startsWith("http://") && !finalUrl.startsWith("https://")) {
        finalUrl = "https://" + finalUrl;
      }
      await page.goto(finalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    }

    if (action === "click") {
      if (!selector) return { success: false, error: "Missing required argument 'selector' for click action" };
      await page.click(selector, { timeout: 10000 });
      await page.waitForTimeout(1000);
    } else if (action === "fill" || action === "type") {
      if (!selector) return { success: false, error: "Missing required argument 'selector' for fill action" };
      await page.fill(selector, text || "", { timeout: 10000 });
    } else if (action === "evaluate" || action === "script") {
      if (!script) return { success: false, error: "Missing required argument 'script' for evaluate action" };
      const evalRes = await page.evaluate(script);
      return {
        success: true,
        data: `=== JS Evaluation Result ===\n${typeof evalRes === "object" ? JSON.stringify(evalRes, null, 2) : String(evalRes)}`
      };
    } else if (action === "screenshot") {
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: targetPath, fullPage: false });
      return {
        success: true,
        data: `Screenshot saved to ${targetPath}\nURL: ${page.url()}\nTitle: ${await page.title()}`
      };
    }

    const pageTitle = await page.title();
    const pageUrl = page.url();
    const pageText = await page.evaluate(() => {
      return document.body ? document.body.innerText.replace(/\s{2,}/g, " ").trim().slice(0, 4000) : "";
    });

    const output = [
      `URL: ${pageUrl}`,
      `Title: ${pageTitle}`,
      `Action: ${action}`,
      ``,
      `=== Rendered Page Text (JS Executed) ===`,
      pageText
    ].join("\n");

    return { success: true, data: output };
  } catch (err: any) {
    return { success: false, error: `Browser action error: ${err?.message || String(err)}` };
  }
}

export async function closeBrowser(): Promise<void> {
  if (activeBrowser) {
    try {
      await activeBrowser.close();
    } catch {}
    activeBrowser = null;
    activeContext = null;
    activePage = null;
  }
}
