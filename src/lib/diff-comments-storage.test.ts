// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { loadDiffComments, saveDiffComments } from "./diff-comments";
afterEach(() => localStorage.clear());
test("unsent comments persist per chat and drop malformed rows", () => {
  saveDiffComments("a", [
    { id: "1", path: "x.ts", line: "new:3", text: "fix" },
  ]);
  expect(loadDiffComments("a")).toEqual([
    { id: "1", path: "x.ts", line: "new:3", text: "fix" },
  ]);
  expect(loadDiffComments("b")).toEqual([]);
  localStorage.setItem(
    "kern:diff-comments:c",
    JSON.stringify([{ id: 1 }, null]),
  );
  expect(loadDiffComments("c")).toEqual([]);
  saveDiffComments("a", []);
  expect(localStorage.getItem("kern:diff-comments:a")).toBeNull();
});
