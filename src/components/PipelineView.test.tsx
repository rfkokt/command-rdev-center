// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const invoke = vi.fn(() => Promise.resolve({
  current: { run_id: "live", project: "demo", project_type: "KAI", date: "2026-02-02T00:00:00Z", status: "running", stages: [{ name: "Deploy", status: "running" }] },
  runs: [
    { run_id: "old", project: "demo-old", project_type: "KAI", date: "2026-01-01T00:00:00Z", status: "pass", stages: [{ name: "Test", status: "pass", ms: 1000 }] },
    { run_id: "new", project: "demo-new", project_type: "KAI", date: "2026-02-01T00:00:00Z", status: "pass", stages: [{ name: "Test", status: "pass", ms: 3000 }] },
  ],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => invoke() }));

import PipelineView from "./PipelineView";

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
});

test("renders live and dynamic stages with averages and newest runs first", async () => {
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
