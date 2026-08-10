import { createSignal, onCleanup, onMount } from "solid-js";
import { TextAttributes } from "@opentui/core";

const BOLD = TextAttributes.BOLD;

interface SpinnerProps {
  text?: string;
}

export function Spinner(props: SpinnerProps) {
  const [frame, setFrame] = createSignal(0);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  let interval: ReturnType<typeof setInterval>;

  onMount(() => {
    interval = setInterval(() => {
      setFrame(prev => (prev + 1) % frames.length);
    }, 100);
  });

  onCleanup(() => {
    clearInterval(interval);
  });

  return (
    <text fg="#d29922">
      {frames[frame()] + " " + (props.text || "")}
    </text>
  );
}
