export const theme = {
  primary: [56, 189, 248],
  accent: [167, 139, 250],
  success: [74, 222, 128],
  warning: [251, 191, 36],
  error: [248, 113, 113],
  text: [226, 232, 240],
  muted: [100, 116, 139],
  border: [51, 65, 85],
} as const;

function rgb(rgb: readonly number[]): string {
  return `38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

function bgRgb(rgb: readonly number[]): string {
  return `48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

export const themeA = {
  primary: `\x1b[${rgb(theme.primary)}`,
  accent: `\x1b[${rgb(theme.accent)}`,
  success: `\x1b[${rgb(theme.success)}`,
  warning: `\x1b[${rgb(theme.warning)}`,
  error: `\x1b[${rgb(theme.error)}`,
  text: `\x1b[${rgb(theme.text)}`,
  muted: `\x1b[${rgb(theme.muted)}`,
  border: `\x1b[${rgb(theme.border)}`,
  bgOverlay: `\x1b[${bgRgb([30, 34, 44])}`,
  bgMuted: `\x1b[${bgRgb([22, 24, 30])}`,
};