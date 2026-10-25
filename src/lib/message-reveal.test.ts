// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import {
  findMatchIndex,
  requestReveal,
  REVEAL_EVENT,
  takeReveal,
} from "./message-reveal";

test("a reveal waits for its chat and is taken once", () => {
  const seen = vi.fn();
  window.addEventListener(REVEAL_EVENT, seen);
  requestReveal("chat-a", "needle");
  expect(seen).toHaveBeenCalledOnce();
  expect(takeReveal("chat-b")).toBeNull();
  expect(takeReveal("chat-a")).toBe("needle");
  expect(takeReveal("chat-a")).toBeNull();
  window.removeEventListener(REVEAL_EVENT, seen);
});

test("matches case-insensitively and skips non-message rows", () => {
  expect(
    findMatchIndex(
      [null, "Hello", "the Needle here", "needle again"],
      "NEEDLE",
    ),
  ).toBe(2);
  expect(findMatchIndex(["a", "b"], "zzz")).toBe(-1);
  expect(findMatchIndex(["a"], "  ")).toBe(-1);
});
