import fs from "node:fs";
import path from "node:path";
import {
  alphaMask,
  decodePng,
  encodePng,
  imageMetadata,
  loadMascotSourceImage,
  removeConnectedBackground,
  resizeInside,
  trimTransparent,
  type RgbaImage,
} from "../src/banner/mascotAsset";

const outputDir = path.resolve("tmp");
const sourcePath = process.env.TOOLNET_MASCOT_SOURCE;

function save(name: string, image: RgbaImage): void {
  const filePath = path.join(outputDir, name);
  fs.writeFileSync(filePath, encodePng(image));
  const decoded = decodePng(new Uint8Array(fs.readFileSync(filePath)));
  const metadata = imageMetadata(decoded);
  console.log(`${name}: ${JSON.stringify(metadata)}`);
}

function main(): void {
  fs.mkdirSync(outputDir, { recursive: true });
  const original = loadMascotSourceImage(sourcePath);
  const resized = resizeInside(original, 28);
  const trimmed = trimTransparent(removeConnectedBackground(resized));
  const mask = alphaMask(trimmed);

  console.log(`source: ${sourcePath ?? "canonical chibi raster (no external source configured)"}`);
  save("mascot-original.png", original);
  save("mascot-resized.png", resized);
  save("mascot-trimmed.png", trimmed);
  save("mascot-alpha-mask.png", mask);
  console.log(`debug output: ${outputDir}`);
}

main();
