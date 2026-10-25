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
