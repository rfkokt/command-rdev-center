// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import ChatSessionActions from "./ChatSessionActions";
afterEach(cleanup);
test("rename is trimmed and pin/archive only update metadata", () => {
  const change = vi.fn();
  render(<ChatSessionActions chat={{ title: "Old" }} onChange={change} />);
  fireEvent.click(screen.getByText("Rename"));
  fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), {
    target: { value: " New " },
  });
  fireEvent.click(screen.getByText("Save name"));
  expect(change).toHaveBeenCalledWith({ title: "New" });
  fireEvent.click(screen.getByText("Pin"));
  expect(change).toHaveBeenCalledWith({ pinned: true });
  fireEvent.click(screen.getByText("Archive"));
  expect(change).toHaveBeenCalledWith({ archived: true });
});
test("archived and pinned sessions can be restored", () => {
  const change = vi.fn();
  render(
    <ChatSessionActions
      chat={{ pinned: true, archived: true }}
      onChange={change}
    />,
  );
  fireEvent.click(screen.getByText("Unarchive"));
  expect(change).toHaveBeenCalledWith({ archived: false });
  fireEvent.click(screen.getByText("Unpin"));
  expect(change).toHaveBeenCalledWith({ pinned: false });
});
