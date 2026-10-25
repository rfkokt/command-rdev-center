import { expect, test } from "vitest";
import { diffLineLocations, formatDiffComments } from "./diff-comments";
test("tracks old/new line numbers in mixed hunks", () => {
  expect(
    diffLineLocations("@@ -10,3 +20,3 @@", [" same", "-old", "+new", " next"]),
  ).toEqual(["new:20", "old:11", "new:21", "new:22"]);
});
test("batches Markdown comments across files with unambiguous locations", () => {
  const text = formatDiffComments([
    { id: "1", path: "a.ts", line: "new:3", text: "Fix **this**" },
    { id: "2", path: "b.ts", line: "old:5", text: "Keep this" },
  ]);
  expect(text).toContain('"path":"a.ts","line":"new:3"');
  expect(text).toContain('"path":"b.ts","line":"old:5"');
  expect(text).toContain("Fix **this**");
});
