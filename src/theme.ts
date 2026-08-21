export const APPEARANCE_KEY = "crc-appearance";
export type Appearance = "system" | "light" | "dark";

export function readAppearance(storage: Pick<Storage, "getItem"> = localStorage): Appearance {
  const value = storage.getItem(APPEARANCE_KEY);
  return value === "light" || value === "dark" ? value : "system";
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
