import { GatewayClient } from "./gateway";
import { getMergedAgentTools, executeTool } from "./agentTools";
import { evaluatePermission, getSandboxMode } from "./permissions";
import { getCwdInfo } from "./codingAgent";
import { getCliKey } from "./keys";
import { DEFAULT_CONFIG } from "./config";

export interface NonInteractiveOptions {
  prompt: string;
  json?: boolean;
  verbose?: boolean;
  model?: string;
}

export async function runNonInteractive(options: NonInteractiveOptions): Promise<void> {
  const { prompt, json = false, verbose = false, model = "openai/gpt-4o" } = options;
  const cwd = getCwdInfo().currentCwd;

  if (verbose) {
    process.env.TOOLNET_DEBUG = "1";
  }

  const gatewayUrl = process.env.TOOLNET_GATEWAY_URL || DEFAULT_CONFIG.baseUrl;
  const gw = new GatewayClient(gatewayUrl);

  const providerStr = model.includes("/") ? model.split("/")[0] : model;
  let localKey = getCliKey(providerStr) || getCliKey("toolnet") || getCliKey("gateway") || getCliKey("default");

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (localKey) headers["Authorization"] = `Bearer ${localKey}`;

  const messages: any[] = [
    { role: "system", content: "You are ToolNet API CLI non-interactive agent. Complete the user request using available tools and output the final result." },
    { role: "user", content: prompt }
  ];

  let finalOutput = "";
  let success = true;
  let loopCount = 0;
  const maxLoops = 10;

  try {
    while (loopCount < maxLoops) {
      loopCount++;
      const payload = {
        model,
        messages,
        tools: getMergedAgentTools(),
        tool_choice: "auto",
        stream: false
      };

      const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gateway HTTP ${res.status}: ${errText}`);
      }

      const data: any = await res.json();
      const choice = data.choices?.[0];
      if (!choice) throw new Error("No response choice returned from model gateway.");

      const assistantMsg = choice.message;
      messages.push(assistantMsg);

      if (assistantMsg.content) {
        finalOutput += assistantMsg.content + "\n";
      }

      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        break;
      }

      for (const tc of assistantMsg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}

        const perm = evaluatePermission(tc.function.name, args, getSandboxMode(), cwd);
        if (!perm.allowed) {
          messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify({ error: `Blocked by sandbox: ${perm.reason}` }) });
          continue;
        }

        const toolResStr = await executeTool(tc.function.name, args);
        messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: toolResStr });
      }
    }
  } catch (err: any) {
    success = false;
    finalOutput = err?.message || String(err);
  }

  if (json) {
    console.log(JSON.stringify({
      success,
      prompt,
      model,
      output: finalOutput.trim(),
      turns: loopCount
    }, null, 2));
  } else {
    if (success) {
      console.log(finalOutput.trim());
    } else {
      console.error(`\x1b[31mError:\x1b[0m ${finalOutput}`);
    }
  }

  process.exit(success ? 0 : 1);
}
