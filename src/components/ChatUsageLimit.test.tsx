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
