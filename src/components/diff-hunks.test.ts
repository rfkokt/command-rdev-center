import { describe, expect, test } from "vitest";
import { buildHunkPatch, flattenHunks, parseDiffSections } from "./diff-hunks";

test("preserves header-like content inside a hunk", () => {
  const patch = [
    "diff --git a/doc.md b/doc.md",
    "--- a/doc.md",
    "+++ b/doc.md",
    "@@ -1 +1 @@",
    "--- old separator",
    "+++ new separator",
    "",
  ].join("\n");
  const [section] = parseDiffSections(patch);
  expect(section.hunks[0].lines).toEqual([
    "--- old separator",
    "+++ new separator",
  ]);
  expect(buildHunkPatch(section.fileHeader, section.hunks[0])).toBe(patch);
});

const SINGLE = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
@@ -10,2 +10,3 @@
 ten
 eleven
+twelve
`;

const CONCATENATED = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
 one
-two
+TWO
diff --git a/src/a.ts b/src/a.ts
index 2222222..3333333 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -5,2 +5,2 @@
 five
-six
+SIX
`;

describe("parseDiffSections", () => {
  test("parses one section with two hunks", () => {
    const sections = parseDiffSections(SINGLE);
    expect(sections).toHaveLength(1);
    const [section] = sections;
    expect(section.fileHeader).toEqual([
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
    ]);
    expect(section.hunks).toHaveLength(2);
    expect(section.hunks[0].id).toBe("s0h0");
    expect(section.hunks[0].header).toBe("@@ -1,3 +1,3 @@");
    expect(section.hunks[0].lines).toEqual([" one", "-two", "+TWO", " three"]);
    expect(section.hunks[1].id).toBe("s0h1");
    expect(section.hunks[1].lines).toEqual([" ten", " eleven", "+twelve"]);
  });

  test("splits concatenated diffs into separate sections", () => {
    const sections = parseDiffSections(CONCATENATED);
    expect(sections).toHaveLength(2);
    expect(sections[0].hunks).toHaveLength(1);
    expect(sections[1].hunks).toHaveLength(1);
    expect(sections[1].hunks[0].id).toBe("s1h0");
    expect(sections[1].hunks[0].lines).toEqual([" five", "-six", "+SIX"]);
  });

  test("keeps the no-newline marker inside the hunk", () => {
    const sections = parseDiffSections(
      "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n",
    );
    expect(sections[0].hunks[0].lines).toEqual([
      "-old",
      "+new",
      "\\ No newline at end of file",
    ]);
  });

  test("returns empty for empty patches", () => {
    expect(parseDiffSections("")).toEqual([]);
    expect(parseDiffSections("\n")).toEqual([]);
  });
});

describe("buildHunkPatch", () => {
  test("rebuilds a standalone single-hunk patch", () => {
    const [section] = parseDiffSections(SINGLE);
    const patch = buildHunkPatch(section.fileHeader, section.hunks[1]);
    expect(patch).toBe(`diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,2 +10,3 @@
 ten
 eleven
+twelve
`);
  });

  test("each hunk of a concatenated diff builds an independent patch", () => {
    const sections = parseDiffSections(CONCATENATED);
    const first = buildHunkPatch(sections[0].fileHeader, sections[0].hunks[0]);
    const second = buildHunkPatch(sections[1].fileHeader, sections[1].hunks[0]);
    expect(first).toContain("@@ -1,2 +1,2 @@");
    expect(first).not.toContain("@@ -5,2 +5,2 @@");
    expect(second).toContain("@@ -5,2 +5,2 @@");
    expect(second).not.toContain("@@ -1,2 +1,2 @@");
  });
});

describe("flattenHunks", () => {
  test("flattens sections preserving ids", () => {
    const flat = flattenHunks(parseDiffSections(CONCATENATED));
    expect(flat.map((entry) => entry.hunk.id)).toEqual(["s0h0", "s1h0"]);
    expect(flat[1].fileHeader[0]).toBe("diff --git a/src/a.ts b/src/a.ts");
  });
});
