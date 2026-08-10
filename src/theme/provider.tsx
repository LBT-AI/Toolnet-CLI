import { createContext, useContext, JSX } from "solid-js";

export interface Theme {
  background: string;
  foreground: string;
  primary: string;
  secondary: string;
  accent: string;
  error: string;
  success: string;
  warning: string;
  info: string;
  muted: string;
  border: string;
}

const defaultTheme: Theme = {
  background: "#1a1b1e",
  foreground: "#c1c2c5",
  primary: "#f97815",
  secondary: "#58a6ff",
  accent: "#f97815",
  error: "#f85149",
  success: "#2ea043",
  warning: "#d29922",
  info: "#58a6ff",
  muted: "#5c5f66",
  border: "#373a40",
};

const ThemeContext = createContext<Theme>(defaultTheme);

export function ThemeProvider(props: { children: JSX.Element }) {
  return (
    <ThemeContext.Provider value={defaultTheme}>
      {props.children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
