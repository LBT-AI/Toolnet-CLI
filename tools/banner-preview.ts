import { renderMascotBanner, mascotBannerMetrics, MASCOT_TIMELINE } from "../src/banner/mascot";
import { imageMetadata, loadMascotSourceImage, removeConnectedBackground, resizeInside, trimTransparent } from "../src/banner/mascotAsset";
import { renderB2Banner } from "../src/banner/b2Banner";
import { visibleWidth } from "../src/tui/layout";

const TERMINAL_WIDTHS = [120, 80, 60, 50, 40] as const;

function printFrame(label: string, lines: string[], cols: number): void {
  const width = Math.max(0, ...lines.map((line) => visibleWidth(line.trimEnd())));
  process.stdout.write(`\n${label} · ${cols} cols · ${width}x${lines.length}\n`);
  for (const line of lines) {
    if (visibleWidth(line) > cols) throw new Error(`banner overflow at ${cols} columns`);
    process.stdout.write(line + "\n");
  }
}

function printStaticVariants(): void {
  process.stdout.write("\n=== TOOLNET MASCOT — STATIC PREVIEW ===\n");
  process.stdout.write("Pixel mascot: materialize · blink · gesture · pulse · sparkle · idle\n");
  for (const cols of TERMINAL_WIDTHS) {
    printFrame("COLOR", renderMascotBanner(cols, MASCOT_TIMELINE.final, false), cols);
  }
  printFrame("NO_COLOR", renderMascotBanner(40, MASCOT_TIMELINE.final, true), 40);
}

function printAnimationCheckpoints(): void {
  process.stdout.write("\n=== TOOLNET MASCOT — ANIMATION CHECKPOINTS ===\n");
  for (const elapsed of [0, 260, 460, 650, 820, 1040, 1200]) {
    printFrame(`T+${elapsed}ms`, renderMascotBanner(80, elapsed, true), 80);
  }
}

function printFallbackPreview(): void {
  process.stdout.write("\n=== B2 FALLBACK — STATIC REFERENCE ===\n");
  printFrame("B2", renderB2Banner(50, 1200, true), 50);
}

function printEvaluation(): void {
  process.stdout.write("\n=== EVALUATION ===\n");
  process.stdout.write("Production winner: Animated Pixel Mascot\n");
  process.stdout.write("Recognizability: strong — a compact face/body silhouette remains readable without color.\n");
  process.stdout.write("Uniqueness: strong — the mascot is a brand character, not a generic text logo.\n");
  process.stdout.write("Premium feel: restrained — cyan/blue structure, violet used only for core and sparkles.\n");
  process.stdout.write("Mobile: strong — 40-column output stays inside the viewport with no crop.\n");
  process.stdout.write("Animation potential: strong — materialize, blink, gesture, pulse and sparkle each have discrete phases.\n");
  for (const cols of TERMINAL_WIDTHS) {
    const metrics = mascotBannerMetrics(cols);
    process.stdout.write(`Metrics ${cols}: ${metrics.width}x${metrics.height}\n`);
  }
  process.stdout.write("B2 Twin Portal remains an internal fallback for TOOLNETCLI_MASCOT=0 or undersized terminals.\n");
}

function main(): void {
  const source = loadMascotSourceImage();
  const resized = resizeInside(source, 28);
  const trimmed = trimTransparent(removeConnectedBackground(resized));
  process.stdout.write(`\n=== MASCOT SOURCE ===\n${JSON.stringify(imageMetadata(source))} -> resized ${JSON.stringify(imageMetadata(resized))} -> trimmed ${JSON.stringify(imageMetadata(trimmed))}\n`);
  printStaticVariants();
  printAnimationCheckpoints();
  printFallbackPreview();
  printEvaluation();
}

main();
