import { describe, expect, it } from "bun:test";
import {
  alphaMask,
  createMascotSourceImage,
  decodePng,
  encodePng,
  imageMetadata,
  MASCOT_SOURCE_HEIGHT,
  MASCOT_SOURCE_WIDTH,
  removeConnectedBackground,
  resizeInside,
  rgbaAt,
  trimTransparent,
} from "../mascotAsset";
import { mascotTargetWidth, renderMascotBanner } from "../mascot";



describe("chibi mascot raster pipeline", () => {
  it("loads an explicit source with RGBA metadata", () => {
    const source = createMascotSourceImage();
    expect(imageMetadata(source)).toEqual({
      width: MASCOT_SOURCE_WIDTH,
      height: MASCOT_SOURCE_HEIGHT,
      channels: 4,
      alpha: true,
    });
  });

  it("removes only edge-connected background and keeps enclosed white face pixels", () => {
    const source = createMascotSourceImage();
    const transparent = removeConnectedBackground(source);
    expect(rgbaAt(transparent, 0, 0)[3]).toBe(0);
    const enclosedWhite = Array.from({ length: transparent.height }, (_, y) =>
      Array.from({ length: transparent.width }, (_, x) => rgbaAt(transparent, x, y))
        .find(([r, g, b, a]) => a === 255 && r > 200 && g > 200 && b > 200),
    ).find(Boolean);
    expect(enclosedWhite).toBeDefined();
  });

  it("keeps aspect ratio with nearest-neighbor resize", () => {
    const source = trimTransparent(removeConnectedBackground(createMascotSourceImage()));
    const resized = resizeInside(source, 24);
    expect(resized.width).toBe(24);
    expect(resized.height).toBe(Math.round(source.height * 24 / source.width));
  });

  it("round-trips debug PNGs and produces a useful alpha mask", () => {
    const source = trimTransparent(removeConnectedBackground(createMascotSourceImage()));
    const decoded = decodePng(encodePng(source));
    expect(imageMetadata(decoded)).toEqual(imageMetadata(source));
    const mask = alphaMask(source);
    expect(rgbaAt(mask, 0, 0)[3]).toBe(255);
    expect(rgbaAt(mask, 0, 0)[0]).toBe(rgbaAt(source, 0, 0)[3]);
  });

  it("renders a standing character silhouette at every requested terminal width", () => {
    for (const cols of [40, 50, 60, 80, 120]) {
      const lines = renderMascotBanner(cols, 1200, true);
      expect(lines.some((line) => line.includes("@@"))).toBe(true);
      const spriteRows = Math.ceil((32 * mascotTargetWidth(cols)) / 28);
      expect(lines.length).toBe(Math.ceil(spriteRows / 2) + 2);
      expect(mascotTargetWidth(cols)).toBeGreaterThanOrEqual(20);
      expect(lines.every((line) => line.length <= cols)).toBe(true);
    }
  });
});
