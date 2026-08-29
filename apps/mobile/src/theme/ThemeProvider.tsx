import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { accentOptions, color } from "./tokens";

export interface Theme {
  colors: typeof color & { accent: string };
  accent: string;
  setAccent: (hex: string) => void;
}

const ThemeContext = createContext<Theme | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [accent, setAccent] = useState<string>(accentOptions[0]);
  const value = useMemo<Theme>(
    () => ({ colors: { ...color, accent }, accent, setAccent }),
    [accent],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const t = useContext(ThemeContext);
  if (!t) throw new Error("useTheme must be used within ThemeProvider");
  return t;
}
