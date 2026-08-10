const ESC = '\x1b';
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;

const COLOR = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  cyan: `${ESC}[38;2;148;226;213m`,
  peach: `${ESC}[38;2;250;179;135m`,
  green: `${ESC}[38;2;166;227;161m`,
  subtext: `${ESC}[38;2;166;173;200m`,
  blue: `${ESC}[38;2;137;180;250m`,
};

const TOOLNET_LOGO = [
  "  _______          _            _   ",
  " |__   __|        | |          | |  ",
  "    | | ___   ___ | | _ __   ___| |_ ",
  "    | |/ _ \\ / _ \\| || '_ \\ / _ \\ __|",
  "    | | (_) | (_) | || | | |  __/ |_ ",
  "    |_|\\___/ \\___/|_||_| |_|\\___|\\__|"
];

const MASCOT_FRAMES = [
  [
    "  /\\_/\\  ",
    " ( o.o ) ",
    "  > ^ <  "
  ],
  [
    "  /\\_/\\  ",
    " ( -.- ) ",
    "  > ^ <  "
  ]
];

const BOOT_MESSAGES = [
  "[OK] Loading Core...",
  "[OK] Initializing Modules...",
  "[OK] Establishing Connection...",
  "[OK] Ready."
];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function moveCursor(row: number, col: number): string {
  return `${ESC}[${Math.max(1, Math.floor(row))};${Math.max(1, Math.floor(col))}H`;
}

export async function playSplashAnimation(): Promise<void> {
  process.stdout.write(HIDE_CURSOR);

  const frames = 30;
  const logoStartRow = 2;
  const mascotStartRow = logoStartRow + TOOLNET_LOGO.length + 2;
  const bootStartRow = mascotStartRow + MASCOT_FRAMES[0].length + 2;

  let logoRevealedLines = 0;
  let bootRevealed = 0;

  for (let f = 0; f < frames; f++) {
    let frameBuffer = CLEAR_SCREEN;

    // Reveal logo
    if (f % 2 === 0 && logoRevealedLines < TOOLNET_LOGO.length) {
      logoRevealedLines++;
    }
    for (let i = 0; i < logoRevealedLines; i++) {
      frameBuffer += moveCursor(logoStartRow + i, 5) + COLOR.bold + COLOR.cyan + TOOLNET_LOGO[i] + COLOR.reset;
    }

    // Animate mascot
    if (f >= 5) {
      // Blink every 10 frames, else keep eyes open
      const mascotFrame = (f % 10 === 0) ? MASCOT_FRAMES[1] : MASCOT_FRAMES[0];
      const offset = Math.sin(f * 0.5); // Float up and down smoothly
      for (let j = 0; j < mascotFrame.length; j++) {
        frameBuffer += moveCursor(mascotStartRow + j + offset, 15) + COLOR.peach + mascotFrame[j] + COLOR.reset;
      }
    }

    // Boot sequence
    if (f >= 10 && f % 4 === 0 && bootRevealed < BOOT_MESSAGES.length) {
      bootRevealed++;
    }
    for (let k = 0; k < bootRevealed; k++) {
      const msg = BOOT_MESSAGES[k];
      const coloredMsg = msg.replace("[OK]", COLOR.green + "[OK]" + COLOR.reset + COLOR.subtext) + COLOR.reset;
      frameBuffer += moveCursor(bootStartRow + k, 5) + coloredMsg;
    }

    process.stdout.write(frameBuffer);
    await sleep(100);
  }

  // Wait a moment at the end to display the fully loaded screen
  await sleep(500);

  // Clean up
  process.stdout.write(CLEAR_SCREEN);
  process.stdout.write(SHOW_CURSOR);
}
