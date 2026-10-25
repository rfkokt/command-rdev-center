// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createRef } from "react";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import ExpandedDiffPanel from "./ExpandedDiffPanel";
afterEach(cleanup);
test("clicks a diff line to add a located comment and manages pending batch", () => {
  const add = vi.fn(),
    remove = vi.fn(),
    send = vi.fn();
  render(
    <ExpandedDiffPanel
      diffKey="a.ts"
      worktreeDiff={{
        merge_base: "main",
        files: [
          {
            path: "a.ts",
            status: "M",
            added: 1,
            removed: 1,
            patch:
              "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
          },
        ],
      }}
      position={{ x: 0, y: 0 }}
      dialogRef={createRef()}
      onPositionChange={vi.fn()}
      onClose={vi.fn()}
      worktreePath="/repo"
      onToast={vi.fn()}
      comments={[{ id: "c", path: "b.ts", line: "new:4", text: "Existing" }]}
      onComment={add}
      onRemoveComment={remove}
      onSendComments={send}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Comment on a.ts new:1" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Diff comment" }), {
    target: { value: "Fix this" },
  });
  fireEvent.click(screen.getByText("Add comment"));
  expect(add).toHaveBeenCalledWith("a.ts", "new:1", "Fix this");
  fireEvent.click(
    screen.getByRole("button", { name: "Remove comment b.ts new:4" }),
  );
  expect(remove).toHaveBeenCalledWith("c");
  fireEvent.click(screen.getByText("Send 1 review comments"));
  expect(send).toHaveBeenCalledOnce();
});
