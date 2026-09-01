// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
import DeepResearchView from "./DeepResearchView";
afterEach(() => {
  cleanup();
  invoke.mockReset();
});
describe("DeepResearchView", () => {
  it("is a read-only library and starts research through chat", async () => {
    const onStartInChat = vi.fn();
    invoke.mockResolvedValueOnce({ runs: [], warnings: [] });
    render(<DeepResearchView onStartInChat={onStartInChat} />);
    await screen.findByText("No research reports yet");
    expect(
      screen.queryByLabelText("Research question"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start in chat" }));
    expect(onStartInChat).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalledWith(
      "start_deep_research",
      expect.anything(),
    );
  });

  it("attaches an orphaned report to the active chat", async () => {
    const orphan = {
      version: 1,
      id: "orphan",
      query: "Existing report",
      state: "completed",
      generation: 2,
      created_at: 1,
      updated_at: 2,
      session_id: "research-orphan",
      progress: {
        phase: "finalizing",
        activity: "Complete",
        searches: 1,
        reads: 1,
        checks: 1,
        active_calls: [],
      },
      final_report: "# Report\n\nFinding https://example.com",
      partial_report: "",
      sources: [],
      cancellation_requested: false,
      resume_count: 0,
    };
    const attached = {
      ...orphan,
      origin_chat_id: "global-1",
      origin_session_id: "chat-global-1",
    };
    const onContinueInChat = vi.fn();
    invoke
      .mockResolvedValueOnce({ runs: [orphan], warnings: [] })
      .mockResolvedValueOnce(attached)
      .mockResolvedValueOnce({ runs: [attached], warnings: [] });
    render(
      <DeepResearchView
        originChatId="global-1"
        originSessionId="chat-global-1"
        onContinueInChat={onContinueInChat}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue in current chat" }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("attach_deep_research_to_chat", {
        runId: "orphan",
        originChatId: "global-1",
        originSessionId: "chat-global-1",
      }),
    );
    expect(onContinueInChat).toHaveBeenCalledWith(attached);
  });

  it("moves a report owned by another chat to the current chat", async () => {
    const owned = {
      version: 1,
      id: "owned",
      query: "Existing report",
      state: "completed",
      generation: 2,
      created_at: 1,
      updated_at: 2,
      session_id: "research-owned",
      origin_chat_id: "global-old",
      origin_session_id: "chat-global-old",
      handoff_state: "delivered",
      handoff_delivered: true,
      progress: {
        phase: "finalizing",
        activity: "Complete",
        searches: 1,
        reads: 1,
        checks: 1,
        active_calls: [],
      },
      final_report: "# Report",
      partial_report: "",
      sources: [],
      cancellation_requested: false,
      resume_count: 0,
    };
    const moved = {
      ...owned,
      origin_chat_id: "global-current",
      origin_session_id: "chat-global-current",
      handoff_state: "pending",
      handoff_delivered: false,
    };
    const onContinueInChat = vi.fn();
    invoke
      .mockResolvedValueOnce({ runs: [owned], warnings: [] })
      .mockResolvedValueOnce(moved)
      .mockResolvedValueOnce({ runs: [moved], warnings: [] });
    render(
      <DeepResearchView
        originChatId="global-current"
        originSessionId="chat-global-current"
        onContinueInChat={onContinueInChat}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Move to current chat" }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("attach_deep_research_to_chat", {
        runId: "owned",
        originChatId: "global-current",
        originSessionId: "chat-global-current",
      }),
    );
    expect(onContinueInChat).toHaveBeenCalledWith(moved);
  });

  it("navigates to the owner when the report already belongs to current chat", async () => {
    const owned = {
      version: 1,
      id: "owned",
      query: "Existing report",
      state: "completed",
      generation: 2,
      created_at: 1,
      updated_at: 2,
      session_id: "research-owned",
      origin_chat_id: "global-current",
      origin_session_id: "chat-global-current",
      progress: {
        phase: "finalizing",
        activity: "Complete",
        searches: 1,
        reads: 1,
        checks: 1,
        active_calls: [],
      },
      final_report: "# Report",
      partial_report: "",
      sources: [],
      cancellation_requested: false,
      resume_count: 0,
    };
    const onContinueInChat = vi.fn();
    invoke.mockResolvedValueOnce({ runs: [owned], warnings: [] });
    render(
      <DeepResearchView
        originChatId="global-current"
        originSessionId="chat-global-current"
        onContinueInChat={onContinueInChat}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue in current chat" }),
    );
    expect(onContinueInChat).toHaveBeenCalledWith(owned);
    expect(invoke).not.toHaveBeenCalledWith(
      "attach_deep_research_to_chat",
      expect.anything(),
    );
  });

  it("renders progress, partial output, sources, and resume", async () => {
    invoke.mockResolvedValueOnce({
      warnings: [],
      runs: [
        {
          version: 1,
          id: "one",
          query: "Question",
          state: "interrupted",
          generation: 2,
          created_at: 1,
          updated_at: 2,
          session_id: "research-one",
          progress: {
            phase: "reading",
            activity: "Reading sources",
            searches: 2,
            reads: 1,
            checks: 0,
            active_calls: [],
          },
          partial_report: "# Partial",
          sources: [
            {
              url: "https://example.com",
              canonical_url: "https://example.com",
              title: "Example",
              cited: false,
            },
          ],
          cancellation_requested: false,
          resume_count: 0,
        },
      ],
    });
    render(<DeepResearchView />);
    expect(
      await screen.findByRole("heading", { name: "Question" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Working draft")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Example" })).toHaveAttribute(
      "rel",
      "noreferrer",
    );
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });
  it("renders a semantic editorial report with metadata and source navigation", async () => {
    invoke.mockResolvedValueOnce({
      warnings: [],
      runs: [
        {
          version: 1,
          id: "one",
          query: "Fallback query",
          state: "completed",
          generation: 2,
          created_at: 1,
          updated_at: 2,
          session_id: "research-one",
          progress: {
            phase: "finalizing",
            activity: "Complete",
            searches: 2,
            reads: 2,
            checks: 1,
            active_calls: [],
          },
          final_report:
            "# A researched title\n\nA concise opening deck for the report.\n\n## Findings\n\nBody copy.",
          partial_report: "",
          sources: [
            {
              url: "https://example.com/source",
              canonical_url: "https://example.com/source",
              title: "Primary source",
              cited: true,
            },
          ],
          cancellation_requested: false,
          resume_count: 0,
        },
      ],
    });
    render(<DeepResearchView />);
    const article = await screen.findByRole("article", {
      name: "A researched title",
    });
    expect(article).toHaveAccessibleName("A researched title");
    expect(
      screen.getByRole("heading", { level: 1, name: "A researched title" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("A concise opening deck for the report."),
    ).toHaveLength(2);
    expect(screen.getByText("Reading time")).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Research runs" }),
    ).toHaveAttribute("id", "research-library");
    expect(
      screen.getByRole("heading", { level: 2, name: "Sources" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Primary source" }),
    ).toHaveAttribute("target", "_blank");
  });
  it("confirms cancellation and explains partial retention", async () => {
    invoke.mockResolvedValueOnce({
      warnings: [],
      runs: [
        {
          version: 1,
          id: "one",
          query: "Question",
          state: "running",
          generation: 2,
          created_at: 1,
          updated_at: 2,
          session_id: "research-one",
          progress: {
            phase: "searching",
            activity: "Searching",
            searches: 0,
            reads: 0,
            checks: 0,
            active_calls: [],
          },
          partial_report: "",
          sources: [],
          cancellation_requested: false,
          resume_count: 0,
        },
      ],
    });
    render(<DeepResearchView />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.getByRole("alertdialog")).toHaveTextContent(
        "partial report and source list remain",
      ),
    );
  });
  it("resumes the selected run using its stable run id", async () => {
    const interrupted = {
      version: 1,
      id: "one",
      query: "Question",
      state: "interrupted",
      generation: 2,
      created_at: 1,
      updated_at: 2,
      session_id: "research-one-resume-1",
      progress: {
        phase: "reading",
        activity: "Interrupted",
        searches: 1,
        reads: 1,
        checks: 0,
        active_calls: [],
      },
      partial_report: "# Partial",
      sources: [],
      cancellation_requested: false,
      resume_count: 0,
    };
    invoke
      .mockResolvedValueOnce({ warnings: [], runs: [interrupted] })
      .mockResolvedValueOnce({
        ...interrupted,
        state: "running",
        resume_count: 1,
      })
      .mockResolvedValueOnce({
        warnings: [],
        runs: [{ ...interrupted, state: "running", resume_count: 1 }],
      });
    render(<DeepResearchView />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("resume_deep_research", {
        runId: "one",
      }),
    );
  });
});
