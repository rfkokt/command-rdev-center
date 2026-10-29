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
import { afterEach, expect, test, vi } from "vitest";

const { invoke, listeners, scrollToIndex, feed } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: unknown) => void>(),
  scrollToIndex: vi.fn(),
  feed: { current: null as any },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: unknown) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => listeners.delete(name));
  }),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(false),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock("./ProjectFilesSidebar", () => ({ default: () => null }));
vi.mock("./FilePicker", () => ({ default: () => null }));
vi.mock("react-virtuoso", async () => {
  const React = await import("react");
  return {
    Virtuoso: React.forwardRef(function FeedMock(props: any, ref) {
      feed.current = props;
      React.useImperativeHandle(ref, () => ({ scrollToIndex }));
      return <div data-testid="chat-feed" />;
    }),
  };
});
import ChatView from "./ChatView";

afterEach(() => {
  cleanup();
  localStorage.clear();
  listeners.clear();
  invoke.mockReset();
  scrollToIndex.mockReset();
  feed.current = null;
});

test("opens at the latest message, preserves reading position, and offers a jump back down", async () => {
  invoke.mockImplementation((command: string) => {
    if (command === "session_tool_calls") return Promise.resolve([]);
    if (command === "get_deep_research_data")
      return Promise.resolve({ runs: [], warnings: [] });
    if (command === "get_dev_server") return Promise.resolve(null);
    return Promise.resolve({});
  });
  const props = {
    projectPath: "/tmp/demo",
    projectName: "demo",
    isGit: false,
    repositories: [],
    pipelineType: "Personal",
    chatId: "scroll-test",
    sessionFile: "/tmp/session.jsonl",
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
  const { rerender } = render(<ChatView {...props} />);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("spawn_pi_rpc", expect.anything()),
  );
  const emit = (event: unknown) =>
    act(async () => {
      listeners.get("pi-rpc-event")!({
        payload: {
          session_id: "chat-scroll-test",
          raw: JSON.stringify(event),
        },
      });
    });
  await emit({
    type: "response",
    command: "get_messages",
    success: true,
    data: {
      messages: [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Latest answer" },
      ],
    },
  });
  await waitFor(() =>
    expect(scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
      behavior: "auto",
    }),
  );
  expect(
    screen.queryByRole("button", { name: "Latest messages" }),
  ).not.toBeInTheDocument();
  // Let the activation retry finish before simulating a reader scrolling up.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  scrollToIndex.mockClear();
  act(() => feed.current.atBottomStateChange(false));
  expect(
    screen.getByRole("button", { name: "Latest messages" }),
  ).toBeInTheDocument();
  expect(feed.current.followOutput(false)).toBe(false);
  expect(scrollToIndex).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Latest messages" }));
  expect(scrollToIndex).toHaveBeenCalledWith({
    index: "LAST",
    align: "end",
    behavior: "auto",
  });
  expect(
    screen.queryByRole("button", { name: "Latest messages" }),
  ).not.toBeInTheDocument();
  act(() => feed.current.atBottomStateChange(false));
  act(() => feed.current.atBottomStateChange(true));
  expect(
    screen.queryByRole("button", { name: "Latest messages" }),
  ).not.toBeInTheDocument();
  rerender(<ChatView {...props} isActive={false} />);
  scrollToIndex.mockClear();
  rerender(<ChatView {...props} />);
  expect(scrollToIndex).toHaveBeenCalledWith({
    index: "LAST",
    align: "end",
    behavior: "auto",
  });
});
