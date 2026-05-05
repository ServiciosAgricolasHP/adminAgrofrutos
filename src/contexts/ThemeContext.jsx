import { createContext, useContext, useEffect, useState } from "react";

const ThemeContext = createContext(null);
const STORAGE_KEY = "af.theme";

export const THEMES = [
  { key: "light", label: "Light", isDark: false },
  { key: "dark", label: "Dark", isDark: true },
  { key: "donDiego", label: "Don Diego", isDark: true },
  { key: "sheridan", label: "Sheridan", isDark: true },
  { key: "aetiskViolet", label: "Aetisk Violet", isDark: false },
  { key: "aetiskPastel", label: "Aetisk Pastel", isDark: false },
];

const VALID = new Set(THEMES.map((t) => t.key));
const KEYS = THEMES.map((t) => `theme-${t.key}`);

function detectInitial() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && VALID.has(saved)) return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(detectInitial);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove(...KEYS);
    root.classList.add(`theme-${theme}`);
    const isDark = THEMES.find((t) => t.key === theme)?.isDark;
    root.classList.toggle("dark", !!isDark);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, themes: THEMES }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
