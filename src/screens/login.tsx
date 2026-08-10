import { createSignal, For } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { ThemeProvider } from "../theme/provider";
import { login } from "../lib/auth";

const BOLD = TextAttributes.BOLD;

interface LoginScreenProps {
  onLogin: () => void;
}

export function LoginScreen(props: LoginScreenProps) {
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);

  const handleSubmit = async (value: string) => {
    const pw = value.trim();
    if (!pw || loading()) return;

    setLoading(true);
    setError("");

    const result = await login(pw);

    setLoading(false);

    if (result.success) {
      props.onLogin();
    } else {
      setError(result.error || "Login failed");
      setPassword("");
    }
  };

  const handleKeyDown = (event: any) => {
    // No special keys needed on login screen
  };

  return (
    <ThemeProvider>
      <box flexDirection="column" width="100%" height="100%" justifyContent="center" alignItems="center">
        <box flexDirection="column" alignItems="center" marginBottom={2}>
          <text fg="#f97815" attributes={BOLD}>
            {"TOOLNET"}
          </text>
          <text fg="#5c5f66" marginTop={1}>
            {"AI Coding Gateway"}
          </text>
        </box>

        <box flexDirection="column" alignItems="center" width="50%">
          <text fg="#c1c2c5" marginBottom={1}>
            {"Enter password to continue:"}
          </text>

          {error() && (
            <text fg="#f85149" marginBottom={1}>
              {error()}
            </text>
          )}

          <box
            flexDirection="row"
            borderStyle="single"
            borderColor="#373a40"
            paddingLeft={1}
            paddingRight={1}
            width="100%"
          >
            <text fg="#f97815">{"> "}</text>
            <input
              value={password()}
              onInput={(val: string) => setPassword(val)}
              onSubmit={((event: any) => {
                if (event && event.value) handleSubmit(event.value);
              }) as any}
              onKeyDown={handleKeyDown}
              placeholder="Password..."
              width="100%"
            />
          </box>

          {loading() && (
            <text fg="#d29922" marginTop={1}>
              {"Authenticating..."}
            </text>
          )}

          <text fg="#5c5f66" marginTop={1}>
            {"Default: 123456"}
          </text>
        </box>
      </box>
    </ThemeProvider>
  );
}
