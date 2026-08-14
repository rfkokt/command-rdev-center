// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { confirm, ConfirmHost } from "./ConfirmDialog";

afterEach(() => { cleanup(); });

describe("ConfirmHost", () => {
  it("resolves true on confirm click and unmounts", async () => {
    render(<ConfirmHost />);
    const promise = confirm({ message: "Are you sure?", confirmLabel: "Yes" });
    await waitFor(() => expect(screen.getByText("Are you sure?")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Yes/ }));
    expect(await promise).toBe(true);
    expect(screen.queryByText("Are you sure?")).not.toBeInTheDocument();
  });

  it("unmounts before resolving a confirmed action", async () => {
    render(<ConfirmHost />);
    let modalPresentWhenResolved = true;
    const promise = confirm({ message: "Build graph?", confirmLabel: "Build" }).then(() => {
      modalPresentWhenResolved = Boolean(screen.queryByText("Build graph?"));
    });
    fireEvent.click(await screen.findByRole("button", { name: /Build/ }));
    expect(screen.queryByText("Build graph?")).not.toBeInTheDocument();
    await promise;
    expect(modalPresentWhenResolved).toBe(false);
  });

  it("resolves false on cancel click", async () => {
    render(<ConfirmHost />);
    const promise = confirm({ message: "Discard?", cancelLabel: "Nope" });
    fireEvent.click(await screen.findByRole("button", { name: /Nope/ }));
    expect(await promise).toBe(false);
  });

  it("renders a danger marker for destructive actions", async () => {
    render(<ConfirmHost />);
    confirm({ message: "Delete?", danger: true });
    expect(await screen.findByText("CONFIRM · CAUTION")).toBeInTheDocument();
  });
});
