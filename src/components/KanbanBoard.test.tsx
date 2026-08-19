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

test("renders Google Sheets tasks as read-only without blocking local tasks", async () => {
  invoke.mockResolvedValueOnce([
    { project: "sheet", read_only: true, tasks: [{ no: 1, deskripsi: "Sheet task", status: "Review" }] },
    { project: "broken", read_only: true, error: "sheet unavailable", tasks: [] },
    { project: "local", tasks: [{ no: 2, deskripsi: "Local task", status: "Backlog" }] },
  ]);

  render(<KanbanBoard />);
  expect(await screen.findByText("Sheet task")).toBeInTheDocument();
  expect(screen.getByText("Local task")).toBeInTheDocument();
  expect(screen.getByText(/sheet unavailable/)).toBeInTheDocument();
  expect(screen.getByText("READ ONLY")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Status" })).toHaveLength(1);
});

test("opens the full task text in an accessible detail dialog", async () => {
  const detail = "Long task title\n- First requirement\n- Second requirement\n\ncurl https://example.com";
  invoke.mockResolvedValueOnce([{ project: "alpha", read_only: true, tasks: [{ no: 1, deskripsi: detail, pic: "Rifky", status: "To Do" }] }]);

  render(<KanbanBoard projectName="alpha" />);
  fireEvent.click(await screen.findByRole("button", { name: /Open task 1/ }));

  expect(screen.getByRole("dialog", { name: "Task detail" })).toHaveTextContent("First requirement");
  expect(screen.getByRole("dialog", { name: "Task detail" })).toHaveTextContent("curl https://example.com");
  fireEvent.click(screen.getByRole("button", { name: "Close task detail" }));
  expect(screen.queryByRole("dialog", { name: "Task detail" })).not.toBeInTheDocument();
});

test("scopes tasks to the selected project", async () => {
  invoke.mockResolvedValueOnce([
    { project: "alpha", tasks: [{ no: 1, deskripsi: "Alpha task", status: "Backlog" }] },
    { project: "beta", tasks: [{ no: 2, deskripsi: "Beta task", status: "Backlog" }] },
  ]);

  render(<KanbanBoard projectName="alpha" />);
  expect(await screen.findByText("Alpha task")).toBeInTheDocument();
  expect(screen.queryByText("Beta task")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Project" })).not.toBeInTheDocument();
});

test("renders spreadsheet statuses as separate columns", async () => {
  invoke.mockResolvedValueOnce([{ project: "sheet", read_only: true, tasks: [
    { no: 1, deskripsi: "Pending task", status: "Pending" },
    { no: 2, deskripsi: "Todo task", status: "To Do" },
    { no: 3, deskripsi: "Testing task", status: "Testing" },
  ] }]);

  render(<KanbanBoard />);
  expect(await screen.findByText("Pending task")).toBeInTheDocument();
  expect(screen.getByText("Todo task")).toBeInTheDocument();
  expect(screen.getByText("Testing task")).toBeInTheDocument();
  expect(screen.getByText("Pending", { selector: ".kanban-column > header strong" })).toBeInTheDocument();
  expect(screen.getByText("To Do", { selector: ".kanban-column > header strong" })).toBeInTheDocument();
  expect(screen.getByText("Testing", { selector: ".kanban-column > header strong" })).toBeInTheDocument();
});

test("groups local statuses case-insensitively, filters, and writes canonical status", async () => {
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

  fireEvent.click(screen.getByRole("button", { name: "Status" }));
  fireEvent.click(screen.getByRole("option", { name: "Done" }));
  await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("update_kanban_task_status", {
    project: "alpha",
    taskNo: 1,
    status: "Done",
  }));
});
