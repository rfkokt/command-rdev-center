export const APPEARANCE_KEY = "crc-appearance";
export const COLOR_THEME_KEY = "crc-color-theme";
export type Appearance = "system" | "light" | "dark";
export type ColorTheme = "classic" | "kern";

export function readAppearance(storage: Pick<Storage, "getItem"> = localStorage): Appearance {
  const value = storage.getItem(APPEARANCE_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

export function readColorTheme(storage: Pick<Storage, "getItem"> = localStorage): ColorTheme {
  return storage.getItem(COLOR_THEME_KEY) === "kern" ? "kern" : "classic";
}

export function resolveAppearance(preference: Appearance, systemDark: boolean): "light" | "dark" {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

export function applyAppearance(preference: Appearance, systemDark: boolean, root: HTMLElement = document.documentElement) {
  const resolved = resolveAppearance(preference, systemDark);
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  return resolved;
}

export function applyColorTheme(theme: ColorTheme, root: HTMLElement = document.documentElement) {
  root.dataset.colorTheme = theme;
  return theme;
}
