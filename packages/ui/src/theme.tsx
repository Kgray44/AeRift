import { createContext, useContext, type CSSProperties, type ReactNode } from "react";

export type ColorScheme = "system" | "light" | "dark";
export type Preference = "system" | "increase";
export type Reduction = "system" | "reduce";
export type ThemeToken = `--ae-${string}`;
export type ThemeOverrides = Partial<Record<ThemeToken, string | number>>;

export interface Theme {
  readonly id: string;
  readonly label: string;
  /** Selectors for a theme can set both light and dark tokens. Instance overrides are optional. */
  readonly overrides?: Readonly<ThemeOverrides>;
}

export const glassTheme: Theme = Object.freeze({ id: "glass", label: "GLASS" });

export function createThemeRegistry(themes: readonly Theme[] = [glassTheme]): ReadonlyMap<string, Theme> {
  const registry = new Map<string, Theme>();
  for (const theme of themes) {
    if (!/^[a-z][a-z0-9-]*$/.test(theme.id) || registry.has(theme.id)) {
      throw new Error(`Invalid or duplicate AeRift theme: ${theme.id}`);
    }
    registry.set(theme.id, Object.freeze({ ...theme, overrides: Object.freeze({ ...theme.overrides }) }));
  }
  if (!registry.has(glassTheme.id)) {
    registry.set(glassTheme.id, glassTheme);
  }
  return registry;
}

const builtInThemes = createThemeRegistry();
const ThemeContext = createContext<Theme>(glassTheme);

export interface ThemeProviderProps {
  children: ReactNode;
  registry?: ReadonlyMap<string, Theme>;
  theme?: string;
  scheme?: ColorScheme;
  contrast?: Preference;
  transparency?: Reduction;
  motion?: Reduction;
  overrides?: ThemeOverrides;
}

export function ThemeProvider({
  children, registry = builtInThemes, theme = "glass", scheme = "system",
  contrast = "system", transparency = "system", motion = "system", overrides,
}: ThemeProviderProps) {
  const selected = registry.get(theme) ?? glassTheme;
  const style: CSSProperties & ThemeOverrides = { ...selected.overrides, ...overrides };
  return (
    <ThemeContext.Provider value={selected}>
      <div className="ae-theme" data-ae-theme={selected.id} data-scheme={scheme}
        data-contrast={contrast} data-transparency={transparency} data-motion={motion} style={style}>
        {children}
      </div>
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
