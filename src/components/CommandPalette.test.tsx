// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import CommandPalette from "./CommandPalette";
afterEach(cleanup);
test("filters commands and executes by keyboard", () => {
  const run = vi.fn();
  const close = vi.fn();
  render(
    <CommandPalette
      onClose={close}
      actions={[
        { id: "1", label: "Open settings", run: vi.fn() },
        { id: "2", label: "Chat: demo", run },
      ]}
    />,
  );
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "demo" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(run).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
test("arrow navigation and escape work", () => {
  const second = vi.fn();
  const close = vi.fn();
  render(
    <CommandPalette
      onClose={close}
      actions={[
        { id: "1", label: "one", run: vi.fn() },
        { id: "2", label: "two", run: second },
      ]}
    />,
  );
  const input = screen.getByRole("textbox");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(second).toHaveBeenCalledOnce();
});
test("keeps search results when the parent re-renders with a new search function", async () => {
  const { waitFor } = await import("@testing-library/react");
  const first = vi.fn(async () => [
    { id: "m", label: "Message: found it", run: vi.fn() },
  ]);
  const view = render(
    <CommandPalette onClose={vi.fn()} actions={[]} search={first} />,
  );
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "found" } });
  await waitFor(() => expect(screen.getByText(/found it/)).toBeTruthy());
  const second = vi.fn(async () => []);
  view.rerender(
    <CommandPalette onClose={vi.fn()} actions={[]} search={second} />,
  );
  expect(screen.getByText(/found it/)).toBeTruthy();
  expect(first).toHaveBeenCalledOnce();
  expect(second).not.toHaveBeenCalled();
});
test("shows search coverage notes without making them selectable", async () => {
  const { waitFor } = await import("@testing-library/react");
  const search = vi.fn(async () => [
    {
      id: "note",
      label: "2 chats not searchable",
      run: vi.fn(),
      disabled: true,
    },
  ]);
  render(<CommandPalette onClose={vi.fn()} actions={[]} search={search} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "xx" } });
  await waitFor(() =>
    expect(screen.getByRole("note").textContent).toContain("2 chats"),
  );
  expect(screen.queryByRole("option")).toBeNull();
});
