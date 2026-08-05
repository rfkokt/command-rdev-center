// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: vi.fn().mockResolvedValue(false), requestPermission: vi.fn(), sendNotification: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./ProjectFilesSidebar", () => ({ default: () => null }));
vi.mock("./FilePicker", () => ({ default: () => null }));

import ChatView from "./ChatView";

Element.prototype.scrollIntoView = vi.fn();

const baseProps = {
  projectPath: "/tmp/demo",
  projectName: "demo",
  isGit: false,
  repositories: [],
  pipelineType: "Personal",
  chatId: "chat-one",
  resumableSessions: [],
  onSessionFile: vi.fn(),
  onFirstMessage: vi.fn(),
  onRuntimeSettings: vi.fn(),
  onAgentRunning: vi.fn(),
  onUnread: vi.fn(),
  onClose: vi.fn(),
  onToast: vi.fn(),
  onOpenPipeline: vi.fn(),
  isActive: true,
};

function mockBackend(globalChat = false) {
  invoke.mockImplementation((command: string) => {
    if (command === "get_deep_research_data") return Promise.resolve({ runs: [], warnings: [] });
    if (command === "get_global_chat_cwd") return Promise.resolve("/tmp/global");
    if (command === "get_graph_status") return Promise.resolve({ state: "fresh", code_stale: false, docs_stale: false });
    if (command === "get_dev_server") return Promise.resolve(null);
    if (command === "spawn_pi_rpc") return Promise.resolve({});
    if (command === "send_pi_command") return Promise.resolve({});
    if (command === "get_rag_context") return Promise.resolve("");
    if (globalChat) return Promise.resolve({});
    return Promise.resolve({});
  });
}

afterEach(() => { cleanup(); invoke.mockReset(); vi.clearAllMocks(); });

describe.each([
  ["project", false],
  ["global", true],
] as const)("Deep Research in %s chat", (_kind, globalChat) => {
  it("is available without replacing the chat process and preserves the chat draft", async () => {
    mockBackend(globalChat);
    render(<ChatView {...baseProps} globalChat={globalChat} />);

    const chatInput = await screen.findByRole("textbox");
    fireEvent.change(chatInput, { target: { value: "keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Deep Research" }));

    expect(await screen.findByText("Global · Web only")).toBeInTheDocument();
    expect(screen.getByText(/No project or file access/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /RELOAD PI/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.getByRole("textbox")).toHaveValue("keep this draft");

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("spawn_pi_rpc", expect.objectContaining({ sessionId: "chat-chat-one" })));
    expect(invoke).not.toHaveBeenCalledWith("start_deep_research", expect.anything());
  });
});

it("leaves chat shortcuts and backward tab navigation inactive in research mode", async () => {
  mockBackend(false);
  render(<ChatView {...baseProps} />);
  fireEvent.click(screen.getByRole("button", { name: "Deep Research" }));

  const shiftTab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true });
  window.dispatchEvent(shiftTab);
  fireEvent.keyDown(window, { key: "p", ctrlKey: true });
  fireEvent.keyDown(window, { key: "l", ctrlKey: true });

  expect(shiftTab.defaultPrevented).toBe(false);
  expect(screen.queryByRole("dialog", { name: "Select model" })).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([command, args]) => command === "send_pi_command" && String((args as { jsonLine?: string })?.jsonLine).includes("cycle_"))).toHaveLength(0);
});

it("does not abort normal chat when Escape closes a research modal", async () => {
  mockBackend(false);
  const running = { version: 1, id: "run-one", query: "Question", state: "running", generation: 1, created_at: 1, updated_at: 2, session_id: "research-one", progress: { phase: "searching", activity: "Searching", searches: 0, reads: 0, checks: 0, active_calls: [] }, partial_report: "", sources: [], cancellation_requested: false, resume_count: 0 };
  invoke.mockImplementation((command: string) => {
    if (command === "get_deep_research_data") return Promise.resolve({ runs: [running], warnings: [] });
    if (command === "get_graph_status") return Promise.resolve({ state: "fresh", code_stale: false, docs_stale: false });
    return Promise.resolve({});
  });
  render(<ChatView {...baseProps} />);
  fireEvent.click(screen.getByRole("button", { name: "Deep Research" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  fireEvent.keyDown(window, { key: "Escape" });

  expect(invoke.mock.calls.filter(([command, args]) => command === "send_pi_command" && String((args as { jsonLine?: string })?.jsonLine).includes("abort"))).toHaveLength(0);
});

it("starts research only through the isolated research command", async () => {
  mockBackend(false);
  invoke.mockImplementation((command: string) => {
    if (command === "get_deep_research_data") return Promise.resolve({ runs: [], warnings: [] });
    if (command === "get_graph_status") return Promise.resolve({ state: "fresh", code_stale: false, docs_stale: false });
    if (command === "get_dev_server") return Promise.resolve(null);
    if (command === "start_deep_research") return Promise.resolve({ id: "run-one" });
    return Promise.resolve({});
  });
  render(<ChatView {...baseProps} />);
  fireEvent.click(screen.getByRole("button", { name: "Deep Research" }));
  fireEvent.change(await screen.findByLabelText("Research question"), { target: { value: "Investigate this" } });
  fireEvent.click(screen.getByRole("button", { name: "Start research" }));

  await waitFor(() => expect(invoke).toHaveBeenCalledWith("start_deep_research", { input: { query: "Investigate this", model: null, provider: null, thinking: null } }));
  expect(invoke).not.toHaveBeenCalledWith("send_pi_command", expect.objectContaining({ jsonLine: expect.stringContaining("Investigate this") }));
});
