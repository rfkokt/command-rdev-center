import { describe, expect, test } from "vitest";
import { fileLinkRequest, parseFileLink } from "./markdown-links";

describe("local Markdown links", () => {
  test("decodes paths and separates source locations", () => {
    expect(parseFileLink("/repo/My%20File.py:42:3")).toEqual({
      path: "/repo/My File.py",
      line: 42,
    });
    expect(parseFileLink("src/worker.py#L12-L20")).toEqual({
      path: "src/worker.py",
      line: 12,
    });
    expect(parseFileLink("file://localhost/repo/worker.py#L8")).toEqual({
      path: "/repo/worker.py",
      line: 8,
    });
  });
  test.each([
    "https://example.com/a.py",
    "mailto:a@b.com",
    "#part",
    "//example.com/file",
    "javascript:alert(1)",
    "data:text/html,hi",
    "file://remote/a.py",
    "/repo/%00file",
    "/repo/%zz",
  ])("does not treat %s as a local file", (href) => {
    expect(parseFileLink(href)).toBeNull();
  });
  test("resolves links against the active worktree and normalizes parent segments", () => {
    expect(fileLinkRequest({ path: "../worker.py" }, "/repo/src")).toEqual({
      projectPath: "/repo",
      fileName: "worker.py",
    });
    expect(fileLinkRequest({ path: "/other/worker.py" }, "/repo")).toEqual({
      projectPath: "/other",
      fileName: "worker.py",
    });
    expect(() => fileLinkRequest({ path: "worker.py" })).toThrow(
      "project folder",
    );
  });
});
