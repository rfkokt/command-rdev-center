// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
// react-virtuoso renders nothing in jsdom (no layout engine), so virtualized
// feed items are invisible to tests. Render every row synchronously instead.
vi.mock("react-virtuoso", async () => {
  const React = await import("react");
  return {
    Virtuoso: React.forwardRef(function VirtuosoMock(props: any) {
      const { data = [], computeItemKey, itemContent } = props;
      return (
        <div data-testid="virtuoso-mock">
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
window.confirm = vi.fn(() => true);
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
  onOpenResearch: vi.fn(),
  isActive: true,
};

function run(state = "running") {
  return {
    version: 1,
    id: "run-one",
    query: "Investigate this",
    state,
    generation: 1,
    created_at: Math.floor(Date.now() / 1000) - 5,
    updated_at: 2,
    session_id: "research-one",
    origin_chat_id: "chat-one",
    origin_session_id: "chat-chat-one",
    progress: {
      phase: "searching",
      activity: "Searching official docs",
      searches: 2,
      reads: 1,
      checks: 1,
      active_calls: [],
    },
    partial_report:
      state === "completed" ? "# Report\n\nVerified **finding**." : "",
    final_report:
      state === "completed" ? "# Report\n\nVerified **finding**." : null,
    sources: [
      {
        url: "https://example.com",
        canonical_url: "https://example.com",
        title: "",
        cited: true,
      },
    ],
    cancellation_requested: false,
    resume_count: 0,
    handoff_delivered: state === "completed",
    handoff_state: state === "completed" ? "delivered" : "pending",
  };
}

function mockBackend(runs: unknown[] = []) {
  let current = runs;
  invoke.mockImplementation((command: string) => {
    if (command === "get_deep_research_data")
      return Promise.resolve({ runs: current, warnings: [] });
    if (command === "get_graph_status")
      return Promise.resolve({
        state: "fresh",
        code_stale: false,
        docs_stale: false,
      });
    if (command === "get_dev_server") return Promise.resolve(null);
    if (command === "get_worktree_diff")
      return Promise.resolve({ merge_base: "base", files: [] });
    if (command === "list_projects") return Promise.resolve([]);
    if (command === "start_deep_research") {
      current = [run("creating")];
      return Promise.resolve(current[0]);
    }
    return Promise.resolve({});
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  invoke.mockReset();
  listeners.clear();
  vi.clearAllMocks();
});

describe("session startup recovery", () => {
  it("starts the agent without waiting for a stalled optional graph scan", async () => {
    vi.useFakeTimers();
    mockBackend();
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, args: any) => {
      if (command === "get_graphify_settings")
        return Promise.resolve({ enabled: true });
      if (command === "get_graph_status") return new Promise(() => {});
      return original(command, args);
    });
    render(<ChatView {...baseProps} sessionFile="/tmp/saved.jsonl" />);
    await act(async () => {});
    expect(
      invoke.mock.calls.some(([command]) => command === "spawn_pi_rpc"),
    ).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1501);
    });
    expect(invoke).toHaveBeenCalledWith("spawn_pi_rpc", expect.anything());
    expect(screen.getByText("RESTORING CHAT HISTORY")).toBeInTheDocument();
  });

  it("does not block history restore on dev-server status", async () => {
    mockBackend();
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, args: any) => {
      if (command === "ensure_worktree")
        return Promise.resolve({ worktree_path: "/tmp/demo-worktree" });
      if (command === "get_dev_server") return new Promise(() => {});
      return original(command, args);
    });
    render(<ChatView {...baseProps} isGit sessionFile="/tmp/saved.jsonl" />);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("spawn_pi_rpc", expect.anything()),
    );
    await act(async () =>
      listeners.get("pi-rpc-event")?.({
        payload: {
          session_id: "chat-chat-one",
          raw: JSON.stringify({
            type: "response",
            command: "get_messages",
            success: true,
            data: {
              messages: [{ role: "user", content: "Saved conversation" }],
            },
          }),
        },
      }),
    );
    expect(screen.getByText("Saved conversation")).toBeInTheDocument();
    expect(screen.queryByText("LOADING SESSION")).not.toBeInTheDocument();
  });

  it("reports stalled startup and ignores its late completion", async () => {
    vi.useFakeTimers();
    mockBackend();
    const original = invoke.getMockImplementation()!;
    let finish!: () => void;
    invoke.mockImplementation((command: string, args: any) => {
      if (command === "spawn_pi_rpc")
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      return original(command, args);
    });
    render(<ChatView {...baseProps} sessionFile="/tmp/saved.jsonl" />);
    await act(async () => {});
    expect(screen.getByText("STARTING AGENT")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001);
    });
    expect(screen.queryByText("LOADING SESSION")).not.toBeInTheDocument();
    expect(baseProps.onToast).toHaveBeenCalledWith(
      expect.stringContaining("startup timed out while starting the agent"),
    );
    const commands = invoke.mock.calls.filter(
      ([command]) => command === "send_pi_command",
    ).length;
    await act(async () => finish());
    expect(
      invoke.mock.calls.filter(([command]) => command === "send_pi_command"),
    ).toHaveLength(commands);
    invoke.mockImplementation((command: string, args: any) =>
      command === "spawn_pi_rpc"
        ? Promise.resolve("new-process")
        : original(command, args),
    );
    fireEvent.click(screen.getByRole("button", { name: "RESTART" }));
    await act(async () => {});
    expect(
      invoke.mock.calls.filter(([command]) => command === "spawn_pi_rpc"),
    ).toHaveLength(2);
    expect(
      invoke.mock.calls.filter(([command]) => command === "send_pi_command")
        .length,
    ).toBeGreaterThan(commands);
    expect(
      screen.queryByRole("button", { name: "CONNECTING…" }),
    ).not.toBeInTheDocument();
  });

  it("surfaces a history RPC failure immediately", async () => {
    mockBackend();
    render(<ChatView {...baseProps} sessionFile="/tmp/saved.jsonl" />);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("spawn_pi_rpc", expect.anything()),
    );
    await act(async () =>
      listeners.get("pi-rpc-event")?.({
        payload: {
          session_id: "chat-chat-one",
          raw: JSON.stringify({
            type: "response",
            command: "get_messages",
            success: false,
            error: "Session file unavailable",
          }),
        },
      }),
    );
    expect(screen.queryByText("LOADING SESSION")).not.toBeInTheDocument();
    expect(
      screen.getByText(/Chat history could not be restored/),
    ).toBeInTheDocument();
  });

  it("reports listener connection failures instead of leaving the loader running", async () => {
    mockBackend();
    const original = listen.getMockImplementation()!;
    listen.mockImplementation((event, handler) =>
      event === "pi-rpc-event"
        ? Promise.reject(new Error("Event bridge unavailable"))
        : original(event, handler),
    );
    try {
      render(<ChatView {...baseProps} sessionFile="/tmp/saved.jsonl" />);
      await waitFor(() =>
        expect(
          screen.getByText(
            /Agent connection failed: Error: Event bridge unavailable/,
          ),
        ).toBeInTheDocument(),
      );
      expect(screen.queryByText("LOADING SESSION")).not.toBeInTheDocument();
    } finally {
      listen.mockImplementation(original);
    }
  });
});

describe("chat-native Deep Research", () => {
  it.each(["history", "empty", "reload", "pending-reload"])(
    "replaces fork history and supports Pi reload (%s)",
    async (mode) => {
      const emptyHistory = mode !== "history";
      mockBackend();
      const original = invoke.getMockImplementation()!;
      invoke.mockImplementation((command: string, args: any) => {
        if (command === "get_session_tree")
          return Promise.resolve({
            entries: [
              {
                type: "message",
                id: "old-user",
                parentId: null,
                message: { role: "user", content: "Old prompt" },
              },
              {
                type: "message",
                id: "old-answer",
                parentId: "old-user",
                message: { role: "assistant", content: "Abandoned answer" },
              },
            ],
          });
        if (command === "fork_session")
          return Promise.resolve({ text: "Old prompt", cancelled: false });
        return original(command, args);
      });
      render(<ChatView {...baseProps} />);
      await waitFor(() => expect(listeners.get("pi-rpc-event")).toBeDefined());
      const emit = (data: unknown) =>
        listeners.get("pi-rpc-event")!({
          payload: { session_id: "chat-chat-one", raw: JSON.stringify(data) },
        });
      await act(async () =>
        emit({
          type: "response",
          command: "get_messages",
          success: true,
          data: {
            messages: [
              { role: "user", id: "old-user", content: "Old prompt" },
              {
                role: "assistant",
                id: "old-answer",
                content: "Abandoned answer",
              },
            ],
          },
        }),
      );
      expect(screen.getByText("Abandoned answer")).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", { name: "Open session tree" }),
      );
      const forkButton = await screen.findByRole("button", { name: "FORK" });
      expect(screen.getAllByRole("button", { name: "FORK" })).toHaveLength(1);
      fireEvent.click(forkButton);
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("fork_session", {
          sessionId: "chat-chat-one",
          nodeId: "old-user",
        }),
      );
      await waitFor(() =>
        expect(screen.getByRole("textbox")).toHaveValue("Old prompt"),
      );
      const historyCalls = invoke.mock.calls.filter(
        ([command, args]) =>
          command === "send_pi_command" &&
          JSON.parse(args.jsonLine).type === "get_messages",
      );
      const historyCall = historyCalls[historyCalls.length - 1]!;
      const requestId = JSON.parse(historyCall[1].jsonLine).id;
      expect(typeof requestId).toBe("string");
      const staleHistory = {
        type: "response",
        id: "old-request",
        command: "get_messages",
        success: true,
        data: {
          messages: [{ role: "assistant", content: "Stale transcript" }],
        },
      };
      await act(async () => emit(staleHistory));
      expect(screen.queryByText("Stale transcript")).not.toBeInTheDocument();
      if (mode !== "pending-reload")
        await act(async () =>
          emit({
            type: "response",
            id: requestId,
            command: "get_messages",
            success: true,
            data: {
              messages: emptyHistory
                ? []
                : [{ role: "user", id: "prior-user", content: "Fork history" }],
            },
          }),
        );
      await act(async () => emit(staleHistory));
      expect(screen.queryByText("Stale transcript")).not.toBeInTheDocument();
      await waitFor(() =>
        expect(screen.queryByText("Abandoned answer")).not.toBeInTheDocument(),
      );
      if (!emptyHistory)
        expect(screen.getByText("Fork history")).toBeInTheDocument();
      expect(screen.getByRole("textbox")).toHaveValue("Old prompt");
      if (mode === "reload" || mode === "pending-reload") {
        const callsBeforeReload = invoke.mock.calls.filter(
          ([command, args]) =>
            command === "send_pi_command" &&
            JSON.parse(args.jsonLine).type === "get_messages",
        ).length;
        fireEvent.click(screen.getByRole("button", { name: "RELOAD PI" }));
        await waitFor(() =>
          expect(
            invoke.mock.calls.filter(
              ([command, args]) =>
                command === "send_pi_command" &&
                JSON.parse(args.jsonLine).type === "get_messages",
            ).length,
          ).toBeGreaterThan(callsBeforeReload),
        );
        await act(async () =>
          emit({
            type: "response",
            command: "get_messages",
            success: true,
            data: {
              messages: [{ role: "user", content: "Reloaded fork history" }],
            },
          }),
        );
        expect(screen.getByText("Reloaded fork history")).toBeInTheDocument();
      }
      expect(screen.getByRole("button", { name: "SEND" })).toBeEnabled();
    },
  );

  it.each([false, true])(
    "waits for the checkpoint attempt before sending (failure: %s)",
    async (failed) => {
      mockBackend();
      const original = invoke.getMockImplementation()!;
      let finishCheckpoint!: () => void;
      invoke.mockImplementation((command: string, args: any) => {
        if (command === "ensure_worktree")
          return Promise.resolve({
            worktree_path: "/tmp/demo-tree",
            branch: "crc/test",
            parent_ref: "main",
          });
        if (command === "create_checkpoint")
          return new Promise<void>((resolve, reject) => {
            finishCheckpoint = () =>
              failed ? reject(new Error("checkpoint unavailable")) : resolve();
          });
        return original(command, args);
      });
      render(<ChatView {...baseProps} isGit />);
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("spawn_pi_rpc", expect.anything()),
      );
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "Update login" },
      });
      fireEvent.click(screen.getByRole("button", { name: "SEND" }));
      await waitFor(() => expect(finishCheckpoint).toBeDefined());
      const prompts = () =>
        invoke.mock.calls.filter(
          ([command, args]) =>
            command === "send_pi_command" &&
            JSON.parse(args.jsonLine).type === "prompt",
        );
      expect(prompts()).toHaveLength(0);
      await act(async () => finishCheckpoint());
      await waitFor(() => expect(prompts()).toHaveLength(1));
    },
  );

  it("starts coding without Graphify scans when integration is off", async () => {
    mockBackend();
    render(<ChatView {...baseProps} />);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("spawn_pi_rpc", expect.anything()),
    );
    expect(
      invoke.mock.calls.some(
        ([command]) =>
          command === "get_graph_status" ||
          command === "build_graph" ||
          command === "get_git_fingerprint",
      ),
    ).toBe(false);
  });

  it("continues startup if an opted-in Graphify status check fails", async () => {
    mockBackend();
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, args: any) => {
      if (command === "get_graphify_settings")
        return Promise.resolve({ enabled: true });
      if (command === "get_graph_status")
        return Promise.reject(new Error("graph unavailable"));
      return original(command, args);
    });
    render(<ChatView {...baseProps} />);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("spawn_pi_rpc", expect.anything()),
    );
    expect(
      invoke.mock.calls.some(([command]) => command === "build_graph"),
    ).toBe(false);
  });

  it("has no mode toggle and starts only through /research", async () => {
    mockBackend();
    render(<ChatView {...baseProps} />);
    expect(
      screen.queryByRole("button", { name: "Deep Research" }),
    ).not.toBeInTheDocument();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, {
      target: { value: "/research Investigate this" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("start_deep_research", {
        input: expect.objectContaining({
          query: "Investigate this",
          originChatId: "chat-one",
          originSessionId: "chat-chat-one",
        }),
      }),
    );
    expect(baseProps.onOpenResearch).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith(
      "send_pi_command",
      expect.objectContaining({
        jsonLine: expect.stringContaining("Investigate this"),
      }),
    );
  });

  it("renders a human-readable live agent transcript", async () => {
    mockBackend();
    render(<ChatView {...baseProps} />);
    await waitFor(() => expect(listeners.get("pi-rpc-event")).toBeDefined());
    const emit = listeners.get("pi-rpc-event")!;
    emit({
      payload: {
        session_id: "chat-chat-one",
        raw: JSON.stringify({ type: "agent_start" }),
      },
    });
    emit({
      payload: {
        session_id: "chat-chat-one",
        raw: JSON.stringify({
          type: "message_update",
          assistantMessageEvent: {
            type: "toolcall_start",
            toolCall: { name: "functions.bash" },
          },
        }),
      },
    });
    await waitFor(() =>
      expect(screen.getByText("Calling functions.bash")).toBeInTheDocument(),
    );
    expect(screen.getByText("1 task active")).toBeInTheDocument();
    expect(screen.queryByText(/assistantMessageEvent/)).not.toBeInTheDocument();
  });

  it("selects /research with a trailing space ready for the query", async () => {
    mockBackend();
    render(<ChatView {...baseProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "/rese" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input).toHaveValue("/research ");
  });

  it("prefills a Start in chat draft without submitting it", async () => {
    mockBackend();
    const onInitialDraftConsumed = vi.fn();
    render(
      <ChatView
        {...baseProps}
        initialDraft="/research "
        onInitialDraftConsumed={onInitialDraftConsumed}
      />,
    );
    expect(await screen.findByRole("textbox")).toHaveValue("/research ");
    expect(onInitialDraftConsumed).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalledWith(
      "start_deep_research",
      expect.anything(),
    );
    expect(baseProps.onOpenResearch).not.toHaveBeenCalled();
  });

  it("validates an empty /research command", async () => {
    mockBackend();
    render(<ChatView {...baseProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "/research" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Add a question after /research",
    );
    expect(baseProps.onOpenResearch).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("/research");
    expect(invoke).not.toHaveBeenCalledWith(
      "start_deep_research",
      expect.anything(),
    );
  });

  it("renders progress, counts, cancel, and full-report navigation", async () => {
    mockBackend([run()]);
    render(<ChatView {...baseProps} />);
    expect(
      await screen.findByText("Searching official docs"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/2 searches · 1 reads · 1 checks · 1 sources/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("cancel_deep_research", {
        runId: "run-one",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open full report" }));
    expect(baseProps.onOpenResearch).toHaveBeenCalledWith("run-one");
  });

  it("places a restored research request chronologically in the timeline", async () => {
    mockBackend([run("completed")]);
    render(<ChatView {...baseProps} />);
    const request = await screen.findByText("/research Investigate this");
    const report = screen.getByRole("article");
    // Feed order is DOM order now (virtualized list); the request must precede its report.
    expect(
      Boolean(
        request.compareDocumentPosition(report) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
  });

  it("renders the complete Markdown report inline without an empty-state claim", async () => {
    mockBackend([run("completed")]);
    render(<ChatView {...baseProps} />);
    expect(
      await screen.findByRole("heading", { name: "Report" }),
    ).toBeInTheDocument();
    expect(screen.getByText("finding")).toBeInTheDocument();
    expect(
      screen.queryByText("AGENT IDLE. SEND PROMPT."),
    ).not.toBeInTheDocument();
  });

  it("keeps multiple sequential reports visible for the same chat", async () => {
    const first = {
      ...run("completed"),
      id: "run-a",
      query: "Research A",
      created_at: 10,
    };
    const second = {
      ...run("completed"),
      id: "run-b",
      query: "Research B",
      created_at: 20,
    };
    mockBackend([second, first]);
    render(<ChatView {...baseProps} />);
    expect(await screen.findByText("/research Research A")).toBeInTheDocument();
    expect(screen.getByText("/research Research B")).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });
});
