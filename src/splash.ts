import { printMascotBanner } from "./banner/mascot";

export { printMascotBanner };

/** Backward-compatible splash API; production startup owns lifecycle. */
export async function playSplashAnimation(): Promise<void> {
  await printMascotBanner();
}
