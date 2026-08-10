import { TextAttributes } from "@opentui/core";
import { exitTui } from "./exit";

const BOLD = TextAttributes.BOLD;

export function App() {
  return (
    <box flexDirection="column" width="100%" height="100%">
      <text fg="#f97815" attributes={BOLD}>TOOLNET</text>
      <text fg="#c1c2c5">Hello World</text>
    </box>
  );
}
