import { TextAttributes } from "@opentui/core";

const BOLD = TextAttributes.BOLD;

const LOGO_FULL =
  "██▀▀█ █▀▀ ▀█▀ █▀▀ █▀▀ █▀▀ █▀▀█ █▀▀█ █▀▀█\n" +
  "█▄▄▀ █▀▀  █  ▀▀█ ██▀ █▀▀ █▄▄▀ █▄▄█ █▄▄▀ \n" +
  "▀  ▀ ▀▀▀  ▀  ▀▀▀ ▀▀▀ ▀▀▀ ▀ ▀▀ ▀  ▀ ▀ ▀▀ ";

const LOGO_SMALL = "TOOLNET";

interface LogoProps {
  width?: number;
}

export function Logo(props?: LogoProps) {
  const w = props?.width ?? 80;
  const useFull = w >= 38;

  return (
    <text fg="#f97815" attributes={BOLD}>
      {useFull ? LOGO_FULL : LOGO_SMALL}
    </text>
  );
}
