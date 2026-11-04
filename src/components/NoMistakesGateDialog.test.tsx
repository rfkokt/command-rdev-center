// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NoMistakesGateDialog from "./NoMistakesGateDialog";
import type { NoMistakesGate } from "../lib/no-mistakes-gate";

afterEach(cleanup);

const gate: NoMistakesGate = {
  step: "review",
  findings: [
    {
      id: "r1",
      severity: "warning",
      file: "a.go",
      line: "",
      action: "auto-fix",
      description: "Ignored error",
    },
    {
      id: "r2",
      severity: "error",
      file: "main.go",
      line: "42",
      action: "ask-user",
      description: "New --force flag bypasses the confirm prompt",
    },
    {
      id: "r3",
      severity: "info",
      file: "b.ts",
      line: "",
      action: "ask-user",
      description: "Badge is always visible",
    },
  ],
};

describe("NoMistakesGateDialog", () => {
  it("shows only ask-user findings verbatim", () => {
    render(
      <NoMistakesGateDialog
        gate={gate}
        onDecide={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText("2 findings need your decision")).toBeVisible();
    expect(
      screen.getByText("New --force flag bypasses the confirm prompt"),
    ).toBeVisible();
    expect(screen.getByText("main.go:42")).toBeVisible();
    expect(screen.queryByText("Ignored error")).toBeNull();
  });

  it("fixes the selected findings with guidance", () => {
    const onDecide = vi.fn();
    render(
      <NoMistakesGateDialog
        gate={gate}
        onDecide={onDecide}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Require a TTY" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Fix selected/ }));
    expect(onDecide).toHaveBeenCalledWith({
      action: "fix",
      findingIds: ["r2"],
      instructions: "Require a TTY",
    });
  });

  it("disables fix with nothing selected and supports approve, skip, later", () => {
    const onDecide = vi.fn();
    const onDismiss = vi.fn();
    render(
      <NoMistakesGateDialog
        gate={gate}
        onDecide={onDecide}
        onDismiss={onDismiss}
      />,
    );
    screen.getAllByRole("checkbox").forEach((box) => fireEvent.click(box));
    expect(screen.getByRole("button", { name: /Fix selected/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Approve as is" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip step" }));
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(onDecide).toHaveBeenNthCalledWith(1, { action: "approve" });
    expect(onDecide).toHaveBeenNthCalledWith(2, { action: "skip" });
    expect(onDismiss).toHaveBeenCalled();
  });
});
