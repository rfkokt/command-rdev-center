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

const GATE = [
  "gate:",
  "  step: review",
  "  status: awaiting_approval",
  "  findings[2]{id,severity,file,action,description}:",
  "    badge-always-on,warning,src/page.tsx,ask-user,The Filter badge is now always visible",
  "    dead-import,info,src/page.tsx,auto-fix,Unused import of useMemo",
].join("\n");
const CODEX_COMMAND = `/bin/zsh -lc "no-mistakes axi run --intent 'x'"`;

async function startChat(
  history: unknown[] = [],
  sendFails: () => boolean = () => false,
) {
  invoke.mockImplementation((command: string) => {
    if (command === "list_harnesses")
      return Promise.resolve([
        { id: "pi", label: "pi", available: true, is_default: true },
      ]);
    if (command === "list_projects") return Promise.resolve([]);
    if (command === "get_deep_research_data")
      return Promise.resolve({ runs: [], warnings: [] });
    if (command === "get_dev_server") return Promise.resolve(null);
    if (command === "send_pi_command" && sendFails())
      return Promise.reject("transient write failure");
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
    data: { messages: history },
  });
  let call = 0;
  const gateResult = (command = CODEX_COMMAND) =>
    emit({
      type: "tool_execution_end",
      toolCallId: `call-${++call}`,
      toolName: "bash",
      args: { command },
      result: { content: [{ type: "text", text: GATE }] },
    });
  const settle = async () => {
    const done = { role: "assistant", content: "Done." };
    await emit({ type: "message_end", message: done });
    await emit({ type: "agent_end", messages: [done] });
    await emit({ type: "agent_settled" });
  };
  return { emit, gateResult, settle };
}

const sentPrompts = () =>
  invoke.mock.calls
    .filter(([command]) => command === "send_pi_command")
    .map(([, args]) => JSON.parse(args.jsonLine))
    .filter((line) => line.type === "prompt")
    .map((line) => line.message as string);

it("relays Fix selected with guidance for a Codex shell-wrapped gate", async () => {
  const { emit, gateResult, settle } = await startChat();
  await emit({ type: "agent_start" });
  await gateResult();
  await settle();
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("The Filter badge is now always visible");
  expect(dialog).not.toHaveTextContent("Unused import of useMemo");
  fireEvent.change(screen.getByPlaceholderText(/How should the selected/), {
    target: { value: "Only show the badge when filters are active" },
  });
  invoke.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Fix selected →" }));
  await waitFor(() => expect(sentPrompts()).toHaveLength(1));
  const prompt = sentPrompts()[0];
  expect(prompt).toContain("badge-always-on");
  expect(prompt).toContain("Only show the badge when filters are active");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("restores the dialog when sending the decision fails", async () => {
  let fail = false;
  const { emit, gateResult, settle } = await startChat([], () => fail);
  await emit({ type: "agent_start" });
  await gateResult();
  await settle();
  await screen.findByRole("dialog");
  fail = true;
  fireEvent.click(screen.getByRole("button", { name: "Approve as is" }));
  await waitFor(() =>
    expect(props.onToast).toHaveBeenCalledWith(
      "Could not send the no-mistakes decision to the agent.",
    ),
  );
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    "The Filter badge is now always visible",
  );
});

it("clears the gate dialog when the user types a reply instead", async () => {
  const { emit, gateResult, settle } = await startChat();
  await emit({ type: "agent_start" });
  await gateResult();
  await settle();
  await screen.findByRole("dialog");
  invoke.mockClear();
  const composer = screen
    .getAllByRole("textbox")
    .find((el) => !el.closest('[role="dialog"]'))!;
  fireEvent.change(composer, {
    target: { value: "Approve it, it's intended" },
  });
  fireEvent.keyDown(composer, { key: "Enter" });
  await waitFor(() =>
    expect(
      sentPrompts().some((m) => m.includes("Approve it, it's intended")),
    ).toBe(true),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("Later dismisses the dialog without sending anything", async () => {
  const { emit, gateResult, settle } = await startChat();
  await emit({ type: "agent_start" });
  await gateResult();
  await settle();
  await screen.findByRole("dialog");
  invoke.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Later" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(sentPrompts()).toHaveLength(0);
});

it("does not open the dialog from restored history", async () => {
  await startChat([
    { role: "user", content: "ship it" },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "old-1",
          name: "bash",
          arguments: { command: CODEX_COMMAND },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "old-1",
      toolName: "bash",
      content: [{ type: "text", text: GATE }],
    },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.getByText("ship it")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).toBeNull();
});
