// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import ChatSessionActions from "./ChatSessionActions";
afterEach(cleanup);
test("rename is trimmed and pin/archive only update metadata", () => {
  const change = vi.fn();
  render(<ChatSessionActions chat={{ title: "Old" }} onChange={change} />);
  fireEvent.click(screen.getByLabelText("Session actions for Old"));
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
  fireEvent.click(
    screen.getByLabelText("Session actions for Untitled session"),
  );
  fireEvent.click(screen.getByText("Unarchive"));
  expect(change).toHaveBeenCalledWith({ archived: false });
  fireEvent.click(screen.getByText("Unpin"));
  expect(change).toHaveBeenCalledWith({ pinned: false });
});

test("session menu escapes clipped rows and dismisses with Escape or an outside click", () => {
  const { container } = render(
    <div style={{ overflow: "hidden" }}>
      <ChatSessionActions chat={{ title: "Clipped" }} onChange={vi.fn()} />
    </div>,
  );
  const trigger = screen.getByLabelText("Session actions for Clipped");
  fireEvent.click(trigger);
  const menu = screen.getByText("Rename").parentElement!;
  expect(menu.parentElement).toBe(document.body);
  expect(container.contains(menu)).toBe(false);
  fireEvent.click(screen.getByText("Rename"));
  expect(screen.getByRole("textbox", { name: "Session name" })).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByText("Rename")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByText("Rename")).toBeNull();
});
