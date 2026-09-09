import fs from "node:fs";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface ImageMetadata {
  width: number;
  height: number;
  channels: 4;
  alpha: boolean;
}

export type MascotPixel = "b" | "s" | "f" | "d" | "h" | "k" | "y" | ".";

export const MASCOT_SOURCE_WIDTH = 28;
export const MASCOT_SOURCE_HEIGHT = 32;

/** Canonical source art: a 28x32 chibi, not a terminal-width approximation. */
const RAW_MASCOT: string[] = [
  "          bbbbbbbb          ",
  "        bbbbbbbbbbbb        ",
  "      bbbbbbbbbbbbbbbb      ",
  "    bbbbbbbbbbbbbbbbbbbb    ",
  "   bbbbbssssssssssssbbbbb   ",
  "  bbbbssssssssssssssssbbbb  ",
  "  bbbfffffffffffffffffffbbb  ",
  " bbbfffffffffffffffffffffbbb ",
  " bbbfffddffffffffffddfffbbb ",
  " bbbfffffffffffffffffffffbbb ",
  " bbbfffffffffkfffffffffffbbb ",
  "  bbbfffffffffffffffffffbbb  ",
  "  bbbbssssssssssssssssbbbb  ",
  "   bbbbbbbbbbbbbbbbbbbbbb   ",
  "      bbbbssssbbbb          ",
  "      bbbbssssbbbb          ",
  "    bbbbssssssssbbbb        ",
  "   bbbbbbssssbbbbbb         ",
  "  hhbbbssssssssbbbbhh       ",
  " hhhbbbssssssssbbbbhhh      ",
  "hhh  bbbssssbbbb  hhh      ",
  "hh   bbbssssbbbb   hh      ",
  "      bbbffffbbb            ",
  "      bbbffffbbb            ",
  "     bbbbffffbbbb           ",
  "     bbbbffffbbbb           ",
  "     bbbb    bbbb           ",
  "     bbbb    bbbb           ",
  "     bbbb    bbbb           ",
  "    bbbbb    bbbbb          ",
  "   bbbbbb    bbbbbb         ",
  "   bbbbbb    bbbbbb         ",
];

function centerRow(value: string): string {
  // The source declaration is intentionally human-readable; spaces are
  // background, never an unclassified sprite color.
  let clipped = value.replaceAll(" ", ".");
  if (clipped.length > MASCOT_SOURCE_WIDTH) {
    const start = Math.floor((clipped.length - MASCOT_SOURCE_WIDTH) / 2);
    clipped = clipped.slice(start, start + MASCOT_SOURCE_WIDTH);
  }
  return clipped.padEnd(MASCOT_SOURCE_WIDTH, ".").slice(0, MASCOT_SOURCE_WIDTH);
}

export const MASCOT_SOURCE_ROWS: readonly string[] = RAW_MASCOT.map(centerRow);

const COLORS: Record<Exclude<MascotPixel, ".">, [number, number, number]> = {
  b: [56, 189, 248],
  s: [30, 58, 95],
  f: [226, 232, 240],
  d: [7, 26, 47],
  h: [125, 211, 252],
  k: [167, 139, 250],
  y: [253, 224, 71],
};

function setPixel(image: RgbaImage, x: number, y: number, rgba: [number, number, number, number]): void {
  const offset = (y * image.width + x) * 4;
  image.data[offset] = rgba[0];
  image.data[offset + 1] = rgba[1];
  image.data[offset + 2] = rgba[2];
  image.data[offset + 3] = rgba[3];
}

function getPixel(image: RgbaImage, x: number, y: number): [number, number, number, number] {
  const offset = (y * image.width + x) * 4;
  return [image.data[offset] ?? 0, image.data[offset + 1] ?? 0, image.data[offset + 2] ?? 0, image.data[offset + 3] ?? 0];
}

/** Build the canonical source image with a white background for pipeline debugging. */
export function createMascotSourceImage(): RgbaImage {
  const image: RgbaImage = {
    width: MASCOT_SOURCE_WIDTH,
    height: MASCOT_SOURCE_HEIGHT,
    data: new Uint8Array(MASCOT_SOURCE_WIDTH * MASCOT_SOURCE_HEIGHT * 4),
  };
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) setPixel(image, x, y, [255, 255, 255, 255]);
  }
  for (let y = 0; y < MASCOT_SOURCE_ROWS.length; y++) {
    for (let x = 0; x < MASCOT_SOURCE_ROWS[y].length; x++) {
      const pixel = MASCOT_SOURCE_ROWS[y][x] as MascotPixel;
      if (pixel === ".") continue;
      const [r, g, b] = COLORS[pixel];
      setPixel(image, x, y, [r, g, b, 255]);
    }
  }
  return image;
}

/** Load an external PNG when explicitly supplied, otherwise load the canonical source. */
export function loadMascotSourceImage(sourcePath = process.env.TOOLNET_MASCOT_SOURCE): RgbaImage {
  if (!sourcePath) return createMascotSourceImage();
  if (!fs.existsSync(sourcePath)) throw new Error(`Mascot source image not found: ${sourcePath}`);
  return decodePng(new Uint8Array(fs.readFileSync(sourcePath)));
}

function isNearWhite(pixel: [number, number, number, number]): boolean {
  return pixel[3] > 0 && pixel[0] >= 245 && pixel[1] >= 245 && pixel[2] >= 245;
}

/** Remove only white background connected to an edge; enclosed white face stays opaque. */
export function removeConnectedBackground(source: RgbaImage): RgbaImage {
  const output: RgbaImage = { width: source.width, height: source.height, data: new Uint8Array(source.data) };
  const visited = new Uint8Array(source.width * source.height);
  const queue: Array<[number, number]> = [];
  const enqueue = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= source.width || y >= source.height) return;
    const index = y * source.width + x;
    if (visited[index] || !isNearWhite(getPixel(source, x, y))) return;
    visited[index] = 1;
    queue.push([x, y]);
  };

  for (let x = 0; x < source.width; x++) {
    enqueue(x, 0);
    enqueue(x, source.height - 1);
  }
  for (let y = 0; y < source.height; y++) {
    enqueue(0, y);
    enqueue(source.width - 1, y);
  }

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const [x, y] = queue[cursor];
    setPixel(output, x, y, [0, 0, 0, 0]);
    enqueue(x - 1, y);
    enqueue(x + 1, y);
    enqueue(x, y - 1);
    enqueue(x, y + 1);
  }
  return output;
}

export function trimTransparent(source: RgbaImage): RgbaImage {
  let left = source.width;
  let top = source.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      if (getPixel(source, x, y)[3] === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) return { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]) };
  const output: RgbaImage = { width: right - left + 1, height: bottom - top + 1, data: new Uint8Array((right - left + 1) * (bottom - top + 1) * 4) };
  for (let y = 0; y < output.height; y++) {
    for (let x = 0; x < output.width; x++) setPixel(output, x, y, getPixel(source, left + x, top + y));
  }
  return output;
}

/** Aspect-ratio-preserving nearest-neighbor resize. */
export function resizeInside(source: RgbaImage, targetWidth: number): RgbaImage {
  const width = Math.max(1, Math.min(Math.round(targetWidth), source.width));
  const height = Math.max(1, Math.round(source.height * (width / source.width)));
  const output: RgbaImage = { width, height, data: new Uint8Array(width * height * 4) };
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(source.height - 1, Math.floor((y * source.height) / height));
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(source.width - 1, Math.floor((x * source.width) / width));
      setPixel(output, x, y, getPixel(source, sourceX, sourceY));
    }
  }
  return output;
}

export function imageMetadata(image: RgbaImage): ImageMetadata {
  return { width: image.width, height: image.height, channels: 4, alpha: true };
}

export function rgbaAt(image: RgbaImage, x: number, y: number): [number, number, number, number] {
  return getPixel(image, x, y);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const result = new Uint8Array(12 + data.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.length);
  result.set(typeBytes, 4);
  result.set(data, 8);
  view.setUint32(8 + data.length, crc32(result.slice(4, 8 + data.length)));
  return result;
}

export function encodePng(image: RgbaImage): Uint8Array {
  const scanlines = new Uint8Array(image.height * (1 + image.width * 4));
  for (let y = 0; y < image.height; y++) {
    const rowOffset = y * (1 + image.width * 4);
    scanlines[rowOffset] = 0;
    scanlines.set(image.data.slice(y * image.width * 4, (y + 1) * image.width * 4), rowOffset + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, image.width);
  view.setUint32(4, image.height);
  header[8] = 8;
  header[9] = 6;
  const compressed = new Uint8Array(deflateSync(scanlines));
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = chunk("IHDR", header);
  const idat = chunk("IDAT", compressed);
  const iend = chunk("IEND", new Uint8Array());
  const output = new Uint8Array(signature.length + ihdr.length + idat.length + iend.length);
  let offset = 0;
  output.set(signature, offset); offset += signature.length;
  output.set(ihdr, offset); offset += ihdr.length;
  output.set(idat, offset); offset += idat.length;
  output.set(iend, offset);
  return output;
}

export function writePng(filePath: string, image: RgbaImage): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, encodePng(image));
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  const signature = "\x89PNG\r\n\x1a\n";
  const actual = String.fromCharCode(...bytes.slice(0, 8));
  if (actual !== signature) throw new Error("Not a PNG file");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  while (offset < bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
    const length = view.getUint32(0);
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    const data = bytes.slice(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = header.getUint32(0);
      height = header.getUint32(4);
      if (data[8] !== 8 || (data[9] !== 6 && data[9] !== 2)) throw new Error("Only 8-bit RGB/RGBA PNG is supported");
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  const raw = new Uint8Array(inflateSync(Buffer.concat(idat.map((part) => Buffer.from(part)))));
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const output: RgbaImage = { width, height, data: new Uint8Array(width * height * 4) };
  let input = 0;
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[input++];
    const row = raw.slice(input, input + stride); input += stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels] ?? 0 : 0;
      const up = previous[x] ?? 0;
      const upLeft = x >= channels ? previous[x - channels] ?? 0 : 0;
      if (filter === 1) row[x] = ((row[x] ?? 0) + left) & 255;
      else if (filter === 2) row[x] = ((row[x] ?? 0) + up) & 255;
      else if (filter === 3) row[x] = ((row[x] ?? 0) + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        row[x] = ((row[x] ?? 0) + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 255;
      } else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}`);
    }
    for (let x = 0; x < width; x++) {
      const source = x * channels;
      setPixel(output, x, y, [row[source] ?? 0, row[source + 1] ?? 0, row[source + 2] ?? 0, channels === 4 ? row[source + 3] ?? 0 : 255]);
    }
    previous = row;
  }
  return output;
}

export function alphaMask(source: RgbaImage): RgbaImage {
  const output: RgbaImage = { width: source.width, height: source.height, data: new Uint8Array(source.width * source.height * 4) };
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const alpha = getPixel(source, x, y)[3];
      setPixel(output, x, y, [alpha, alpha, alpha, 255]);
    }
  }
  return output;
}

export const mascotColors = COLORS;
