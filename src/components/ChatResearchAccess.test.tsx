// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn().mockResolvedValue(() => {}),
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
    if (command === "start_deep_research") {
      current = [run("creating")];
      return Promise.resolve(current[0]);
    }
    return Promise.resolve({});
  });
}

afterEach(() => {
  cleanup();
  invoke.mockReset();
  vi.clearAllMocks();
});

describe("chat-native Deep Research", () => {
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
    expect(
      Number(request.getAttribute("style")?.match(/order: (\d+)/)?.[1]),
    ).toBeLessThan(
      Number(report.getAttribute("style")?.match(/order: (\d+)/)?.[1]),
    );
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
