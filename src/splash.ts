import { printToolNetBanner } from "./toolnet-banner";

export { printToolNetBanner };

export async function playSplashAnimation(): Promise<void> {
  await printToolNetBanner();
}
