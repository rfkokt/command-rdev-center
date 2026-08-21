// @vitest-environment jsdom
import { beforeEach, expect, test } from "vitest";
import { APPEARANCE_KEY, applyAppearance, readAppearance, resolveAppearance } from "./theme";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
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
