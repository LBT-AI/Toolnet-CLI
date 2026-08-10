#!/usr/bin/env bun

process.env.OTUI_NO_NATIVE_RENDER = "true";

export async function main() {
  try {
    const { render } = await import("@opentui/solid");
    const { App } = await import("./app");
    await render(() => <App />, {
      exitOnCtrlC: false,
    });
  } catch {
    throw new Error("TUI render failed");
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("TUI error:", err);
    process.exit(1);
  });
}
