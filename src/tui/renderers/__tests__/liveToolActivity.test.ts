import { expect, test, describe } from "bun:test";
import { ActiveToolActivity } from "../../state";
import { renderActiveToolActivity, renderToolActivities } from "../chatRenderer";

function stripAnsiSafe(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

describe("Live Tool Activity Appearance", () => {
  test("long silent fetch case", () => {
    const cols = 80;
    
    const activity: ActiveToolActivity = {
      callId: "fetch-1",
      name: "web_fetch",
      args: { url: "https://example.com" },
      category: "read",
      actionLabel: "Fetch",
      target: "https://example.com",
      startedAt: 0, 
      elapsedMs: 0,
      status: "running",
      tail: []
    };

    activity.elapsedMs = 0;
    const frame0 = renderActiveToolActivity(activity, cols).map(stripAnsiSafe);

    activity.elapsedMs = 5000;
    const frame5 = renderActiveToolActivity(activity, cols).map(stripAnsiSafe);

    activity.elapsedMs = 10000;
    const frame10 = renderActiveToolActivity(activity, cols).map(stripAnsiSafe);

    activity.elapsedMs = 16000;
    const frame16 = renderActiveToolActivity(activity, cols).map(stripAnsiSafe);

    // Phase 2.2: the static `●` became the canonical animated spinner.
    // The row now paints the CURRENT SPINNER frame (frame 0 by default in a
    // fresh state) and the elapsed seconds keep ticking.
    expect(frame0[0]).toContain("Fetch https://example.com");
    expect(frame0[0]).toContain("0s");
    expect(frame0[0]).not.toContain("●");

    expect(frame5[0]).toContain("Fetch https://example.com");
    expect(frame5[0]).toContain("5s");

    expect(frame16[0]).toContain("Fetch https://example.com");
    expect(frame16[0]).toContain("16s");
  });

  test("progress-emitting tool case", () => {
    const cols = 80;
    const activity: ActiveToolActivity = {
      callId: "fetch-2",
      name: "web_fetch",
      args: { url: "https://example.com" },
      category: "read",
      actionLabel: "Fetch",
      target: "https://example.com",
      startedAt: 0, 
      elapsedMs: 0,
      status: "running",
      tail: []
    };

    activity.elapsedMs = 1000;
    activity.tail = ["Connecting to example.com..."];
    const frame1 = renderActiveToolActivity(activity, cols).map(stripAnsiSafe);

    activity.elapsedMs = 2000;
    activity.tail = ["Downloading payload..."];
    const frame2 = renderActiveToolActivity(activity, cols).map(stripAnsiSafe);

    expect(frame1.length).toBe(2);
    expect(frame1[1]).toContain("Connecting to example.com...");

    expect(frame2.length).toBe(2);
    expect(frame2[1]).toContain("Downloading payload...");
  });

  test("multiple active tools control", () => {
    const cols = 80;
    
    const activities: ActiveToolActivity[] = [
      {
        callId: "call-A",
        name: "web_fetch",
        args: { url: "https://example.com/A" },
        category: "read",
        actionLabel: "Fetch",
        target: "https://example.com/A",
        startedAt: 0,
        elapsedMs: 5000,
        status: "running",
        tail: ["Reading A"]
      },
      {
        callId: "call-B",
        name: "read_file",
        args: { path: "docs/readme.md" },
        category: "read",
        actionLabel: "Read",
        target: "docs/readme.md",
        startedAt: 2000,
        elapsedMs: 3000,
        status: "running",
        tail: ["Reading B"]
      }
    ];

    const frame = renderToolActivities(activities, cols).map(stripAnsiSafe);
    
    expect(frame.length).toBe(2);
    expect(frame[0]).toContain("Fetch https://example.com/A");
    expect(frame[0]).toContain("5s");
    expect(frame[1]).toContain("Read docs/readme.md");
    expect(frame[1]).toContain("3s");
  });
});
