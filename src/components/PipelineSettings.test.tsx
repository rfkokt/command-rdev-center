// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const invoke = vi.fn();
const listeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (name: string, callback: (event: { payload: unknown }) => void) => { listeners.set(name, callback); return Promise.resolve(() => listeners.delete(name)); } }));

import PipelineSettings, { type PipelineConfig } from "./PipelineSettings";

const config: PipelineConfig = {
  preset: "Custom",
  steps: [{ id: "test", name: "Test", command: "pnpm test", enabled: true, failure_policy: "ai_fix", max_attempts: 3 }],
};

afterEach(() => {
  cleanup();
  invoke.mockReset();
  listeners.clear();
});

test("shows target project and saves edited steps to that project", async () => {
  invoke.mockResolvedValueOnce(config).mockResolvedValueOnce(undefined);
  render(<PipelineSettings projectPath="/projects/demo" projectName="demo" onToast={vi.fn()} />);

  expect(await screen.findByText("demo")).toBeInTheDocument();
  expect(screen.getByText("/projects/demo")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "Test command" }), { target: { value: "pnpm test --run" } });
  fireEvent.click(screen.getByRole("button", { name: "SAVE TO PROJECT" }));

  await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("save_pipeline_config", {
    projectPath: "/projects/demo",
    config: { ...config, preset: "Custom", steps: [{ ...config.steps[0], command: "pnpm test --run" }] },
  }));
});

test("applies a preset then allows disabling and reordering steps", async () => {
  const preset: PipelineConfig = {
    preset: "KAI",
    steps: [
      { id: "build", name: "Build", command: "pnpm build", enabled: true, failure_policy: "ai_fix", max_attempts: 3 },
      { id: "push", name: "Push", command: "git push", enabled: true, failure_policy: "ask_user", max_attempts: 1 },
    ],
  };
  invoke.mockResolvedValueOnce(config).mockResolvedValueOnce(preset);
  render(<PipelineSettings projectPath="/projects/demo" onToast={vi.fn()} />);

  await screen.findByDisplayValue("pnpm test");
  fireEvent.change(screen.getByLabelText("STARTING PRESET"), { target: { value: "KAI" } });
  expect(await screen.findByDisplayValue("pnpm build")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable Build" }));
  expect(screen.getByText("1")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Move Push up" }));
  expect(screen.getAllByPlaceholderText("Step name")[0]).toHaveValue("Push");
});

test("keeps the latest preset when responses resolve out of order", async () => {
  let resolveKai!: (value: PipelineConfig) => void;
  let resolveMbi!: (value: PipelineConfig) => void;
  const kai = new Promise<PipelineConfig>((resolve) => { resolveKai = resolve; });
  const mbi = new Promise<PipelineConfig>((resolve) => { resolveMbi = resolve; });
  invoke.mockResolvedValueOnce(config).mockReturnValueOnce(kai).mockReturnValueOnce(mbi);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<PipelineSettings projectPath="/projects/demo" onToast={vi.fn()} />);

  await screen.findByDisplayValue("pnpm test");
  fireEvent.change(screen.getByLabelText("STARTING PRESET"), { target: { value: "KAI" } });
  fireEvent.change(screen.getByLabelText("STARTING PRESET"), { target: { value: "MBI" } });
  resolveMbi({ preset: "MBI", steps: [{ ...config.steps[0], id: "mbi", command: "mbi command" }] });
  expect(await screen.findByDisplayValue("mbi command")).toBeInTheDocument();
  resolveKai({ preset: "KAI", steps: [{ ...config.steps[0], id: "kai", command: "kai command" }] });
  await Promise.resolve();
  expect(screen.queryByDisplayValue("kai command")).not.toBeInTheDocument();
  vi.restoreAllMocks();
});

test("consultant uses Pi RPC and only applies a reviewed fenced JSON draft", async () => {
  invoke.mockImplementation((command: string) => command === "get_pipeline_config" ? Promise.resolve(config) : Promise.resolve(undefined));
  render(<PipelineSettings projectPath="/projects/demo" projectName="demo" onToast={vi.fn()} />);
  await screen.findByDisplayValue("pnpm test");
  fireEvent.click(screen.getByRole("button", { name: /CONSULT AI/ }));

  await waitFor(() => expect(invoke).toHaveBeenCalledWith("spawn_pi_rpc", expect.objectContaining({ cwd: "/projects/demo", noSession: true, tools: ["read", "grep", "find", "ls"] })));
  expect(screen.queryByRole("button", { name: "APPLY TO FORM" })).not.toBeInTheDocument();
  const draft = { preset: "Custom", steps: [{ ...config.steps[0], command: "pnpm test --run" }] };
  const text = `Recommendation\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\``;
  const spawn = invoke.mock.calls.find(([command]) => command === "spawn_pi_rpc")?.[1] as { sessionId: string };
  listeners.get("pi-rpc-event")?.({ payload: { session_id: spawn.sessionId, raw: JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } }) } });
  listeners.get("pi-rpc-event")?.({ payload: { session_id: spawn.sessionId, raw: JSON.stringify({ type: "agent_settled" }) } });

  expect(await screen.findByText("pnpm test --run")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "APPLY TO FORM" }));
  expect(screen.getByDisplayValue("pnpm test --run")).toBeInTheDocument();
  expect(invoke).not.toHaveBeenCalledWith("save_pipeline_config", expect.anything());
});

test("rejects invalid typed consultant drafts", async () => {
  invoke.mockImplementation((command: string) => command === "get_pipeline_config" ? Promise.resolve(config) : Promise.resolve(undefined));
  render(<PipelineSettings projectPath="/projects/demo" onToast={vi.fn()} />);
  await screen.findByDisplayValue("pnpm test");
  fireEvent.click(screen.getByRole("button", { name: /CONSULT AI/ }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("spawn_pi_rpc", expect.anything()));
  const spawn = invoke.mock.calls.find(([command]) => command === "spawn_pi_rpc")?.[1] as { sessionId: string };
  const invalid = { preset: "Custom", steps: [{ id: "x", name: "X", command: "echo x", enabled: "yes", failure_policy: "ai_fix", max_attempts: 3 }] };
  const text = `\`\`\`json\n${JSON.stringify(invalid)}\n\`\`\``;
  listeners.get("pi-rpc-event")?.({ payload: { session_id: spawn.sessionId, raw: JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } }) } });
  listeners.get("pi-rpc-event")?.({ payload: { session_id: spawn.sessionId, raw: JSON.stringify({ type: "agent_settled" }) } });
  expect(screen.queryByRole("button", { name: "APPLY TO FORM" })).not.toBeInTheDocument();
});

test("project switch kills consultant and ignores stale startup", async () => {
  let resolveSpawn!: () => void;
  invoke.mockImplementation((command: string) => command === "get_pipeline_config" ? Promise.resolve(config) : command === "spawn_pi_rpc" ? new Promise<void>((resolve) => { resolveSpawn = resolve; }) : Promise.resolve(undefined));
  const view = render(<PipelineSettings projectPath="/projects/one" onToast={vi.fn()} />);
  await screen.findByDisplayValue("pnpm test");
  fireEvent.click(screen.getByRole("button", { name: /CONSULT AI/ }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("spawn_pi_rpc", expect.anything()));
  const oldId = (invoke.mock.calls.find(([command]) => command === "spawn_pi_rpc")?.[1] as { sessionId: string }).sessionId;
  view.rerender(<PipelineSettings projectPath="/projects/two" onToast={vi.fn()} />);
  resolveSpawn();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("kill_pi_session", { sessionId: oldId }));
  expect(screen.queryByRole("dialog", { name: "AI pipeline consultant" })).not.toBeInTheDocument();
});
