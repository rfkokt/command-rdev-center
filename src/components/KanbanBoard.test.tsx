// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import KanbanBoard from "./KanbanBoard";

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

test("groups statuses case-insensitively, filters, and writes canonical status", async () => {
  invoke.mockResolvedValue([]).mockResolvedValueOnce([
    { project: "alpha", tasks: [{ no: 1, deskripsi: "Ship alpha", pic: "Rifki", status: "backlog" }] },
    { project: "beta", tasks: [{ no: 2, deskripsi: "Review beta", pic: "Agent", status: "REVIEW" }] },
  ]).mockResolvedValueOnce(undefined);

  render(<KanbanBoard />);
  expect(await screen.findByText("Ship alpha")).toBeInTheDocument();
  expect(screen.getByText("Review beta")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Project" }));
  fireEvent.click(screen.getByRole("option", { name: "alpha" }));
  expect(screen.queryByText("Review beta")).not.toBeInTheDocument();

  fireEvent.change(screen.getByRole("combobox", { name: "Status for task 1" }), { target: { value: "Done" } });
  await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("update_kanban_task_status", {
    project: "alpha",
    taskNo: 1,
    status: "Done",
  }));
});
