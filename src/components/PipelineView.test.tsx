// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import PipelineView from "./PipelineView";

const live = {
  current: { run_id: "live", project: "demo", project_type: "KAI", date: "2026-02-02T00:00:00Z", status: "running", stages: [{ name: "Deploy", status: "running" }] },
  runs: [
    { run_id: "old", project: "demo-old", project_type: "KAI", date: "2026-01-01T00:00:00Z", status: "pass", stages: [{ name: "Test", status: "pass", ms: 1000 }] },
    { run_id: "new", project: "demo-new", project_type: "KAI", date: "2026-02-01T00:00:00Z", status: "pass", stages: [{ name: "Test", status: "pass", ms: 3000 }] },
  ],
};

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  invoke.mockReset();
});

test("renders live and dynamic stages with averages and newest runs first", async () => {
  invoke.mockResolvedValue(live);
  render(<PipelineView />);

  expect(await screen.findByText("AVG 2s")).toBeInTheDocument();
  expect(screen.getByRole("table", { name: "KAI pipeline" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: /Deploy/ })).toBeInTheDocument();
  expect(screen.getByText("running")).toBeInTheDocument();

  const rows = screen.getAllByRole("row").slice(1);
  expect(rows[0]).toHaveTextContent("running");
  expect(rows[1]).toHaveTextContent("demo-new");
  expect(rows[2]).toHaveTextContent("demo-old");
});

test("renders unix-second timestamps without Invalid Date", async () => {
  invoke.mockResolvedValue({ current: null, runs: [{ ...live.runs[0], date: "1785480149" }] });
  render(<PipelineView />);

  expect(await screen.findByText("demo-old")).toBeInTheDocument();
  expect(screen.queryByText("Invalid Date")).not.toBeInTheDocument();
});

test("refreshes immediately after starting and hides duplicate run action", async () => {
  invoke.mockResolvedValueOnce({ current: null, runs: [] }).mockResolvedValueOnce("demo").mockResolvedValueOnce(live);
  render(<PipelineView projectPath="/projects/demo" projectName="demo" />);

  fireEvent.click(await screen.findByRole("button", { name: "RUN demo" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("start_pipeline", { projectPath: "/projects/demo", executionCwd: null }));
  expect(await screen.findByText("running")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "RUN demo" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "CANCEL" })).toBeInTheDocument();
});
