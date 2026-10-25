import { expect, test } from "vitest";
import { activeBranchUserEntries, pickEditTarget } from "./SessionTreePanel";

const msg = (
  id: string,
  parentId: string | null,
  role: string,
  content: string,
) => ({
  type: "message",
  id,
  parentId,
  message: { role, content },
});

test("walks the active branch only, oldest first", () => {
  const entries = [
    msg("u1", null, "user", "first"),
    msg("a1", "u1", "assistant", "ok"),
    msg("u2old", "a1", "user", "abandoned branch"),
    msg("u2", "a1", "user", "second"),
    msg("a2", "u2", "assistant", "done"),
  ];
  expect(activeBranchUserEntries(entries, "a2")).toEqual([
    { id: "u1", text: "first" },
    { id: "u2", text: "second" },
  ]);
});

test("matches the shown text inside what the agent received", () => {
  const branch = [
    {
      id: "u1",
      text: "PLAN MODE ...\n\nfix the header\n\n<authoritative_attachments>…",
    },
    { id: "u2", text: "again" },
  ];
  expect(pickEditTarget(branch, ["fix the header", "again"], 0)).toBe("u1");
  expect(pickEditTarget(branch, ["fix the header", "again"], 1)).toBe("u2");
});

test("falls back to position among equal texts when counts differ (compaction)", () => {
  const branch = [
    { id: "u3", text: "retry" },
    { id: "u4", text: "something" },
    { id: "u5", text: "retry" },
  ];
  // The chat shows an extra older message not on the branch.
  const shown = ["older", "retry", "something", "retry"];
  expect(pickEditTarget(branch, shown, 3)).toBe("u5");
  expect(pickEditTarget(branch, shown, 1)).toBe("u3");
  expect(pickEditTarget(branch, shown, 0)).toBeNull();
});
