// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  const liveTable = screen.getByRole("table", { name: "KAI pipeline" });
  expect(liveTable).toBeInTheDocument();
  expect(within(liveTable).getByRole("columnheader", { name: /Deploy/ })).toBeInTheDocument();
  expect(within(liveTable).getByText("running")).toBeInTheDocument();

  const historical = screen.getByRole("table", { name: /KAI pipeline · alternate/ });
  expect(within(historical).getByText("demo-new")).toBeInTheDocument();
  expect(within(historical).getByText("demo-old")).toBeInTheDocument();
});

test("renders unix-second timestamps without Invalid Date", async () => {
  invoke.mockResolvedValue({ current: null, runs: [{ ...live.runs[0], date: "1785480149" }] });
  render(<PipelineView />);

  expect(await screen.findByText("demo-old")).toBeInTheDocument();
  expect(screen.queryByText("Invalid Date")).not.toBeInTheDocument();
});

test("submits only a configured confirm option", async () => {
  invoke.mockResolvedValue({ current: live.current, runs: [], pending_input: { nonce: "nonce", run_id: "live", step_id: "tag", mode: "confirm", step: "Tag", prompt: "Choose increment", options: ["patch", "minor", "major"], execution_cwd: "/projects/demo", initiator_session_id: null } });
  render(<PipelineView projectPath="/projects/demo" />);

  fireEvent.click(await screen.findByRole("button", { name: "patch" }));
  fireEvent.click(screen.getByRole("button", { name: "CONFIRM" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("provide_pipeline_input", { projectPath: "/projects/demo", input: { nonce: "nonce", runId: "live", stepId: "tag", mode: "confirm", sessionId: null, executionCwd: "/projects/demo", value: "patch", message: null, paths: [] } }));
});

test("refreshes immediately after starting and hides duplicate run action", async () => {
  invoke.mockResolvedValueOnce({ current: null, runs: [] }).mockResolvedValueOnce("demo").mockResolvedValueOnce(live);
  render(<PipelineView projectPath="/projects/demo" projectName="demo" />);

  fireEvent.click(await screen.findByRole("button", { name: "RUN demo" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("start_pipeline", { projectPath: "/projects/demo", executionCwd: null, initiatorSessionId: null }));
  expect(await screen.findByText("running")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "RUN demo" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "CANCEL" })).toBeInTheDocument();
});
