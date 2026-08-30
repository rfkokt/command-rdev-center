// @vitest-environment jsdom
import { beforeEach, expect, test } from "vitest";
import {
  APPEARANCE_KEY,
  COLOR_THEME_KEY,
  applyAppearance,
  applyColorTheme,
  readAppearance,
  readColorTheme,
  resolveAppearance,
} from "./theme";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-color-theme");
  document.documentElement.style.colorScheme = "";
});

test("defaults to system and resolves the current OS appearance", () => {
  expect(readAppearance()).toBe("system");
  expect(resolveAppearance("system", false)).toBe("light");
  expect(resolveAppearance("system", true)).toBe("dark");
});

test("reads only supported explicit preferences", () => {
  localStorage.setItem(APPEARANCE_KEY, "dark");
  expect(readAppearance()).toBe("dark");
  localStorage.setItem(APPEARANCE_KEY, "unsupported");
  expect(readAppearance()).toBe("system");
});

test("applies the resolved theme and native color scheme", () => {
  expect(applyAppearance("light", true)).toBe("light");
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(document.documentElement.style.colorScheme).toBe("light");
});

test("defaults to the classic color theme and accepts Kern", () => {
  expect(readColorTheme()).toBe("classic");
  localStorage.setItem(COLOR_THEME_KEY, "kern");
  expect(readColorTheme()).toBe("kern");
  localStorage.setItem(COLOR_THEME_KEY, "unsupported");
  expect(readColorTheme()).toBe("classic");
});

test("applies the color theme independently from appearance", () => {
  expect(applyColorTheme("kern")).toBe("kern");
  expect(document.documentElement.dataset.colorTheme).toBe("kern");
  expect(document.documentElement.dataset.theme).toBeUndefined();
});
