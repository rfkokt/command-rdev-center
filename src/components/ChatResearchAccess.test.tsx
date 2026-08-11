// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: vi.fn().mockResolvedValue(false), requestPermission: vi.fn(), sendNotification: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./ProjectFilesSidebar", () => ({ default: () => null }));
vi.mock("./FilePicker", () => ({ default: () => null }));

import ChatView from "./ChatView";

Element.prototype.scrollIntoView = vi.fn();
// ConfirmHost (styled confirm) is only mounted in App; in isolation its module-level opener is null,
// so confirm() falls back to window.confirm, which jsdom returns false from. Stub it true so research submit proceeds.
window.confirm = vi.fn(() => true);
const baseProps = { projectPath: "/tmp/demo", projectName: "demo", isGit: false, repositories: [], pipelineType: "Personal", chatId: "chat-one", resumableSessions: [], onSessionFile: vi.fn(), onFirstMessage: vi.fn(), onRuntimeSettings: vi.fn(), onAgentRunning: vi.fn(), onUnread: vi.fn(), onClose: vi.fn(), onToast: vi.fn(), onOpenPipeline: vi.fn(), onOpenResearch: vi.fn(), isActive: true };

function mockBackend(runs: unknown[] = []) {
  let currentRuns = runs;
  invoke.mockImplementation((command: string) => {
    if (command === "get_deep_research_data") return Promise.resolve({ runs: currentRuns, warnings: [] });
    if (command === "get_global_chat_cwd") return Promise.resolve("/tmp/global");
    if (command === "get_graph_status") return Promise.resolve({ state: "fresh", code_stale: false, docs_stale: false });
    if (command === "get_dev_server") return Promise.resolve(null);
    if (command === "start_deep_research") {
      const run = { id: "run-one", query: "Investigate this", state: "creating", partial_report: "", progress: { phase: "creating", activity: "Starting", searches: 0, reads: 0, checks: 0, active_calls: [] }, sources: [] };
      currentRuns = [run];
      return Promise.resolve(run);
    }
    return Promise.resolve({});
  });
}
afterEach(() => { cleanup(); invoke.mockReset(); vi.clearAllMocks(); });

describe.each([["project", false], ["global", true]] as const)("Deep Research in %s chat", (_kind, globalChat) => {
  it("keeps the normal timeline and composer", async () => {
    mockBackend();
    render(<ChatView {...baseProps} globalChat={globalChat} />);
    expect(await screen.findByText("AGENT IDLE. SEND PROMPT.")).toBeInTheDocument();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "research this" } });
    fireEvent.click(screen.getByRole("button", { name: "Deep Research" }));
    expect(screen.getByText("AGENT IDLE. SEND PROMPT.")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("research this");
    expect(screen.queryByLabelText("Research question")).not.toBeInTheDocument();
  });
});

it("routes SEND only through the isolated research command", async () => {
  mockBackend();
  render(<ChatView {...baseProps} />);
  fireEvent.click(screen.getByRole("button", { name: "Deep Research" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Investigate this" } });
  fireEvent.click(screen.getByRole("button", { name: "SEND" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("start_deep_research", { input: expect.objectContaining({ query: "Investigate this", originChatId: "chat-one", originSessionId: "chat-chat-one" }) }));
  expect(screen.getByRole("textbox")).toHaveValue("");
  expect(invoke).not.toHaveBeenCalledWith("send_pi_command", expect.objectContaining({ jsonLine: expect.stringContaining("Investigate this") }));
  expect(await screen.findByText("Deep Research · creating")).toBeInTheDocument();
});

it("shows compact active research and routes full progress to the library", async () => {
  const active = { version: 1, id: "run-one", query: "Question", state: "running", generation: 1, created_at: 1, updated_at: 2, session_id: "research-one", origin_chat_id: "chat-one", origin_session_id: "chat-chat-one", progress: { phase: "searching", activity: "Searching official docs", searches: 2, reads: 1, checks: 0, active_calls: [] }, partial_report: "", sources: [], cancellation_requested: false, resume_count: 0 };
  mockBackend([active]);
  render(<ChatView {...baseProps} />);
  expect(await screen.findByText("Deep Research · searching")).toBeInTheDocument();
  expect(screen.getByText("Searching official docs")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open progress" }));
  expect(baseProps.onOpenResearch).toHaveBeenCalledWith("run-one");
});

it("does not let a stale run from an older exact session block new research", async () => {
  const stale = { version: 1, id: "run-old", query: "Old question", state: "running", generation: 1, created_at: 1, updated_at: 2, session_id: "research-old", origin_chat_id: "chat-one", origin_session_id: "chat-chat-old", progress: { phase: "searching", activity: "Old search", searches: 1, reads: 0, checks: 0, active_calls: [] }, partial_report: "", sources: [], cancellation_requested: false, resume_count: 0 };
  mockBackend([stale]);
  render(<ChatView {...baseProps} />);
  fireEvent.click(screen.getByRole("button", { name: "Deep Research" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "New question" } });
  expect(screen.getByRole("button", { name: "SEND" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "SEND" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("start_deep_research", { input: expect.objectContaining({ query: "New question", originSessionId: "chat-chat-one" }) }));
  expect(screen.queryByText("Old search")).not.toBeInTheDocument();
});

it("preserves image attachments and disables Deep Research until they are removed", async () => {
  mockBackend();
  render(<ChatView {...baseProps} />);
  const input = screen.getByRole("textbox");
  const file = new File(["image"], "example.png", { type: "image/png" });
  fireEvent.paste(input, { clipboardData: { files: [file] } });
  const toggle = await screen.findByRole("button", { name: "Deep Research unavailable while image attachments are present" });
  expect(toggle).toBeDisabled();
  expect(toggle).toHaveAttribute("title", "Remove image attachments before starting Deep Research");
  expect(await screen.findByAltText("Pasted attachment preview")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove image" }));
  expect(screen.getByRole("button", { name: "Deep Research" })).toBeEnabled();
});

it("keeps image-only normal chat messages sendable", async () => {
  mockBackend();
  render(<ChatView {...baseProps} />);
  const input = screen.getByRole("textbox");
  const file = new File(["image"], "example.png", { type: "image/png" });
  fireEvent.paste(input, { clipboardData: { files: [file] } });
  await screen.findByAltText("Pasted attachment preview");
  expect(screen.getByRole("button", { name: "SEND" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "SEND" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("send_pi_command", expect.objectContaining({ jsonLine: expect.stringContaining('"type":"prompt"') })));
  expect(invoke).not.toHaveBeenCalledWith("start_deep_research", expect.anything());
});

it("does not run chat shortcuts in research mode", async () => {
  mockBackend();
  render(<ChatView {...baseProps} />);
  fireEvent.click(screen.getByRole("button", { name: "Deep Research" }));
  fireEvent.keyDown(window, { key: "p", ctrlKey: true });
  expect(invoke.mock.calls.filter(([command, args]) => command === "send_pi_command" && String((args as { jsonLine?: string })?.jsonLine).includes("cycle_model"))).toHaveLength(0);
});
