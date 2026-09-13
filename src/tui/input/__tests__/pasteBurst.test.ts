import { describe, expect, it } from "bun:test";
import {
  DEFAULT_PASTE_BURST_GAP_MS,
  DEFAULT_PASTE_BURST_MIN_CHARS,
  PasteBurstDetector,
} from "../pasteBurst";

/** White-box twin of the e2e paste-normalization suite for the burst machine. */
describe("PasteBurstDetector", () => {
  it("coalesces a rapid multi-chunk burst into a single paste chunk", () => {
    const detector = new PasteBurstDetector();
    detector.accept("cons", 0);
    detector.accept("tella", DEFAULT_PASTE_BURST_GAP_MS - 1);
    detector.accept("tion", 2 * (DEFAULT_PASTE_BURST_GAP_MS - 1));
    const chunks = detector.flush();

    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe("paste");
    expect(chunks[0].content).toBe("constellation");
  });

  it("replays isolated keystrokes as plain text", () => {
    const detector = new PasteBurstDetector();
    const emitted = [
      ...detector.accept("h", 0),
      // A far-later keystroke finalizes the "h" group immediately…
      ...detector.accept("i", 10_000),
      // …and flush() emits the trailing group.
      ...detector.flush(),
    ];

    expect(emitted.every((c) => c.type === "text")).toBe(true);
    expect(emitted.map((c) => c.content)).toEqual(["h", "i"]);
  });

  it("emits ordinary text (not paste) when the burst is below the size threshold", () => {
    const detector = new PasteBurstDetector();
    detector.accept("ok", 0);
    detector.accept("ay", DEFAULT_PASTE_BURST_GAP_MS - 1);
    const chunks = detector.flush();

    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe("text");
    expect(chunks[0].content).toBe("okay");
  });

  it("never flags a single chunk as a paste regardless of size", () => {
    const detector = new PasteBurstDetector();
    detector.accept("x".repeat(DEFAULT_PASTE_BURST_MIN_CHARS * 10), 0);
    const chunks = detector.flush();

    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe("text");
  });

  it("splits into separate emissions when the gap exceeds the window", () => {
    const detector = new PasteBurstDetector();
    const emitted = [
      ...detector.accept("first", 0),
      ...detector.accept("second", DEFAULT_PASTE_BURST_GAP_MS + 1),
      ...detector.flush(),
    ];

    expect(emitted).toHaveLength(2);
    expect(emitted[0].content).toBe("first");
    expect(emitted[1].content).toBe("second");
  });

  it("ignores empty chunks and reset() clears buffered state", () => {
    const detector = new PasteBurstDetector();
    detector.accept("", 0);
    detector.accept("abc", 1);
    detector.reset();
    expect(detector.flush()).toEqual([]);
  });

  it("multibyte content survives coalescing byte-identical", () => {
    const detector = new PasteBurstDetector();
    const intro = "こんにちは、ターミナルです。"; // 14 chars ≥ burst threshold
    detector.accept(intro, 0);
    detector.accept("作業を始めます。", DEFAULT_PASTE_BURST_GAP_MS - 1);
    const [chunk] = detector.flush();

    expect(chunk.type).toBe("paste");
    expect(chunk.content).toBe(intro + "作業を始めます。");
  });
});
