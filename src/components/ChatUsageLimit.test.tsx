// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const { invoke, listen, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn((event: string, handler: (payload: unknown) => void) => {
    listeners.set(event, handler);
    return Promise.resolve(() => listeners.delete(event));
  }),
  listeners: new Map<string, (payload: unknown) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(false),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./ProjectFilesSidebar", () => ({ default: () => null }));
vi.mock("./FilePicker", () => ({ default: () => null }));
vi.mock("./TerminalPanel", () => ({ default: () => null }));
vi.mock("react-virtuoso", async () => {
  const React = await import("react");
  return {
    Virtuoso: React.forwardRef(function VirtuosoMock(props: any) {
      const { data = [], computeItemKey, itemContent } = props;
      return (
        <div>
          {data.map((item: any, index: number) => (
            <div key={computeItemKey ? computeItemKey(index, item) : index}>
              {itemContent(index, item)}
            </div>
          ))}
        </div>
      );
    }),
  };
});
import ChatView from "./ChatView";
import { terminalEventId } from "../lib/terminal-warmup";

Element.prototype.scrollIntoView = vi.fn();
const props = {
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
  onOpenResearch: vi.fn(),
  isActive: true,
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  invoke.mockReset();
  listeners.clear();
});

it("offers to continue with another agent after a usage limit and hands over the chat", async () => {
  invoke.mockImplementation((command: string) => {
    if (command === "list_harnesses")
      return Promise.resolve([
        {
          id: "claude-code",
          label: "Claude Code",
          protocol: "acp",
          available: true,
          is_default: false,
        },
        {
          id: "pi",
          label: "pi",
          protocol: "native",
          available: true,
          is_default: true,
        },
      ]);
    if (command === "write_chat_handoff")
      return Promise.resolve("/data/handoffs/chat-one.md");
    if (command === "session_tool_calls") return Promise.resolve([]);
    if (command === "get_deep_research_data")
      return Promise.resolve({ runs: [], warnings: [] });
    if (command === "get_dev_server") return Promise.resolve(null);
    return Promise.resolve({});
  });
  render(<ChatView {...props} initialHarness="claude-code" />);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("spawn_pi_rpc", expect.anything()),
  );
  const emit = (event: unknown) =>
    act(async () =>
      listeners.get("pi-rpc-event")!({
        payload: { session_id: "chat-chat-one", raw: JSON.stringify(event) },
      }),
    );
  await emit({
    type: "response",
    command: "get_messages",
    success: true,
    data: {
      messages: [{ role: "user", content: "Refactor the settings page" }],
    },
  });
  await emit({ type: "agent_start" });
  await emit({ type: "message_start", message: { role: "assistant" } });
  await emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Claude AI usage limit reached|1761500000",
    },
  });
  await emit({ type: "agent_settled" });

  expect(
    await screen.findByLabelText("Usage limit reached"),
  ).toBeInTheDocument();
  invoke.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Continue with pi" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "spawn_pi_rpc",
      expect.objectContaining({
        harness: "pi",
        handoff: expect.stringContaining("Refactor the settings page"),
      }),
    ),
  );
  const spawn = invoke.mock.calls.find(
    ([command]) => command === "spawn_pi_rpc",
  )!;
  expect(spawn[1].handoff).toContain("/data/handoffs/chat-one.md");
  expect(localStorage.getItem("kern:fallback-agent")).toBe("pi");
});

it("automatically signs an expired Claude session in and resumes the interrupted request", async () => {
  invoke.mockImplementation((command: string) => {
    if (command === "list_harnesses")
      return Promise.resolve([
        {
          id: "claude-code",
          label: "Claude Code",
          available: true,
          is_default: true,
        },
      ]);
    if (command === "list_projects") return Promise.resolve([]);
    if (command === "get_deep_research_data")
      return Promise.resolve({ runs: [], warnings: [] });
    if (command === "get_dev_server") return Promise.resolve(null);
    return Promise.resolve({});
  });
  render(<ChatView {...props} />); // Exercise the configured default harness.
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("spawn_pi_rpc", expect.anything()),
  );
  const emit = (event: unknown) =>
    act(async () => {
      listeners.get("pi-rpc-event")!({
        payload: { session_id: "chat-chat-one", raw: JSON.stringify(event) },
      });
    });
  const error =
    "Failed to authenticate: OAuth session expired and could not be refreshed";
  await emit({
    type: "response",
    command: "get_messages",
    success: true,
    data: {
      messages: [
        { role: "user", content: "Fix the settings page" },
        {
          role: "assistant",
          content: error,
          stopReason: "error",
          errorMessage: error,
        },
      ],
    },
  });
  expect(
    invoke.mock.calls.filter(([command]) => command === "terminal_write"),
  ).toHaveLength(0);
  await emit({ type: "agent_start" });
  const failed = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: error,
  };
  await emit({ type: "message_end", message: failed });
  await emit({ type: "agent_end", messages: [failed] });
  await emit({ type: "agent_settled" });
  await waitFor(() =>
    expect(
      invoke.mock.calls.filter(([command]) => command === "terminal_write"),
    ).toHaveLength(1),
  );
  const login = invoke.mock.calls.find(
    ([command]) => command === "terminal_write",
  )![1];
  expect(login.data).toContain("claude auth login");
  expect(login.chatId).not.toBe("chat-one__0");
  expect(
    invoke.mock.calls.filter(([command]) => command === "spawn_pi_rpc"),
  ).toHaveLength(1);

  await act(async () =>
    listeners.get(`terminal://data/${terminalEventId(login.chatId)}`)!({
      payload: "\r\n__KERN_CLAUDE_LOGIN_EXIT__:0\r\n",
    }),
  );
  await waitFor(() =>
    expect(
      invoke.mock.calls.filter(([command]) => command === "spawn_pi_rpc"),
    ).toHaveLength(2),
  );
  await waitFor(() =>
    expect(
      invoke.mock.calls.some(
        ([command, args]) =>
          command === "send_pi_command" &&
          JSON.parse(args.jsonLine).type === "prompt" &&
          JSON.parse(args.jsonLine).message.includes("Fix the settings page"),
      ),
    ).toBe(true),
  );
});

it("opens a decision dialog for no-mistakes ask-user findings and relays the choice", async () => {
  invoke.mockImplementation((command: string) => {
    if (command === "list_harnesses")
      return Promise.resolve([
        { id: "pi", label: "pi", available: true, is_default: true },
      ]);
    if (command === "list_projects") return Promise.resolve([]);
    if (command === "get_deep_research_data")
      return Promise.resolve({ runs: [], warnings: [] });
    if (command === "get_dev_server") return Promise.resolve(null);
    return Promise.resolve({});
  });
  render(<ChatView {...props} />);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("spawn_pi_rpc", expect.anything()),
  );
  const emit = (event: unknown) =>
    act(async () => {
      listeners.get("pi-rpc-event")!({
        payload: { session_id: "chat-chat-one", raw: JSON.stringify(event) },
      });
    });
  await emit({
    type: "response",
    command: "get_messages",
    success: true,
    data: { messages: [] },
  });
  await emit({ type: "agent_start" });
  await emit({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "no-mistakes axi run --intent 'x'" },
  });
  await emit({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "bash",
    result: {
      content: [
        {
          type: "text",
          text: [
            "gate: review",
            "findings[1]{id,severity,file,line,action,description}:",
            "  badge-always-on,warning,src/page.tsx,219,ask-user,The Filter badge is now always visible",
          ].join("\n"),
        },
      ],
    },
  });
  // The dialog waits until the agent's turn has settled.
  expect(screen.queryByRole("dialog")).toBeNull();
  const done = { role: "assistant", content: "Gate needs your decision." };
  await emit({ type: "message_end", message: done });
  await emit({ type: "agent_end", messages: [done] });
  await emit({ type: "agent_settled" });

  expect(
    await screen.findByText("The Filter badge is now always visible"),
  ).toBeVisible();
  invoke.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Approve as is" }));
  await waitFor(() =>
    expect(
      invoke.mock.calls.some(
        ([command, args]) =>
          command === "send_pi_command" &&
          JSON.parse(args.jsonLine).type === "prompt" &&
          JSON.parse(args.jsonLine).message.includes("--action approve"),
      ),
    ).toBe(true),
  );
  expect(
    screen.queryByText("The Filter badge is now always visible"),
  ).toBeNull();
});
