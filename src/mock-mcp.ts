#!/usr/bin/env bun
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

function send(msg: any) {
  console.error("[mock-mcp] Sending response:", JSON.stringify(msg));
  process.stdout.write(JSON.stringify(msg) + "\n");
}

rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const req = JSON.parse(trimmed);
    if (!req || typeof req !== "object") return;

    console.error("[mock-mcp] Received request:", req);

    const { id, method, params } = req;

    // Handle notifications (no id)
    if (id === undefined || id === null) {
      if (method === "notifications/initialized") {
        console.error("[mock-mcp] Initialized notification received");
      }
      return;
    }

    switch (method) {
      case "initialize":
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params?.protocolVersion || "2024-11-05",
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: "mock-mcp-server",
              version: "1.0.0",
            },
          },
        });
        break;

      case "ping":
        send({
          jsonrpc: "2.0",
          id,
          result: {},
        });
        break;

      case "tools/list":
        send({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "get_weather",
                description: "Get current weather information for a specified location.",
                inputSchema: {
                  type: "object",
                  properties: {
                    location: {
                      type: "string",
                      description: "City or location name",
                    },
                  },
                  required: ["location"],
                },
              },
            ],
          },
        });
        break;

      case "tools/call":
        if (params?.name === "get_weather") {
          const args = params?.arguments || {};
          const location = args.location || "Unknown";
          send({
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    location,
                    temperature: "72°F",
                    condition: "Sunny",
                  }),
                },
              ],
            },
          });
        } else {
          send({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Unknown tool: ${params?.name}`,
            },
          });
        }
        break;

      default:
        send({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        });
        break;
    }
  } catch (err: any) {
    console.error("[mock-mcp] Error processing line:", err);
  }
});

rl.on("close", () => {
  console.error("[mock-mcp] Stdin closed, exiting.");
  process.exit(0);
});
