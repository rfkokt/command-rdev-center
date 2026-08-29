import { describe, expect, it } from "vitest";
import { groupScmFiles } from "./scm-utils";

describe("groupScmFiles", () => {
  it("separates staged, unstaged, and untracked states", () => {
    const groups = groupScmFiles([
      { path: "staged", indexStatus: "M", worktreeStatus: " " },
      { path: "changed", indexStatus: " ", worktreeStatus: "M" },
      { path: "new", indexStatus: "?", worktreeStatus: "?" },
    ]);
    expect(groups.staged.map((file) => file.path)).toEqual(["staged"]);
    expect(groups.unstaged.map((file) => file.path)).toEqual(["changed"]);
    expect(groups.untracked.map((file) => file.path)).toEqual(["new"]);
  });
});
