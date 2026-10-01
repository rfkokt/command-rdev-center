import {
  memo,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type CSSProperties,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ChatImage,
  ChatMessage,
  ToolCall,
  ApprovalRequest,
} from "../lib/rpc";
import { parseApprovalRequest } from "../lib/rpc";
import {
  formatTokens,
  appendStreamingText,
  recentItems,
  uid,
  shouldShowChanges,
  preserveStreamedContent,
  sameAssistantResponse,
  terminalCommandIsDestructive,
  insertSteerMessage,
  ensureAssistantTurn,
  shouldToastPiStderr,
  appendAgentLog,
  backgroundAgentWork,
  settleAgentMessages,
  settleWithError,
  shouldOfferRestart,
  isPiRuntimeIssue,
  clearRestartErrors,
  agentNotification,
  projectTaskIntent,
  researchQuery,
  tsvToMarkdown,
} from "./chat-utils";
import ToolCallView, {
  BrowserScreenshot,
  activityKind,
  browserScreenshotRef,
  browserScreenshotRefFromText,
  getSubagentMeta,
  isSubagentTool,
  isWebSearchTool,
} from "./ToolCall";
import MarkdownMessage from "./MarkdownMessage";
import ThinkingBlock from "./ThinkingBlock";
import ApprovalDialog from "./ApprovalDialog";
import { confirm } from "./ConfirmDialog";
import { type FilePickerHandle } from "./FilePicker";
import TerminalPanel from "./TerminalPanel";
import {
  canResumeResearch,
  elapsedResearch,
  isActiveResearch,
  type ResearchRun,
} from "../lib/deep-research";
import { useModalFocus } from "./useModalFocus";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import ModelPickerDialog from "./ModelPickerDialog";
import ChatComposer from "./ChatComposer";
import ChatRightSidebar from "./ChatRightSidebar";
import ExpandedDiffPanel from "./ExpandedDiffPanel";
import {
  buildPhase,
  transcriptEntry,
  describeToolActivity,
} from "./chat-activity-text";

// One chronological feed row for the virtualized message list. Message and
// research rows interleave by their original flex `order` keys so the virtual
// list renders in exactly the same visual order the CSS flexbox used before.
type FeedItem =
  | { kind: "session-loading"; order: number }
  | { kind: "history-state"; order: number }
  | { kind: "research-request"; run: ResearchRun; order: number }
  | { kind: "research-report"; run: ResearchRun; order: number }
  | { kind: "message"; message: ChatMessage; order: number }
  | { kind: "background-work"; order: number }
  | { kind: "agent-activity"; order: number };

// Stable identity for virtualized rows; must match the keys the old
// non-virtualized list used (message ids and research run ids).
function feedItemKey(_index: number, item: FeedItem): string {
  switch (item.kind) {
    case "message":
      return item.message.id;
    case "research-request":
      return `${item.run.id}-request`;
    case "research-report":
      return item.run.id;
    case "session-loading":
      return "session-loading";
    case "history-state":
      return "history-state";
    case "background-work":
      return "background-work";
    case "agent-activity":
      return "agent-activity";
  }
}

const FEED_ITEM_STYLE: CSSProperties = {
  maxWidth: 880,
  width: "100%",
  margin: "0 auto",
  padding: "0 var(--spacing-md) var(--spacing-xl)",
};

type PiEventPayload = { session_id: string; raw: string };
export type WorktreeInfo = {
  worktree_path: string;
  branch: string;
  repo_name: string;
  slug: string;
  parent_ref: string;
};
export type SlashCommand = {
  name: string;
  description?: string;
  source: string;
};
type GraphStatus = {
  state: "none" | "fresh" | "stale-code" | "stale-docs";
  code_stale: boolean;
  docs_stale: boolean;
  report_path?: string;
  tracked_warning?: string;
};
type GraphProgress = {
  repository: string;
  index: number;
  total: number;
  activity: string;
};
export type ChatRepository = {
  name: string;
  path: string;
  base_branch?: string;
  branch?: string;
  tracking_branch?: string;
  remote_url?: string;
  ahead?: number;
  behind?: number;
  dirty_files?: string[];
};
export type WorktreeDiff = {
  merge_base: string;
  files: Array<{
    repository?: string;
    path: string;
    status: string;
    added: number;
    removed: number;
    patch: string;
  }>;
};
type DevRunnerInfo = {
  command: string;
  url: string;
  running: boolean;
  error?: string;
};
type SessionStats = {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
};
export type ChatFile = { name: string; path: string };
type ChatAttachment = ChatFile & { content: string };

function attachmentContext(attachments: ChatAttachment[]) {
  return `\n\n<authoritative_attachments>\nThe user explicitly attached the files below. Use their exact contents as authoritative context.\n${attachments.map((file) => `--- ${file.name} (${file.path}) ---\n${file.content}\n--- end ${file.name} ---`).join("\n")}\n</authoritative_attachments>`;
}

const MAX_HISTORY = 600;
const AGENT_INACTIVITY_TIMEOUT_MS = 2 * 60_000;

// ponytail: own 1s ticker so the whole chat tree doesn't re-render every second.
const ElapsedLabel = memo(function ElapsedLabel({
  startedAt,
  ticking,
}: {
  startedAt: number;
  ticking: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking, startedAt]);
  const s = Math.max(0, Math.round((now - startedAt) / 1000));
  return <>{s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`}</>;
});
const GRAPHIGNORE_PROMPTED_KEY = "crc-graphignore-prompted";

function formatTaskDuration(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function formatMessageTime(timestamp: number) {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const today = new Date();
  const startOfToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  if (timestamp >= startOfToday) return time;
  if (timestamp >= startOfToday - 86_400_000) return `Kemarin ${time}`;
  return `${date.toLocaleDateString("id-ID", { day: "2-digit", month: "2-digit", year: "numeric" })} ${time}`;
}

async function notifyAgent(
  kind: "finished" | "follow-up",
  projectName: string,
  chatId: string,
  response?: string,
) {
  const granted =
    (await isPermissionGranted()) || (await requestPermission()) === "granted";
  if (granted)
    sendNotification(agentNotification(kind, projectName, chatId, response));
}

function extractMarkdownTables(
  text: string,
): { header: string[]; rows: string[][] }[] {
  const lines = text.split("\n");
  const out: { header: string[]; rows: string[][] }[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i].trim();
    const b = lines[i + 1]?.trim() ?? "";
    if (!a.startsWith("|") || !b.startsWith("|")) continue;
    if (!/\|\s*:?-{2,}/.test(b)) continue;
    // collect
    const block: string[] = [a, b];
    let j = i + 2;
    while (j < lines.length && lines[j].trim().startsWith("|")) {
      block.push(lines[j].trim());
      j++;
    }
    const parseRow = (s: string) =>
      s
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((x) => x.trim().replace(/\\\|/g, "|"));
    const header = parseRow(block[0]);
    const rows = block.slice(2).map(parseRow);
    if (header.length > 0) out.push({ header, rows });
    i = j - 1;
  }
  return out;
}

function deriveAtQuery(text: string): string | null {
  const atIdx = text.lastIndexOf("@");
  if (atIdx === -1) return null;
  const before = atIdx === 0 ? " " : text[atIdx - 1];
  if (before !== " " && before !== "\n" && before !== "@") return null;
  const after = text.slice(atIdx + 1);
  const tokenEnd = after.search(/[\s\n]/);
  if (tokenEnd !== -1) return null;
  const q = after;
  if (q.length > 80) return null;
  return q;
}

const surfacedPipelineFailures = new Set<string>();

export default function ChatView({
  projectPath,
  projectName,
  isGit,
  repositories,
  pipelineType: _pipelineType,
  chatId,
  sessionFile,
  initialModel,
  initialThinking,
  initialInterrupted,
  resumableSessions,
  onSessionFile,
  onFirstMessage,
  onRuntimeSettings,
  onAgentRunning,
  onUnread,
  onClose,
  onToast,
  onOpenPipeline,
  onOpenResearch,
  isActive,
  globalChat = false,
  customSystemPrompt,
  inputPlaceholder,
  initialPrompt,
  initialDraft,
  onInitialPromptConsumed,
  onInitialDraftConsumed,
}: {
  projectPath: string;
  projectName: string;
  isGit: boolean;
  repositories: ChatRepository[];
  pipelineType: string;
  chatId: string;
  sessionFile?: string;
  initialModel?: string;
  initialThinking?: string;
  initialInterrupted?: boolean;
  resumableSessions: Array<{ title: string; sessionFile: string }>;
  onSessionFile: (chatId: string, sessionFile: string) => void;
  onFirstMessage: (chatId: string, message: string) => void;
  onRuntimeSettings: (chatId: string, model: string, thinking: string) => void;
  onAgentRunning: (chatId: string, running: boolean) => void;
  onUnread: (chatId: string) => void;
  onClose: () => void;
  onToast: (m: string) => void;
  onOpenPipeline: () => void;
  onOpenResearch: (runId: string) => void;
  isActive: boolean;
  globalChat?: boolean;
  customSystemPrompt?: string;
  inputPlaceholder?: string;
  initialPrompt?: string;
  initialDraft?: string;
  onInitialPromptConsumed?: () => void;
  onInitialDraftConsumed?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const toolArgsRef = useRef(new Map<string, Record<string, unknown>>());
  const [researchResults, setResearchResults] = useState<ResearchRun[]>([]);
  const [researchBusy, setResearchBusy] = useState(false);
  const [researchUsageError, setResearchUsageError] = useState(false);
  const [chatReady, setChatReady] = useState(false);
  const [researchHandoffError, setResearchHandoffError] = useState<
    string | null
  >(null);
  const researchHandoffRef = useRef<string | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(
    Boolean(sessionFile),
  );
  const historyLoadedRef = useRef(!sessionFile);
  const [isNewSessionLoading, setIsNewSessionLoading] = useState(false);
  const [input, setInput] = useState("");
  const [images, setImages] = useState<ChatImage[]>([]);
  const [files, setFiles] = useState<ChatFile[]>([]);
  const [previewImage, setPreviewImage] = useState<ChatImage | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isAborting, setIsAborting] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [fixingPiIssueId, setFixingPiIssueId] = useState<string | null>(null);
  const [worktree, setWorktree] = useState<WorktreeInfo | null>(null);
  const [repositoryStatuses, setRepositoryStatuses] = useState(repositories);
  const [repositoryMapLoaded, setRepositoryMapLoaded] = useState(
    repositories.length > 0,
  );
  const isWorkspace = repositoryStatuses.length > 0;
  const [cwd, setCwd] = useState(projectPath);
  const cwdRef = useRef(projectPath);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [terminalApproval, setTerminalApproval] = useState<{
    pane?: string;
    data: string;
  } | null>(null);
  const [terminalApprovalStatus, setTerminalApprovalStatus] = useState<
    "executing" | "refreshing" | null
  >(null);
  const [agentStatus, setAgentStatus] = useState<
    "idle" | "running" | "stopped"
  >(initialInterrupted ? "stopped" : "idle");
  const [agentTranscript, setAgentTranscript] = useState<
    Array<{ id: string; type: string; detail: string; at: number }>
  >([]);
  const [driveDetached, setDriveDetached] = useState(false);
  // Bumped after the user approves the Pi install so the spawn effect re-runs.
  const [piInstallRetry, setPiInstallRetry] = useState(0);
  const [models, setModels] = useState<string[]>([]);
  const [currentModel, setCurrentModel] = useState(initialModel ?? "");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [resumePickerOpen, setResumePickerOpen] = useState(false);
  const [currentThinking, setCurrentThinking] = useState(initialThinking ?? "");
  const [filePickerQuery, setFilePickerQuery] = useState<string | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [commandIndex, setCommandIndex] = useState(0);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [rightActivity, setRightActivity] = useState<"explorer" | "scm">(
    "explorer",
  );
  const [rightPanelWidth, setRightPanelWidth] = useState(300);
  const [expandedDiff, setExpandedDiff] = useState<string | null>(null);
  const [diffPos, setDiffPos] = useState({ x: 0, y: 0 });
  const [worktreeDiff, setWorktreeDiff] = useState<WorktreeDiff | null>(null);
  const [graphStatus, setGraphStatus] = useState<GraphStatus | null>(null);
  const [graphBusy, setGraphBusy] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [graphProgress, setGraphProgress] = useState<GraphProgress | null>(
    null,
  );
  const [graphElapsed, setGraphElapsed] = useState(0);
  const [devRunner, setDevRunner] = useState<DevRunnerInfo | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  // Global chat provisions a hidden pane immediately so the agent can use SSH/device tools
  // without asking the user to open the terminal first.
  const [terminalMounted, setTerminalMounted] = useState(globalChat);
  const [devError, setDevError] = useState<string | null>(null);
  const [pendingDevCommand, setPendingDevCommand] = useState<string | null>(
    null,
  );
  const [devStarting, setDevStarting] = useState(false);
  const [pendingMessageCount, setPendingMessageCount] = useState(0);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const [backgroundWork, setBackgroundWork] = useState<{
    runId?: string;
    startedAt: number;
  } | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [savingMessageId, setSavingMessageId] = useState<string | null>(null);
  const [pipelineStatus, setPipelineStatus] = useState<{
    step: string;
    completed: number;
    total: number;
  } | null>(null);
  const graphReportRef = useRef<string | undefined>(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const filePickerRef = useRef<FilePickerHandle>(null);
  const sessionFileRef = useRef(sessionFile);
  const modelRef = useRef(initialModel ?? "");
  const thinkingRef = useRef(initialThinking ?? "");
  const pendingTaskPromptRef = useRef("");
  const trackedTaskRef = useRef(false);
  // Dedup provider/connection errors surfaced via finalizeAssistant vs auto_retry_end within one turn.
  const surfacedErrorRef = useRef<string | null>(null);
  // message_end/turn_end and agent_end may repeat one completion with a
  // missing or different backend ID; retain content fingerprints too.
  const finalizedIdsRef = useRef(new Set<string>());
  const finalizedContentRef = useRef(new Set<string>());
  const pipelineRunRef = useRef<string | null>(null);
  const surfacedPipelineFailureRef = useRef("");
  const pendingPipelineRetryRef = useRef<{
    runId: string;
    step: string;
    attempt: number;
  } | null>(null);
  const surfacedPipelineInputRef = useRef("");
  const taskStartedAtRef = useRef<number | null>(null);
  const lastAgentActivityRef = useRef(Date.now());
  const activeToolCallsRef = useRef(new Set<string>());
  const abortResponseRef = useRef<(() => void) | null>(null);
  const latestAssistantResponseRef = useRef("");
  const receivedStreamDeltaRef = useRef(false);
  const fallbackRevealTimerRef = useRef<number | null>(null);
  const devDialogRef = useModalFocus<HTMLDivElement>(
    () => setPendingDevCommand(null),
    Boolean(pendingDevCommand) && !devStarting,
  );
  const modelDialogRef = useModalFocus<HTMLElement>(
    () => setModelPickerOpen(false),
    modelPickerOpen,
  );
  const resumeDialogRef = useModalFocus<HTMLElement>(
    () => setResumePickerOpen(false),
    resumePickerOpen,
  );
  const usageDialogRef = useModalFocus<HTMLElement>(
    () => setUsageOpen(false),
    usageOpen,
  );
  const imageDialogRef = useModalFocus<HTMLDivElement>(
    () => setPreviewImage(null),
    Boolean(previewImage),
  );
  const expandedDiffRef = useModalFocus<HTMLDivElement>(
    () => setExpandedDiff(null),
    Boolean(expandedDiff),
  );

  cwdRef.current = cwd;
  useEffect(() => {
    if (globalChat) return;
    void invoke<Array<{ path: string; repositories?: typeof repositories }>>(
      "list_projects",
    )
      .then((projects) =>
        setRepositoryStatuses(
          projects.find((project) => project.path === projectPath)
            ?.repositories ?? repositories,
        ),
      )
      .catch((error) => onToast(`Repository map: ${String(error)}`))
      .finally(() => setRepositoryMapLoaded(true));
  }, [globalChat, projectPath, repositories, onToast]);
  const sessionId = useRef(`chat-${chatId}`).current;
  const slug = useRef(
    chatId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 32),
  ).current;

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const atBottomRef = useRef(true);
  useEffect(() => {
    if (isActive) {
      atBottomRef.current = true;
    }
  }, [isActive]);
  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    atBottomRef.current = atBottom;
  }, []);
  // Jump the virtualized list to the latest output when the chat tab becomes
  // active or its history finishes loading. followOutput="auto" takes over
  // from there: it keeps the list pinned while the user sits at the bottom
  // and leaves their scroll position alone while they review history.
  useEffect(() => {
    if (!isActive || isHistoryLoading) return;
    virtuosoRef.current?.scrollToIndex({
      index: "LAST",
      align: "end",
      behavior: "auto",
    });
  }, [isActive, isHistoryLoading]);

  useEffect(() => {
    if (!isActive) return;
    setFilePickerQuery(globalChat ? null : deriveAtQuery(input));
    const textarea = inputRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
    }
  }, [input, isActive]);

  const createAssistantTurn = useCallback(
    (): ChatMessage => ({
      id: uid(),
      role: "assistant",
      text: "",
      thinking: "",
      toolCalls: [],
      createdAt: Date.now(),
      isStreaming: true,
    }),
    [],
  );

  const upsertToolCall = useCallback(
    (
      callId: string,
      patch: Partial<ToolCall> & {
        name?: string;
        args?: Record<string, unknown>;
      },
    ) => {
      setMessages((prev) => {
        const copy = ensureAssistantTurn(prev, createAssistantTurn);
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i].role === "assistant") {
            const tcs = [...copy[i].toolCalls];
            const idx = tcs.findIndex((t) => t.callId === callId);
            if (idx >= 0) tcs[idx] = { ...tcs[idx], ...patch } as ToolCall;
            else
              tcs.push({
                callId,
                name: (patch.name as string) ?? "tool",
                args: (patch.args as Record<string, unknown>) ?? {},
                ...patch,
                phase: (patch.phase as ToolCall["phase"]) ?? "start",
              } as ToolCall);
            if (tcs.length > 200) tcs.splice(0, tcs.length - 200);
            copy[i] = { ...copy[i], toolCalls: tcs };
            break;
          }
        }
        return copy;
      });
    },
    [createAssistantTurn],
  );

  // ponytail: Tauri streams deltas faster than React can paint; batch per frame.
  const pendingTextRef = useRef("");
  const pendingThinkingRef = useRef("");
  const deltaRafRef = useRef(0);
  const flushDeltas = useCallback(() => {
    deltaRafRef.current = 0;
    const text = pendingTextRef.current;
    pendingTextRef.current = "";
    const thinking = pendingThinkingRef.current;
    pendingThinkingRef.current = "";
    if (!text && !thinking) return;
    setMessages((prev) => {
      const copy = ensureAssistantTurn(prev, createAssistantTurn);
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].role === "assistant" && copy[i].isStreaming) {
          copy[i] = {
            ...copy[i],
            ...(text
              ? {
                  text: appendStreamingText(copy[i].text, text),
                }
              : null),
            ...(thinking
              ? {
                  thinking: appendStreamingText(
                    copy[i].thinking ?? "",
                    thinking,
                  ),
                }
              : null),
          };
          if (text) latestAssistantResponseRef.current = copy[i].text;
          break;
        }
      }
      return copy;
    });
  }, [createAssistantTurn]);
  const queueDeltaFlush = useCallback(() => {
    if (deltaRafRef.current) return;
    deltaRafRef.current = requestAnimationFrame(flushDeltas);
  }, [flushDeltas]);
  useEffect(
    () => () => {
      if (deltaRafRef.current) cancelAnimationFrame(deltaRafRef.current);
      if (fallbackRevealTimerRef.current)
        window.clearInterval(fallbackRevealTimerRef.current);
    },
    [],
  );
  const appendTextDelta = useCallback(
    (textDelta: string) => {
      if (!textDelta) return;
      pendingTextRef.current += textDelta;
      queueDeltaFlush();
    },
    [queueDeltaFlush],
  );

  const appendThinkingDelta = useCallback(
    (delta: string) => {
      if (!delta) return;
      pendingThinkingRef.current += delta;
      queueDeltaFlush();
    },
    [queueDeltaFlush],
  );

  useEffect(() => {
    if (globalChat) return;
    const unlisten = listen<GraphProgress>("graphify-progress", (event) =>
      setGraphProgress(event.payload),
    );
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [globalChat]);

  useEffect(() => {
    if (!graphBusy) return;
    setGraphElapsed(0);
    const started = Date.now();
    const timer = window.setInterval(
      () => setGraphElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [graphBusy]);

  const refreshGraph = useCallback(
    async (full: boolean) => {
      setGraphBusy(true);
      setGraphError(null);
      setGraphProgress({
        repository: projectName,
        index: 1,
        total: Math.max(repositories.length, 1),
        activity: "Preparing Graphify…",
      });
      try {
        const next = await invoke<GraphStatus>("build_graph", {
          projectPath,
          full,
        });
        graphReportRef.current = next.report_path;
        setGraphStatus(next);
        if (next.tracked_warning) onToast(next.tracked_warning);
        onToast(full ? "Graph built" : "Graph updated");
        if (full && !localStorage.getItem(GRAPHIGNORE_PROMPTED_KEY)) {
          const enable = await confirm({
            title: "Graphify safety net",
            message:
              "Add Graphify exclusions to ~/.gitignore_global as a safety net?",
            confirmLabel: "Add",
            cancelLabel: "Skip",
          });
          localStorage.setItem(GRAPHIGNORE_PROMPTED_KEY, "1");
          if (enable) {
            const path = await invoke<string>("enable_global_graphignore");
            onToast(`Global Graphify ignore enabled: ${path}`);
          }
        }
        return next;
      } catch (e) {
        const message = String(e);
        setGraphError(message);
        onToast(`Graphify: ${message}`);
        return null;
      } finally {
        setGraphBusy(false);
        setGraphProgress(null);
      }
    },
    [projectPath, projectName, repositories.length, onToast],
  );

  const syncKanbanTask = useCallback(
    async (status: "In Progress" | "Review", prompt?: string) => {
      try {
        const updated = await invoke<string | null>("sync_chat_task", {
          input: {
            project: projectName,
            session_id: sessionId,
            prompt,
            status,
          },
        });
        if (updated) onToast(`Kanban: ${projectName} → ${updated}`);
      } catch (error) {
        onToast(`Kanban sync: ${String(error)}`);
      }
    },
    [projectName, sessionId, onToast],
  );

  const updateGraphIfCodeStale = useCallback(async () => {
    if (globalChat) return;
    try {
      const next = await invoke<GraphStatus>("get_graph_status", {
        projectPath,
      });
      setGraphStatus(next);
      graphReportRef.current = next.report_path;
      if (next.code_stale) await refreshGraph(false);
    } catch (e) {
      onToast(`Graphify status: ${String(e)}`);
    }
  }, [projectPath, refreshGraph, onToast]);

  useEffect(() => {
    if (globalChat || !isGit || !isActive) return;
    let fingerprint: string | null | undefined;
    const check = async () => {
      try {
        const next = await invoke<string | null>("get_git_fingerprint", {
          projectPath,
        });
        if (fingerprint !== undefined && next !== fingerprint)
          await refreshGraph(false);
        fingerprint = next;
      } catch (e) {
        onToast(`Git watcher: ${String(e)}`);
      }
    };
    void check();
    const id = window.setInterval(check, 5000);
    return () => window.clearInterval(id);
  }, [isActive, isGit, projectPath, refreshGraph, onToast]);

  const refreshDiff = useCallback(async () => {
    if (!worktree && !isWorkspace) return;
    try {
      if (isWorkspace) {
        const projects =
          await invoke<
            Array<{ path: string; repositories?: typeof repositories }>
          >("list_projects");
        const fresh =
          projects.find((project) => project.path === projectPath)
            ?.repositories ?? repositories;
        setRepositoryStatuses(fresh);
        setWorktreeDiff(
          await invoke<WorktreeDiff>("get_workspace_diff", {
            repositories: fresh.map((repository) => [
              repository.name,
              `${cwdRef.current}/${repository.name}`,
              repository.base_branch ?? "main",
            ]),
          }),
        );
      } else {
        setWorktreeDiff(
          await invoke<WorktreeDiff>("get_worktree_diff", {
            worktreePath: worktree!.worktree_path,
            parentRef: worktree!.parent_ref,
          }),
        );
      }
    } catch (error) {
      onToast(String(error));
    }
  }, [worktree, isWorkspace, repositories, projectPath, onToast]);

  useEffect(() => {
    if (globalChat || !isActive || agentStatus !== "idle") return;
    void refreshDiff();
  }, [globalChat, isActive, agentStatus, refreshDiff]);

  useEffect(() => {
    if (
      globalChat ||
      !isActive ||
      agentStatus !== "running" ||
      !rightSidebarOpen ||
      rightActivity !== "scm"
    )
      return;
    void refreshDiff();
    const id = window.setInterval(refreshDiff, 2000);
    return () => window.clearInterval(id);
  }, [
    globalChat,
    isActive,
    agentStatus,
    refreshDiff,
    rightActivity,
    rightSidebarOpen,
  ]);

  useEffect(() => {
    if (agentStatus !== "running" || !isActive) return;
    const check = async () => {
      try {
        if (await invoke<boolean>("is_pi_session_running", { sessionId }))
          return;
        setAgentStatus("stopped");
        setIsStreaming(false);
        onAgentRunning(chatId, false);
        setMessages((prev) =>
          settleWithError(
            prev,
            "Agent process stopped unexpectedly — use Restart.",
          ),
        );
      } catch (error) {
        onToast(`Agent status: ${String(error)}`);
      }
    };
    const id = window.setInterval(check, 3000);
    return () => window.clearInterval(id);
  }, [agentStatus, chatId, isActive, onAgentRunning, onToast, sessionId]);

  // Elapsed timers live in <ElapsedLabel/> so ticking doesn't re-render the tree.

  useEffect(() => {
    if (agentStatus === "stopped") setBackgroundWork(null);
  }, [agentStatus]);

  // Elapsed timers live in <ElapsedLabel/> so ticking doesn't re-render the tree.

  // Elapsed timer for agent running duration lives in <ElapsedLabel/>.

  const sendRaw = useCallback(
    async (obj: Record<string, unknown>) => {
      const line = JSON.stringify(obj);
      try {
        await invoke("send_pi_command", { sessionId, jsonLine: line });
        return true;
      } catch (e) {
        const msg = String(e);
        if (
          msg.includes("crashed") ||
          msg.includes("closed") ||
          msg.includes("unknown session")
        )
          setAgentStatus("stopped");
        setIsStreaming(false);
        setMessages((prev) => settleWithError(prev, msg));
        onToast(msg);
        return false;
      }
    },
    [sessionId, onToast],
  );

  useEffect(() => {
    if (agentStatus !== "running") return;
    const id = window.setInterval(() => {
      if (
        activeToolCallsRef.current.size > 0 ||
        Date.now() - lastAgentActivityRef.current < AGENT_INACTIVITY_TIMEOUT_MS
      )
        return;
      lastAgentActivityRef.current = Date.now();
      void sendRaw({ type: "abort" });
      setAgentStatus("stopped");
      setIsStreaming(false);
      onAgentRunning(chatId, false);
      setMessages((messages) =>
        settleWithError(
          messages,
          "Provider produced no model or tool activity for 2 minutes. Restart the session or choose another model, then retry.",
        ),
      );
      onToast(
        "Provider stalled with no model or tool activity for 2 minutes — turn aborted",
      );
    }, 5_000);
    return () => window.clearInterval(id);
  }, [agentStatus, chatId, onAgentRunning, onToast, sendRaw]);

  // LISTENERS + SPAWN in one effect to avoid race: get_available_models lost if spawn before listen
  useEffect(() => {
    if (!globalChat && !repositoryMapLoaded) return;
    let mounted = true;
    const unlisteners: Array<() => void> = [];
    const retryIds: number[] = [];

    function messageContent(message: Record<string, unknown> | undefined) {
      if (!message) return { text: "", thinking: "" };
      if (typeof message.content === "string")
        return { text: message.content, thinking: "" };
      if (!Array.isArray(message.content))
        return {
          text: typeof message.text === "string" ? message.text : "",
          thinking: "",
        };
      const blocks = message.content as Array<{
        type?: string;
        text?: string;
        thinking?: string;
      }>;
      return {
        text: blocks
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("\n"),
        thinking: blocks
          .filter((block) => block.type === "thinking")
          .map((block) => block.thinking ?? block.text ?? "")
          .join("\n"),
      };
    }

    function revealFinalAssistant(content: { text: string; thinking: string }) {
      const chunkSize = 48;
      let thinkingAt = Math.min(chunkSize, content.thinking.length);
      let textAt = content.thinking
        ? 0
        : Math.min(chunkSize, content.text.length);
      setMessages((previous) =>
        previous.map((item) =>
          item.role === "assistant" && item.isStreaming
            ? {
                ...item,
                thinking: content.thinking.slice(0, thinkingAt),
                text: content.text.slice(0, textAt),
              }
            : item,
        ),
      );
      if (fallbackRevealTimerRef.current)
        window.clearInterval(fallbackRevealTimerRef.current);
      fallbackRevealTimerRef.current = window.setInterval(() => {
        if (thinkingAt < content.thinking.length)
          thinkingAt = Math.min(
            thinkingAt + chunkSize,
            content.thinking.length,
          );
        else textAt = Math.min(textAt + chunkSize, content.text.length);
        setMessages((previous) =>
          previous.map((item) =>
            item.role === "assistant" &&
            (item.isStreaming ||
              (item.thinking?.length ?? 0) < content.thinking.length ||
              item.text.length < content.text.length)
              ? {
                  ...item,
                  thinking: content.thinking.slice(0, thinkingAt),
                  text: content.text.slice(0, textAt),
                }
              : item,
          ),
        );
        if (
          thinkingAt === content.thinking.length &&
          textAt === content.text.length
        ) {
          window.clearInterval(fallbackRevealTimerRef.current!);
          fallbackRevealTimerRef.current = null;
          setMessages((previous) =>
            previous.map((item) =>
              item.role === "assistant" &&
              (item.thinking ?? "") === content.thinking &&
              item.text === content.text
                ? { ...item, isStreaming: false }
                : item,
            ),
          );
        }
      }, 18);
    }

    function finalizeAssistant(message: Record<string, unknown> | undefined) {
      if (message?.role !== "assistant") return;
      const content = messageContent(message);
      const blocks = Array.isArray(message.content)
        ? (message.content as Array<{ type?: string }>)
        : [];
      const usedTool =
        message.stopReason === "toolUse" ||
        blocks.some((block) => block.type === "toolCall");
      if (content.text)
        latestAssistantResponseRef.current = preserveStreamedContent(
          latestAssistantResponseRef.current,
          content.text,
        );
      // Provider/connection failures land here: stopReason "error" + errorMessage, usually no text/thinking/tool.
      // Surface them — otherwise the error is silently dropped and the chat shows nothing.
      const errMsg =
        message.stopReason === "error" &&
        typeof message.errorMessage === "string"
          ? message.errorMessage.trim()
          : "";
      if (errMsg && surfacedErrorRef.current !== errMsg) {
        surfacedErrorRef.current = errMsg;
        setMessages((prev) => settleWithError(prev, errMsg));
        if (!content.text && !content.thinking && !usedTool) return;
      }
      if (!content.text && !content.thinking && !usedTool) return;
      // message_end/turn_end and agent_end can deliver the same backend
      // message twice; key it so the second delivery can never append a twin.
      const backendId =
        typeof message.id === "string" && message.id ? message.id : null;
      // Final event variants can disagree on tool metadata and thinking, but
      // a repeated visible response must never make a second bubble.
      const fingerprint = content.text || `thinking\u0000${content.thinking}`;
      const alreadyFinalized =
        (backendId !== null && finalizedIdsRef.current.has(backendId)) ||
        [...finalizedContentRef.current].some((previous) =>
          sameAssistantResponse(previous, fingerprint),
        );
      if (alreadyFinalized) return;
      if (backendId) finalizedIdsRef.current.add(backendId);
      finalizedContentRef.current.add(fingerprint);
      if (
        !usedTool &&
        !receivedStreamDeltaRef.current &&
        (content.text.length > 120 || content.thinking.length > 120)
      ) {
        revealFinalAssistant(content);
        return;
      }
      setMessages((prev) => {
        const copy = [...prev];
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i].role === "assistant" && copy[i].isStreaming) {
            copy[i] = {
              ...copy[i],
              text: preserveStreamedContent(copy[i].text, content.text),
              thinking: preserveStreamedContent(
                copy[i].thinking ?? "",
                content.thinking,
              ),
            };
            return copy;
          }
        }
        // Late/duplicate final events after the streaming placeholder settled
        // must not append a twin bubble: refresh the tail in place when it
        // already holds (part of) this answer.
        const tail = copy.length > 0 ? copy[copy.length - 1] : undefined;
        if (tail && tail.role === "assistant" && !tail.isStreaming) {
          const mergedText = preserveStreamedContent(tail.text, content.text);
          const mergedThinking = preserveStreamedContent(
            tail.thinking ?? "",
            content.thinking,
          );
          if (
            mergedText === tail.text &&
            mergedThinking === (tail.thinking ?? "")
          )
            return copy;
          if (
            alreadyFinalized ||
            (tail.text !== "" &&
              mergedText === content.text &&
              mergedThinking === content.thinking)
          ) {
            copy[copy.length - 1] = {
              ...tail,
              text: usedTool ? tail.text : mergedText,
              thinking: mergedThinking,
            };
            return copy;
          }
        }
        return [
          ...copy,
          {
            id: uid(),
            role: "assistant",
            text: usedTool ? "" : content.text,
            thinking: content.thinking,
            toolCalls: [],
            createdAt: Date.now(),
            isStreaming: false,
          },
        ];
      });
    }

    async function handleRaw(raw: string) {
      if (!mounted) return;
      lastAgentActivityRef.current = Date.now();
      const entry = transcriptEntry(raw);
      if (entry)
        setAgentTranscript((previous) => {
          const last = previous[previous.length - 1];
          return last?.type === entry.type && last.detail === entry.detail
            ? previous
            : [...previous, entry].slice(-100);
        });
      try {
        const ev = JSON.parse(raw) as Record<string, unknown>;
        const t = ev.type as string | undefined;
        if (!t) return;

        if (t === "extension_ui_request") {
          const req = parseApprovalRequest(sessionId, raw);
          if (req) {
            setApproval(req);
            onUnread(chatId);
            void notifyAgent("follow-up", projectName, chatId).catch((error) =>
              onToast(`Notification: ${String(error)}`),
            );
            return;
          }
          if (ev.method === "notify") {
            const m = ev.message as string | undefined;
            if (m) onToast(m);
          }
          return;
        }

        if (t === "response") {
          const cmd = ev.command as string | undefined;
          if (cmd === "abort") {
            abortResponseRef.current?.();
            abortResponseRef.current = null;
            return;
          }
          const data = ev.data as Record<string, unknown> | undefined;
          if (!data) return;
          if (cmd === "get_commands") {
            setCommands((data.commands as SlashCommand[]) ?? []);
          } else if (cmd === "new_session") {
            setIsNewSessionLoading(false);
            if (data.cancelled !== true) {
              setMessages([]);
              setPendingMessageCount(0);
              trackedTaskRef.current = false;
              sendRaw({ type: "get_state" });
              onToast("New context started — dev server unchanged");
            }
          } else if (cmd === "switch_session" && data.cancelled !== true) {
            setMessages([]);
            historyLoadedRef.current = false;
            setIsHistoryLoading(true);
            setPendingMessageCount(0);
            trackedTaskRef.current = false;
            sendRaw({ type: "get_state" });
            sendRaw({ type: "get_messages" });
            onToast("Session resumed — dev server unchanged");
          } else if (cmd === "get_available_models") {
            const arr =
              (data.models as Array<{ id: string; provider?: string }>) ?? [];
            if (arr.length > 0) {
              setModels(
                arr.map((x) =>
                  `${x.provider ?? ""}/${x.id}`.replace(/^\//, ""),
                ),
              );
            }
          } else if (cmd === "cycle_model") {
            const model = data.model as
              | { id: string; provider?: string }
              | undefined;
            if (model) {
              const value = `${model.provider ?? ""}/${model.id}`.replace(
                /^\//,
                "",
              );
              modelRef.current = value;
              setCurrentModel(value);
            }
            if (data.thinkingLevel) {
              thinkingRef.current = String(data.thinkingLevel);
              setCurrentThinking(thinkingRef.current);
            }
          } else if (cmd === "cycle_thinking_level") {
            if (data.level) setCurrentThinking(String(data.level));
          } else if (cmd === "get_session_stats") {
            setSessionStats(data as SessionStats);
          } else if (cmd === "get_state") {
            if (typeof data.sessionFile === "string") {
              sessionFileRef.current = data.sessionFile;
              onSessionFile(chatId, data.sessionFile);
            }
            if (data.model) {
              const m = data.model as { id: string; provider?: string };
              modelRef.current = `${m.provider ?? ""}/${m.id}`.replace(
                /^\//,
                "",
              );
              setCurrentModel(modelRef.current);
            }
            if (data.thinkingLevel) {
              thinkingRef.current = String(data.thinkingLevel);
              setCurrentThinking(thinkingRef.current);
            }
            onRuntimeSettings(chatId, modelRef.current, thinkingRef.current);
          } else if (cmd === "get_messages") {
            historyLoadedRef.current = true;
            setIsHistoryLoading(false);
            const hist = data.messages as
              | Array<Record<string, unknown>>
              | undefined;
            if (hist && hist.length > 0) {
              const historicalToolResults = new Map<
                string,
                Record<string, unknown>
              >();
              for (const message of hist) {
                if (
                  message.role === "toolResult" &&
                  typeof message.toolCallId === "string"
                )
                  historicalToolResults.set(message.toolCallId, message);
              }
              const mapped: ChatMessage[] = hist
                .map((mm) => {
                  const role = (mm.role as string) ?? "assistant";
                  if (
                    role === "toolResult" ||
                    role === "bashExecution" ||
                    (role === "custom" && mm.display === false)
                  )
                    return null;
                  let text = "";
                  let historyImages: ChatImage[] = [];
                  let historyToolCalls: ToolCall[] = [];
                  if (typeof mm.content === "string") text = mm.content;
                  else if (Array.isArray(mm.content)) {
                    const content = mm.content as Array<{
                      type: string;
                      id?: string;
                      name?: string;
                      arguments?: Record<string, unknown>;
                      text?: string;
                      data?: string;
                      mimeType?: string;
                    }>;
                    text = content
                      .filter((c) => c.type === "text")
                      .map((c) => c.text ?? "")
                      .join("\n");
                    historyImages = content
                      .filter(
                        (c): c is ChatImage =>
                          c.type === "image" &&
                          typeof c.data === "string" &&
                          typeof c.mimeType === "string",
                      )
                      .map(({ type, data, mimeType }) => ({
                        type,
                        data,
                        mimeType,
                      }));
                    historyToolCalls = content
                      .filter(
                        (c) =>
                          c.type === "toolCall" &&
                          typeof c.id === "string" &&
                          c.name === "browser_screenshot",
                      )
                      .map((c) => {
                        const result = historicalToolResults.get(c.id!) as
                          | { content?: unknown; isError?: boolean }
                          | undefined;
                        return {
                          callId: c.id!,
                          name: c.name!,
                          args: c.arguments ?? {},
                          result: result?.content,
                          isError: Boolean(result?.isError),
                          phase: "end",
                        };
                      });
                  }
                  if (!text && typeof mm.text === "string")
                    text = mm.text as string;
                  if (!text && historyImages.length === 0) return null;
                  return {
                    id: (mm.id as string) ?? uid(),
                    role:
                      role === "user"
                        ? "user"
                        : role === "assistant"
                          ? "assistant"
                          : "system",
                    text: text.slice(0, 200_000),
                    images: historyImages,
                    thinking: "",
                    toolCalls: historyToolCalls,
                    createdAt:
                      typeof mm.timestamp === "number"
                        ? mm.timestamp
                        : typeof mm.timestamp === "string"
                          ? Date.parse(mm.timestamp)
                          : undefined,
                    isStreaming: false,
                  } as ChatMessage;
                })
                .filter(Boolean) as ChatMessage[];
              if (mapped.length > 0) {
                const recent = recentItems(mapped, MAX_HISTORY);
                setMessages((prev) => (prev.length === 0 ? recent : prev));
                // History is a snapshot and may arrive after a retry prompt.
                // Never let it overwrite lifecycle events such as agent_start.
              }
            }
          }
          return;
        }

        if (t === "queue_update") {
          const steering = Array.isArray(ev.steering) ? ev.steering.length : 0;
          const followUp = Array.isArray(ev.followUp) ? ev.followUp.length : 0;
          setPendingMessageCount(steering + followUp);
          return;
        }

        if (t === "agent_start") {
          setAgentTranscript([]);
          setBackgroundWork(null);
          latestAssistantResponseRef.current = "";
          receivedStreamDeltaRef.current = false;
          finalizedIdsRef.current.clear();
          finalizedContentRef.current.clear();
          setAgentStatus("running");
          onAgentRunning(chatId, true);
          setIsStreaming(true);
          setMessages((prev) => {
            const next = ensureAssistantTurn(prev, createAssistantTurn);
            return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
          });
          return;
        }
        if (t === "message_end" || t === "turn_end") {
          flushDeltas();
          finalizeAssistant(ev.message as Record<string, unknown> | undefined);
          return;
        }
        if (t === "agent_end") {
          flushDeltas();
          const generated = ev.messages as
            | Array<Record<string, unknown>>
            | undefined;
          const assistants =
            generated?.filter((message) => message.role === "assistant") ?? [];
          finalizeAssistant(assistants[assistants.length - 1]);
          activeToolCallsRef.current.clear();
          setAgentStatus("idle");
          setIsStreaming(false);
          onAgentRunning(chatId, false);
          if (!fallbackRevealTimerRef.current)
            setMessages((prev) => settleAgentMessages(prev));
          sendRaw({ type: "get_session_stats" });
          return;
        }
        if (t === "auto_retry_end") {
          // Retries exhausted — surface the final error so the user sees why the agent stopped.
          if (ev.success === false) {
            const finalError =
              typeof ev.finalError === "string" ? ev.finalError.trim() : "";
            if (finalError && surfacedErrorRef.current !== finalError) {
              surfacedErrorRef.current = finalError;
              setMessages((prev) =>
                settleWithError(
                  prev,
                  `Provider retries exhausted: ${finalError}`,
                ),
              );
            }
          }
          return;
        }
        if (t === "agent_settled") {
          setAgentStatus("idle");
          sendRaw({ type: "get_session_stats" });
          onAgentRunning(chatId, false);
          onUnread(chatId);
          setIsStreaming(false);
          const completedAt = Date.now();
          setMessages((prev) => {
            const settled = settleAgentMessages(prev);
            let index = settled.length - 1;
            while (
              index >= 0 &&
              (settled[index].role !== "assistant" || !settled[index].text)
            )
              index--;
            if (index < 0 || taskStartedAtRef.current === null) return settled;
            const copy = [...settled];
            copy[index] = {
              ...copy[index],
              durationMs: completedAt - taskStartedAtRef.current,
            };
            return copy;
          });
          taskStartedAtRef.current = null;
          surfacedErrorRef.current = null;
          void notifyAgent(
            "finished",
            projectName,
            chatId,
            latestAssistantResponseRef.current,
          ).catch((error) => onToast(`Notification: ${String(error)}`));
          void updateGraphIfCodeStale();
          if (trackedTaskRef.current) void syncKanbanTask("Review");
          return;
        }

        if (t === "message_update") {
          const delta = ev.assistantMessageEvent as
            | Record<string, unknown>
            | undefined;
          if (!delta) return;
          const dtype = delta.type as string;
          if (dtype === "text_delta") {
            receivedStreamDeltaRef.current = true;
            appendTextDelta(String(delta.delta ?? ""));
          } else if (dtype === "thinking_delta") {
            receivedStreamDeltaRef.current = true;
            appendThinkingDelta(String(delta.delta ?? ""));
          } else if (dtype === "toolcall_start") {
            const tc = delta.toolCall as
              | {
                  id?: string;
                  name?: string;
                  arguments?: Record<string, unknown>;
                }
              | undefined;
            const callId = tc?.id ?? (delta.toolCallId as string | undefined);
            const name = tc?.name ?? (delta.toolName as string | undefined);
            const args =
              tc?.arguments ?? (delta.args as Record<string, unknown>) ?? {};
            if (callId && name)
              upsertToolCall(callId, { name, args, phase: "start", callId });
            if (name === "track_kanban_task") {
              const status = args.status === "Done" ? "Done" : "In Progress";
              const description =
                typeof args.description === "string"
                  ? args.description
                  : pendingTaskPromptRef.current;
              trackedTaskRef.current = status !== "Done";
              void invoke<string | null>("sync_chat_task", {
                input: {
                  project: projectName,
                  session_id: sessionId,
                  prompt: description,
                  status,
                },
              })
                .then(
                  (updated) =>
                    updated && onToast(`Kanban: ${projectName} → ${updated}`),
                )
                .catch((error) => onToast(`Kanban sync: ${String(error)}`));
            }
          } else if (dtype === "toolcall_delta") {
            const callId = delta.toolCallId as string | undefined;
            if (callId)
              upsertToolCall(callId, {
                args: (delta.args as Record<string, unknown>) ?? {},
                phase: "delta",
                callId,
              });
          } else if (dtype === "toolcall_end") {
            const tc = delta.toolCall as
              | {
                  id?: string;
                  name?: string;
                  arguments?: Record<string, unknown>;
                }
              | undefined;
            const callId = tc?.id ?? (delta.toolCallId as string | undefined);
            const name = tc?.name ?? (delta.toolName as string) ?? "tool";
            const args =
              tc?.arguments ?? (delta.args as Record<string, unknown>) ?? {};
            if (callId)
              upsertToolCall(callId, { name, args, phase: "end", callId });
          }
          return;
        }

        if (t === "tool_execution_start") {
          const callId = String(ev.toolCallId ?? uid());
          const name = String(ev.toolName ?? "tool");
          const args = (ev.args as Record<string, unknown>) ?? {};
          toolArgsRef.current.set(callId, args);
          activeToolCallsRef.current.add(callId);
          upsertToolCall(callId, { name, args, phase: "start", callId });
          return;
        }
        if (t === "tool_execution_update") {
          if (ev.toolCallId) {
            const callId = String(ev.toolCallId);
            upsertToolCall(callId, {
              phase: "delta",
              callId,
              result: ev.partialResult as unknown,
            });
          }
          return;
        }
        if (t === "tool_execution_end") {
          if (!ev.toolCallId) return;
          const callId = String(ev.toolCallId);
          const name = String(ev.toolName ?? "");
          const endArgs = ev.args as Record<string, unknown> | undefined;
          const args =
            endArgs && Object.keys(endArgs).length
              ? endArgs
              : (toolArgsRef.current.get(callId) ?? {});
          toolArgsRef.current.delete(callId);
          activeToolCallsRef.current.delete(callId);
          upsertToolCall(callId, {
            phase: "end",
            callId,
            result: ev.result as unknown,
            isError: Boolean(ev.isError),
          });
          const launchedBackgroundWork = backgroundAgentWork(
            name,
            ev.result,
            Boolean(ev.isError),
          );
          if (launchedBackgroundWork)
            setBackgroundWork({
              ...launchedBackgroundWork,
              startedAt: Date.now(),
            });
          if (
            !ev.isError &&
            name === "run_pipeline" &&
            (await confirm({
              title: "Run pipeline",
              message: `Run saved pipeline for ${projectName}?`,
              confirmLabel: "Run",
              cancelLabel: "Cancel",
            }))
          ) {
            void invoke<string>("start_pipeline", {
              projectPath,
              executionCwd: cwdRef.current,
              initiatorSessionId: sessionId,
            })
              .then(() => {
                onToast(`Pipeline started: ${projectName}`);
              })
              .catch((error) => onToast(`Pipeline: ${String(error)}`));
          }
          if (!ev.isError && name === "report_recurring_error") {
            const title = typeof args.title === "string" ? args.title : "";
            const rootCause =
              typeof args.rootCause === "string" ? args.rootCause : "";
            const prevention =
              typeof args.prevention === "string" ? args.prevention : "";
            if (title && rootCause && prevention) {
              const draft = `Error: ${title}\n\nRoot cause:\n${rootCause}\n\nPrevention:\n${prevention}`;
              if (
                await confirm({
                  title: "Save Backlog task",
                  message: `Save this error report as a Backlog task?\n\n${draft}`,
                  confirmLabel: "Save",
                  cancelLabel: "Discard",
                })
              ) {
                void invoke<string>("create_error_report_task", {
                  input: {
                    project: projectName,
                    sessionId,
                    title,
                    rootCause,
                    prevention,
                  },
                })
                  .then((status) => onToast(`Error report saved: ${status}`))
                  .catch((error) => onToast(`Error report: ${String(error)}`));
              }
            }
          }
          if (!ev.isError && name === "execute_terminal_command") {
            const command =
              typeof args.command === "string" ? args.command : "";
            if (command && terminalCommandIsDestructive(command))
              setTerminalApproval({ data: command });
          }
          if (!ev.isError && name === "write_chat_terminal") {
            const pane =
              typeof args.pane === "string" && /^\d+$/.test(args.pane)
                ? args.pane
                : "0";
            const data = typeof args.data === "string" ? args.data : "";
            if (data && terminalCommandIsDestructive(data))
              setTerminalApproval({ pane, data });
            else if (data) {
              void invoke("terminal_write", {
                chatId: `${chatId}__${pane}`,
                data,
              }).catch((error) => onToast(`Terminal: ${String(error)}`));
            }
          }
          if (!ev.isError && name === "provide_pipeline_input") {
            const message =
              typeof args.message === "string" ? args.message : "";
            const paths = Array.isArray(args.paths)
              ? args.paths.filter(
                  (path): path is string => typeof path === "string",
                )
              : [];
            if (
              message &&
              paths.length &&
              (await confirm({
                title: "Commit files",
                message: `Commit these files?\n\n${paths.join("\n")}\n\nMessage: ${message}`,
                confirmLabel: "Commit",
                cancelLabel: "Cancel",
              }))
            ) {
              void invoke("get_pipeline_data", { projectPath })
                .then((data) => {
                  const pending = (
                    data as {
                      pending_input?: {
                        nonce: string;
                        run_id: string;
                        step_id: string;
                        execution_cwd: string;
                        initiator_session_id?: string | null;
                      };
                    }
                  ).pending_input;
                  if (
                    !pending ||
                    pending.initiator_session_id !== sessionId ||
                    pending.execution_cwd !== cwdRef.current
                  )
                    throw new Error(
                      "Pipeline input request no longer matches this chat",
                    );
                  return invoke("provide_pipeline_input", {
                    projectPath,
                    input: {
                      nonce: pending.nonce,
                      runId: pending.run_id,
                      stepId: pending.step_id,
                      mode: "ai_commit",
                      sessionId,
                      executionCwd: cwdRef.current,
                      value: null,
                      message,
                      paths,
                    },
                  });
                })
                .catch((error) => onToast(`Pipeline: ${String(error)}`));
            }
          }
          if (
            !ev.isError &&
            name === "control_pipeline" &&
            ["retry", "skip", "cancel"].includes(String(args.action))
          ) {
            const action = String(args.action);
            const allowed =
              action === "retry" ||
              (await confirm({
                title: action === "skip" ? "Skip step" : "Cancel pipeline",
                message: `${action === "skip" ? "Skip failed step" : "Cancel pipeline"} for ${projectName}?`,
                confirmLabel: action === "skip" ? "Skip" : "Cancel pipeline",
                cancelLabel: "Keep running",
                danger: action !== "skip",
              }));
            if (allowed) {
              const command =
                action === "retry"
                  ? "retry_pipeline_step"
                  : action === "skip"
                    ? "skip_pipeline_step"
                    : "cancel_pipeline";
              void invoke(command, { projectPath }).catch((error) =>
                onToast(`Pipeline: ${String(error)}`),
              );
            }
          }
          return;
        }
      } catch {
        // ignore parse
      }
    }

    async function run() {
      // listeners FIRST
      const u1 = await listen<PiEventPayload>("pi-rpc-event", (e) => {
        if (e.payload.session_id !== sessionId) return;
        handleRaw(e.payload.raw);
      });
      if (!mounted) {
        u1();
        return;
      }
      unlisteners.push(u1);
      const stopWithError = (error: string) => {
        historyLoadedRef.current = true;
        setIsHistoryLoading(false);
        setIsNewSessionLoading(false);
        setAgentStatus("stopped");
        setIsStreaming(false);
        onAgentRunning(chatId, false);
        setMessages((prev) => settleWithError(prev, error));
        onToast(error);
      };
      const u2 = await listen<{ session_id: string; cwd_exists: boolean }>(
        "pi-rpc-ended",
        (e) => {
          if (e.payload.session_id !== sessionId) return;
          setDriveDetached(!e.payload.cwd_exists);
          stopWithError(
            e.payload.cwd_exists
              ? "Agent process stopped unexpectedly — use Restart."
              : "Drive detached — reconnect drive, then retry.",
          );
        },
      );
      unlisteners.push(u2);
      const u3 = await listen<{ session_id: string; error: string }>(
        "pi-rpc-error",
        (e) => {
          if (e.payload.session_id !== sessionId) return;
          stopWithError(e.payload.error);
        },
      );
      unlisteners.push(u3);
      const u4 = await listen<{ session_id: string; line: string }>(
        "pi-rpc-stderr",
        (e) => {
          if (
            e.payload.session_id !== sessionId ||
            !shouldToastPiStderr(e.payload.line)
          )
            return;
          const line = e.payload.line.slice(0, 2_000);
          setAgentTranscript((previous) =>
            [
              ...previous,
              { id: uid(), type: "stderr", detail: line, at: Date.now() },
            ].slice(-100),
          );
          setMessages((prev) => appendAgentLog(prev, line));
          onToast(`pi stderr: ${line.slice(0, 180)}`);
        },
      );
      unlisteners.push(u4);

      try {
        if (globalChat) {
          const globalCwd = await invoke<string>("get_global_chat_cwd");
          setCwd(globalCwd);
          const [provider, ...modelParts] = modelRef.current.split("/");
          await invoke("spawn_pi_rpc", {
            sessionId,
            cwd: globalCwd,
            sessionFile: sessionFileRef.current,
            provider: modelParts.length ? provider : undefined,
            model: modelParts.length
              ? modelParts.join("/")
              : modelRef.current || undefined,
            thinking: thinkingRef.current || undefined,
            globalChat: true,
            customSystemPrompt,
          });
        } else {
          let graph = await invoke<GraphStatus>("get_graph_status", {
            projectPath,
          });
          if (!mounted) return;
          setGraphStatus(graph);
          graphReportRef.current = graph.report_path;
          if (graph.tracked_warning) onToast(graph.tracked_warning);
          if (graph.code_stale) {
            // Keep the existing graph available to Pi while the incremental refresh runs.
            void refreshGraph(false);
          }
          graphReportRef.current = graph.report_path;

          if (isWorkspace) {
            const workspaceCwd = await invoke<string>(
              "ensure_workspace_session",
              { workspacePath: projectPath, slug },
            );
            setCwd(workspaceCwd);
            const [provider, ...modelParts] = modelRef.current.split("/");
            await invoke("spawn_pi_rpc", {
              sessionId,
              cwd: workspaceCwd,
              sessionFile: sessionFileRef.current,
              provider: modelParts.length ? provider : undefined,
              model: modelParts.length
                ? modelParts.join("/")
                : modelRef.current || undefined,
              thinking: thinkingRef.current || undefined,
              graphReportPath: graphReportRef.current,
              projectName,
            });
          } else if (!isGit) {
            setCwd(projectPath);
            const [provider, ...modelParts] = modelRef.current.split("/");
            await invoke("spawn_pi_rpc", {
              sessionId,
              cwd: projectPath,
              sessionFile: sessionFileRef.current,
              provider: modelParts.length ? provider : undefined,
              model: modelParts.length
                ? modelParts.join("/")
                : modelRef.current || undefined,
              thinking: thinkingRef.current || undefined,
              graphReportPath: graphReportRef.current,
              projectName,
            });
          } else {
            const wt = await invoke<WorktreeInfo>("ensure_worktree", {
              repoPath: projectPath,
              repoName: projectName,
              slug,
            });
            if (!mounted) return;
            setWorktree(wt);
            setCwd(wt.worktree_path);
            setDevRunner(
              await invoke<DevRunnerInfo | null>("get_dev_server", {
                chatId,
                cwd: wt.worktree_path,
              }),
            );
            const [provider, ...modelParts] = modelRef.current.split("/");
            await invoke("spawn_pi_rpc", {
              sessionId,
              cwd: wt.worktree_path,
              sessionFile: sessionFileRef.current,
              provider: modelParts.length ? provider : undefined,
              model: modelParts.length
                ? modelParts.join("/")
                : modelRef.current || undefined,
              thinking: thinkingRef.current || undefined,
              graphReportPath: graphReportRef.current,
              projectName,
            });
          }
        }

        const initial = () => {
          sendRaw({ type: "get_available_models" });
          sendRaw({ type: "get_commands" });
          sendRaw({ type: "get_state" });
          sendRaw({ type: "get_messages" });
          sendRaw({ type: "get_session_stats" });
        };
        historyLoadedRef.current = !sessionFileRef.current;
        initial();
        setChatReady(true);
        if (sessionFileRef.current) {
          retryIds.push(
            window.setTimeout(
              () =>
                mounted &&
                !historyLoadedRef.current &&
                sendRaw({ type: "get_messages" }),
              3000,
            ),
          );
          retryIds.push(
            window.setTimeout(() => {
              if (!mounted || historyLoadedRef.current) return;
              historyLoadedRef.current = true;
              setIsHistoryLoading(false);
              onToast(
                "Chat history restore timed out — the session is ready; retry by reopening it.",
              );
            }, 15000),
          );
        }
        // pi boot takes time for extensions, retry models
        retryIds.push(
          window.setTimeout(
            () => mounted && sendRaw({ type: "get_available_models" }),
            2000,
          ),
        );
        retryIds.push(
          window.setTimeout(
            () => mounted && sendRaw({ type: "get_available_models" }),
            5000,
          ),
        );
        retryIds.push(
          window.setTimeout(
            () => mounted && sendRaw({ type: "get_available_models" }),
            9000,
          ),
        );
      } catch (e) {
        const msg = String(e);
        historyLoadedRef.current = true;
        setIsHistoryLoading(false);
        if (msg.includes("PI_INSTALL_REQUIRED:")) {
          // Pi CLI is missing: never auto-install a remote script — ask for
          // explicit consent first, then retry the spawn after approval.
          const install = await confirm({
            title: "Install Pi CLI?",
            message:
              "Pi CLI not found. Download and install from https://pi.dev/install.sh?",
            confirmLabel: "Install",
            cancelLabel: "Cancel",
            danger: true,
          });
          if (install && mounted) {
            try {
              await invoke("approve_pi_install");
              onToast("Pi installed — restarting chat session.");
              setPiInstallRetry((n) => n + 1);
            } catch (installError) {
              const installMsg = String(installError);
              setMessages((prev) => settleWithError(prev, installMsg));
              onToast(installMsg);
            }
          } else if (mounted) {
            setMessages((prev) =>
              settleWithError(
                prev,
                "Pi CLI is required to start this chat session.",
              ),
            );
          }
          return;
        }
        if (
          msg.includes("detached") ||
          msg.includes("not found") ||
          msg.includes("does not exist")
        )
          setDriveDetached(true);
        setMessages((prev) => settleWithError(prev, msg));
        onToast(msg);
      }
    }

    run();
    return () => {
      mounted = false;
      setChatReady(false);
      retryIds.forEach(clearTimeout);
      unlisteners.forEach((u) => u());
    };
  }, [
    projectPath,
    projectName,
    isGit,
    isWorkspace,
    repositoryMapLoaded,
    globalChat,
    customSystemPrompt,
    slug,
    chatId,
    sessionId,
    sendRaw,
    onToast,
    onSessionFile,
    onAgentRunning,
    onUnread,
    appendTextDelta,
    appendThinkingDelta,
    flushDeltas,
    upsertToolCall,
    refreshGraph,
    updateGraphIfCodeStale,
    syncKanbanTask,
    piInstallRetry,
  ]);

  useEffect(() => {
    if (globalChat || !devRunner || !isActive) return;
    const id = window.setInterval(async () => {
      try {
        const runner = await invoke<DevRunnerInfo | null>("get_dev_server", {
          chatId,
          cwd,
        });
        if (!runner?.running) {
          const message = `Dev server stopped unexpectedly.${runner?.error ? `\n\n${runner.error}` : " No log output available."}`;
          setDevError(message);
          setDevRunner(null);
          onToast(message);
          return;
        }
        setDevRunner(runner);
      } catch (error) {
        const message = `Dev server status failed: ${String(error)}`;
        setDevError(message);
        setDevRunner(null);
        onToast(message);
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [chatId, cwd, devRunner, isActive, onToast]);

  async function readAttachments() {
    if (!files.length) return "";
    const paths = files.map((file) => file.path);
    try {
      const attachments = await invoke<ChatAttachment[]>(
        "read_chat_attachments",
        { projectPath, paths },
      );
      return attachmentContext(attachments);
    } catch (error) {
      if (
        !String(error).includes("PDF support requires pdftotext") ||
        !(await confirm({
          title: "Install Poppler",
          message: "PDF support needs Poppler. Install it with Homebrew now?",
          confirmLabel: "Install",
          cancelLabel: "Cancel",
        }))
      )
        throw error;
      onToast("Installing Poppler…");
      await invoke("install_poppler");
      const attachments = await invoke<ChatAttachment[]>(
        "read_chat_attachments",
        { projectPath, paths },
      );
      onToast("Poppler installed.");
      return attachmentContext(attachments);
    }
  }

  async function taskContext(text: string) {
    if (globalChat) return "";
    const intent = projectTaskIntent(text);
    if (!intent) return "";
    try {
      const tasks =
        intent.kind === "detail"
          ? [
              await invoke<Record<string, unknown>>("get_project_task", {
                project: projectName,
                taskNo: intent.taskNo,
              }),
            ]
          : await invoke<Array<Record<string, unknown>>>("list_project_tasks", {
              project: projectName,
              pic: null,
              status: null,
            });
      return `\n\n<authoritative_project_tasks>\n${JSON.stringify(tasks)}\n</authoritative_project_tasks>\nAnswer the user's task question only from this authoritative data. Do not infer tasks from Graphify, repository files, tests, or SonarQube. Do not discuss your reasoning.\n`;
    } catch (error) {
      onToast(`Task context: ${String(error)}`);
      return "";
    }
  }

  async function sendPrompt(text: string) {
    if (
      !chatReady ||
      !text.trim() ||
      driveDetached ||
      agentStatus === "stopped"
    )
      return false;
    if (text) onFirstMessage(chatId, text.replace(/\s+/g, " ").slice(0, 60));
    taskStartedAtRef.current ??= Date.now();
    setMessages((prev) =>
      [
        ...prev,
        {
          id: uid(),
          role: "user",
          text,
          images: [],
          thinking: "",
          toolCalls: [],
          createdAt: Date.now(),
        } as ChatMessage,
      ].slice(-MAX_HISTORY),
    );
    pendingTaskPromptRef.current = text;
    await sendRaw({
      type: "prompt",
      message: `${text}${await taskContext(text)}`,
      images: [],
    });
    return true;
  }

  async function sendWithSkill(text: string) {
    const context = globalChat
      ? await invoke<string>("get_rag_context", { query: text }).catch(
          (error) => {
            onToast(`RAG: ${String(error)}`);
            return "";
          },
        )
      : await taskContext(text);
    await sendRaw({ type: "prompt", message: `${text}${context}`, images });
  }

  async function handleSend() {
    const text = input.trim();
    if (
      !chatReady ||
      (!text && images.length === 0 && files.length === 0) ||
      driveDetached ||
      agentStatus === "stopped"
    )
      return;
    let fileContext = "";
    try {
      fileContext = await readAttachments();
    } catch (error) {
      onToast(`File attachment: ${String(error)}`);
      return;
    }
    const message = `${text}${fileContext}`;
    const visibleMessage =
      text || files.map((file) => `@${file.name}`).join(" ");
    if (visibleMessage)
      onFirstMessage(chatId, visibleMessage.replace(/\s+/g, " ").slice(0, 60));
    taskStartedAtRef.current ??= Date.now();
    setMessages((prev) => {
      const next = [
        ...prev,
        {
          id: uid(),
          role: "user",
          text: visibleMessage,
          images,
          thinking: "",
          toolCalls: [],
          createdAt: Date.now(),
        } as ChatMessage,
      ];
      return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
    });
    setInput("");
    setImages([]);
    setFiles([]);
    pendingTaskPromptRef.current = message;
    await sendWithSkill(message);
  }

  useEffect(() => {
    if (!initialDraft || input) return;
    setInput(initialDraft);
    onInitialDraftConsumed?.();
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [initialDraft, input, onInitialDraftConsumed]);

  useEffect(() => {
    if (
      !initialPrompt ||
      !chatReady ||
      messages.length > 0 ||
      agentStatus !== "idle"
    )
      return;
    void sendPrompt(initialPrompt).then((sent) => {
      if (sent) onInitialPromptConsumed?.();
    });
  }, [initialPrompt, chatReady, agentStatus, messages.length]);

  useEffect(() => {
    const useSkill = (event: Event) => {
      const name = (event as CustomEvent<string>).detail;
      if (!name || !chatReady) return;
      setInput(`/skill:${name}`);
      inputRef.current?.focus();
    };
    window.addEventListener("crc-skill-ready", useSkill);
    return () => window.removeEventListener("crc-skill-ready", useSkill);
  }, [chatReady]);

  async function attachFiles() {
    try {
      const paths = await open({
        multiple: true,
        title: "Attach files to chat",
      });
      if (!paths) return;
      const selected = (Array.isArray(paths) ? paths : [paths]).map((path) => ({
        path,
        name: path.split(/[\\/]/).pop() || path,
      }));
      setFiles((current) => [
        ...current,
        ...selected.filter(
          (file) => !current.some((item) => item.path === file.path),
        ),
      ]);
    } catch (error) {
      onToast(`File attachment: ${String(error)}`);
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (files.length > 0) {
      event.preventDefault();
      files.forEach((file) => {
        const reader = new FileReader();
        reader.onload = () => {
          const data = String(reader.result).split(",", 2)[1];
          if (data)
            setImages((prev) => [
              ...prev,
              { type: "image", data, mimeType: file.type },
            ]);
        };
        reader.onerror = () =>
          onToast(`Couldn't paste ${file.name || "image"}`);
        reader.readAsDataURL(file);
      });
      return;
    }
    const plain = event.clipboardData.getData("text/plain");
    if (plain) {
      const mdTable = tsvToMarkdown(plain);
      if (mdTable) {
        event.preventDefault();
        const ta = event.currentTarget;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const before = input.slice(0, start);
        const after = input.slice(end);
        // ensure blank lines around table for markdown rendering
        let newValue: string;
        if (!before.trim()) {
          newValue =
            mdTable + (after ? "\n\n" + after.replace(/^\n+/, "") : "\n");
        } else {
          const b = before.endsWith("\n\n")
            ? before
            : before.endsWith("\n")
              ? before + "\n"
              : before + "\n\n";
          const a = after.startsWith("\n\n")
            ? after
            : after.startsWith("\n")
              ? "\n" + after
              : after
                ? "\n\n" + after
                : "\n";
          newValue = b + mdTable + a;
        }
        setInput(newValue);
        requestAnimationFrame(() => {
          const pos = newValue.indexOf(mdTable) + mdTable.length + 2;
          ta.selectionStart = ta.selectionEnd = Math.min(pos, newValue.length);
        });
      }
    }
  }

  useEffect(() => {
    if (globalChat) return;
    let initialized = false;
    const check = () => {
      if (!isActive) return;
      void invoke<{
        current?: {
          run_id: string;
          project_path: string;
          status: string;
          initiator_session_id?: string | null;
          stages: Array<{
            name: string;
            status: string;
            log?: string;
            failure_policy?: string;
            attempts?: number;
          }>;
        };
        runs: Array<{
          run_id: string;
          project_path: string;
          status: string;
          initiator_session_id?: string | null;
          stages: Array<{
            name: string;
            status: string;
            log?: string;
            failure_policy?: string;
            attempts?: number;
          }>;
        }>;
      }>("get_pipeline_data", { projectPath })
        .then((data) => {
          const owns = (run: { initiator_session_id?: string | null }) =>
            run.initiator_session_id === sessionId;
          const current =
            data.current && owns(data.current) ? data.current : undefined;
          const ownedRuns = data.runs.filter(owns);
          const archived = ownedRuns.filter((item) => item.status === "failed");
          if (!initialized) {
            archived.forEach((run) =>
              run.stages
                .filter((stage) => stage.status === "fail")
                .forEach((stage) =>
                  surfacedPipelineFailures.add(
                    `${run.run_id}:${stage.name}:${stage.attempts}`,
                  ),
                ),
            );
            initialized = true;
          }
          const pendingRetry = pendingPipelineRetryRef.current;
          if (pendingRetry) {
            const retryRun =
              current?.run_id === pendingRetry.runId
                ? current
                : data.runs.find(
                    (item) => owns(item) && item.run_id === pendingRetry.runId,
                  );
            const retryStage = retryRun?.stages.find(
              (stage) => stage.name === pendingRetry.step,
            );
            const retryAttempt = retryStage?.attempts ?? 0;
            if (
              retryStage &&
              retryAttempt > pendingRetry.attempt &&
              retryStage.status !== "running"
            ) {
              const succeeded = retryStage.status === "pass";
              const text = succeeded
                ? `Pipeline retry passed: ${pendingRetry.step} completed on attempt ${retryAttempt}.`
                : `Pipeline retry failed: ${pendingRetry.step} failed again on attempt ${retryAttempt}.\n\n${retryStage.log || "No command output captured."}`;
              setMessages((messages) => [
                ...messages,
                {
                  id: uid(),
                  role: "assistant",
                  text,
                  thinking: "",
                  toolCalls: [],
                  createdAt: Date.now(),
                } as ChatMessage,
              ]);
              onToast(
                succeeded
                  ? `Pipeline recovered: ${pendingRetry.step}`
                  : `Pipeline retry failed: ${pendingRetry.step}`,
              );
              surfacedPipelineFailures.add(
                `${pendingRetry.runId}:${pendingRetry.step}:${retryAttempt}`,
              );
              pendingPipelineRetryRef.current = null;
            }
          }
          const pendingInput = (
            data as unknown as {
              pending_input?: {
                nonce: string;
                run_id: string;
                step_id: string;
                mode: string;
                step: string;
                prompt: string;
                options: string[];
                execution_cwd: string;
                initiator_session_id?: string | null;
              };
            }
          ).pending_input;
          const pendingMatchesChat =
            pendingInput?.execution_cwd === cwdRef.current &&
            pendingInput.initiator_session_id === sessionId;
          const pendingKey = pendingMatchesChat ? pendingInput.nonce : "";
          if (
            pendingMatchesChat &&
            pendingInput?.mode === "ai_commit" &&
            surfacedPipelineInputRef.current !== pendingKey
          ) {
            surfacedPipelineInputRef.current = pendingKey;
            void sendRaw({
              type: agentStatus === "running" ? "steer" : "prompt",
              message: `${pendingInput.prompt} Inspect git diff/status in the active worktree. Then call provide_pipeline_input with a one-line conventional commit message and only explicit relative modified paths belonging to this task. Do not use git add -A and do not commit directly.`,
            });
          }
          if (!pendingMatchesChat) surfacedPipelineInputRef.current = "";
          const completed =
            pipelineRunRef.current && !current
              ? ownedRuns.find(
                  (item) =>
                    item.run_id === pipelineRunRef.current &&
                    item.status === "done",
                )
              : undefined;
          if (completed) {
            const passed = completed.stages.filter(
              (stage) => stage.status === "pass",
            ).length;
            setMessages((messages) => [
              ...messages,
              {
                id: uid(),
                role: "assistant",
                text: `Pipeline completed · ${passed}/${completed.stages.length} stages passed.`,
                thinking: "",
                toolCalls: [],
                createdAt: Date.now(),
              } as ChatMessage,
            ]);
            onToast(`Pipeline completed: ${projectName}`);
            void notifyAgent(
              "finished",
              `Pipeline completed · ${projectName}`,
              chatId,
            ).catch(() => {});
            pipelineRunRef.current = null;
          }
          if (current) {
            pipelineRunRef.current = current.run_id;
            const stages = current.stages;
            const activeStage =
              stages.find((stage) => stage.status === "running")?.name ??
              "Waiting for input";
            const status = {
              step: activeStage,
              completed: stages.filter((stage) =>
                ["pass", "skip"].includes(stage.status),
              ).length,
              total: stages.length,
            };
            setPipelineStatus(status);
          } else {
            setPipelineStatus(null);
          }
          const currentFailure = current?.stages.find(
            (stage) =>
              stage.status === "fail" && stage.failure_policy !== "continue",
          );
          const run = currentFailure
            ? current
            : archived.find((item) =>
                item.stages.some(
                  (stage) =>
                    stage.status === "fail" &&
                    !surfacedPipelineFailures.has(
                      `${item.run_id}:${stage.name}:${stage.attempts}`,
                    ),
                ),
              );
          if (!run) return;
          const failed = run.stages.find(
            (stage) =>
              stage.status === "fail" && stage.failure_policy !== "continue",
          );
          if (!failed) return;
          const key = `${run.run_id}:${failed.name}:${failed.attempts}`;
          if (surfacedPipelineFailures.has(key)) return;
          surfacedPipelineFailures.add(key);
          surfacedPipelineFailureRef.current = key;
          const output = failed.log?.trim() || "No command output captured.";
          setMessages((messages) => [
            ...messages,
            {
              id: uid(),
              role: "assistant",
              text: `Pipeline failed · ${failed.name}\nPolicy: ${failed.failure_policy ?? "stop"} · Attempt: ${failed.attempts ?? 1}\n\n${output}`,
              thinking: "",
              toolCalls: [],
              createdAt: Date.now(),
            } as ChatMessage,
          ]);
          pendingPipelineRetryRef.current = {
            runId: run.run_id,
            step: failed.name,
            attempt: failed.attempts ?? 1,
          };
          const request =
            failed.failure_policy === "ai_fix"
              ? `Pipeline step ${failed.name} failed. First explain the concrete root cause to the user using the command output below. Then inspect and fix the project only if safe. Before calling control_pipeline retry, state exactly what you changed and why retry should pass. Never retry silently. Command output:\n${output}`
              : `Pipeline step ${failed.name} failed and requires user confirmation. Explain the concrete root cause from the output, then ask whether to retry, skip, or abort. Do not take action before the user chooses. Command output:\n${output}`;
          const logLines = failed.log?.split("\n").filter(Boolean) ?? [];
          onToast(
            `Pipeline failed: ${failed.name}${logLines.length ? ` — ${logLines[logLines.length - 1]}` : ""}`,
          );
          void notifyAgent(
            "follow-up",
            `Pipeline failed · ${projectName}`,
            chatId,
          ).catch(() => {});
          void sendRaw({
            type: agentStatus === "running" ? "steer" : "prompt",
            message: request,
          });
        })
        .catch(() => {});
    };
    check();
    const timer = window.setInterval(check, 3000);
    return () => window.clearInterval(timer);
  }, [
    agentStatus,
    chatId,
    isActive,
    onToast,
    projectName,
    projectPath,
    sendRaw,
  ]);

  async function handleApprovalResponse(payload: Record<string, unknown>) {
    setApproval(null);
    await sendRaw(payload);
  }

  async function handleAbort() {
    if (isAborting) return;
    setIsAborting(true);
    setBackgroundWork(null);
    try {
      const aborted = new Promise<void>((resolve) => {
        const timeout = window.setTimeout(resolve, 15_000);
        abortResponseRef.current = () => {
          window.clearTimeout(timeout);
          resolve();
        };
      });
      if (!(await sendRaw({ type: "abort" }))) return;
      await aborted;
      setAgentStatus("idle");
      setIsStreaming(false);
      setMessages((prev) =>
        prev.map((message) =>
          message.isStreaming ? { ...message, isStreaming: false } : message,
        ),
      );
      onAgentRunning(chatId, false);
      onToast("Agent aborted");
    } finally {
      abortResponseRef.current = null;
      setIsAborting(false);
    }
  }

  const handleRestart = useCallback(
    async (retry = false) => {
      if (isRestarting) return;
      setIsRestarting(true);
      setDriveDetached(false);
      setBackgroundWork(null);
      try {
        await invoke("kill_pi_session", { sessionId }).catch(() => {});
        const [provider, ...modelParts] = modelRef.current.split("/");
        await invoke("spawn_pi_rpc", {
          sessionId,
          cwd,
          sessionFile: sessionFileRef.current,
          provider: modelParts.length ? provider : undefined,
          model: modelParts.length
            ? modelParts.join("/")
            : modelRef.current || undefined,
          thinking: thinkingRef.current || undefined,
          graphReportPath: globalChat ? undefined : graphReportRef.current,
          globalChat,
          customSystemPrompt,
          projectName,
        });
        setAgentStatus("idle");
        setMessages(clearRestartErrors);
        onToast(retry ? "Agent retrying" : "Pi agent reloaded");
        setTimeout(() => {
          sendRaw({ type: "get_available_models" });
          sendRaw({ type: "get_commands" });
          sendRaw({ type: "get_state" });
          sendRaw({ type: "get_messages" });
          sendRaw({ type: "get_session_stats" });
          if (retry)
            sendRaw({
              type: "prompt",
              message:
                "Continue the interrupted task from where you left off. Check the current state first and do not repeat completed work.",
            });
        }, 300);
      } catch (e) {
        setAgentStatus("stopped");
        onToast(String(e));
        if (String(e).includes("detached")) setDriveDetached(true);
      } finally {
        setIsRestarting(false);
      }
    },
    [
      customSystemPrompt,
      cwd,
      globalChat,
      isRestarting,
      onToast,
      projectName,
      sendRaw,
      sessionId,
    ],
  );

  const handleFixPiIssue = useCallback(
    async (issue: ChatMessage) => {
      if (fixingPiIssueId || !isPiRuntimeIssue(issue.text)) return;
      setFixingPiIssueId(issue.id);
      const sent = await sendRaw({
        type: agentStatus === "running" ? "steer" : "prompt",
        message: `Diagnose and fix this Pi runtime issue. Inspect the relevant Pi configuration or extension package first. Apply only a safe, minimal fix; do not remove extensions or change global configuration unless necessary. Verify the result and summarize the change.\n\n${issue.text}`,
      });
      if (sent) onToast("AI is diagnosing the Pi issue");
      setFixingPiIssueId(null);
    },
    [agentStatus, fixingPiIssueId, onToast, sendRaw],
  );

  async function handleOpenTerminal() {
    setTerminalMounted(true);
    setShowTerminal((v) => !v);
  }

  async function handleRunDev() {
    try {
      const key = `crc-dev-command:${projectPath}`;
      const saved = localStorage.getItem(key);
      setPendingDevCommand(
        saved ?? (await invoke<string>("detect_dev_command", { cwd })),
      );
    } catch (error) {
      const message = String(error);
      setDevError(message);
      onToast(message);
    }
  }

  async function confirmRunDev() {
    if (!pendingDevCommand || devStarting) return;
    setDevStarting(true);
    try {
      localStorage.setItem(`crc-dev-command:${projectPath}`, pendingDevCommand);
      setDevRunner(
        await invoke<DevRunnerInfo>("start_dev_server", {
          chatId,
          cwd,
          command: pendingDevCommand,
        }),
      );
      setDevError(null);
      setPendingDevCommand(null);
      onToast(`Dev server started: ${pendingDevCommand}`);
    } catch (error) {
      const message = String(error);
      setDevError(message);
      onToast(message);
    } finally {
      setDevStarting(false);
    }
  }

  async function handleStopDev() {
    await invoke("stop_dev_server", { chatId }).catch((error) =>
      onToast(String(error)),
    );
    setDevRunner(null);
  }

  async function handleClose() {
    if (isStreaming) {
      onToast("Still streaming — abort first.");
      return;
    }
    let removed = false;
    if (worktree && isGit) {
      removed = await invoke<boolean>("remove_worktree", {
        repoPath: projectPath,
        worktreePath: worktree.worktree_path,
        parentRef: worktree.parent_ref,
      }).catch(() => false);
      if (!removed) {
        const discard = await confirm({
          title: "Discard chat changes?",
          message:
            "This worktree has changes or commits that have not been merged. Permanently delete the worktree and its branch?",
          confirmLabel: "Discard and delete",
          cancelLabel: "Keep chat",
          danger: true,
        });
        if (!discard) return;
      }
    }

    setBackgroundWork(null);
    try {
      await invoke("stop_dev_server", { chatId }).catch(() => {});
      await invoke("kill_pi_session", { sessionId }).catch(() => {});
      if (worktree && isGit && !removed) {
        await invoke("force_remove_worktree", {
          repoPath: projectPath,
          worktreePath: worktree.worktree_path,
        });
        removed = true;
      }
      if (removed) onToast(`Worktree removed: ${worktree?.worktree_path}`);
      onClose();
    } catch (error) {
      onToast(`Close chat: ${String(error)}`);
    }
  }

  async function handleSetModel(m: string) {
    if (!m) return;
    modelRef.current = m;
    setCurrentModel(m);
    onRuntimeSettings(chatId, m, thinkingRef.current);
    const parts = m.split("/");
    const provider = parts.length > 1 ? parts[0] : undefined;
    const modelId = parts.length > 1 ? parts.slice(1).join("/") : m;
    await sendRaw({
      type: "set_model",
      provider: provider || undefined,
      modelId,
    });
    setModelPickerOpen(false);
  }

  async function handleSetThinking(lvl: string) {
    thinkingRef.current = lvl;
    setCurrentThinking(lvl);
    onRuntimeSettings(chatId, modelRef.current, lvl);
    await sendRaw({ type: "set_thinking_level", level: lvl });
  }

  const tablePreviews = useMemo(() => extractMarkdownTables(input), [input]);

  const atHint =
    filePickerQuery !== null
      ? `Searching: ${filePickerQuery || "(all)"} — ↑↓ navigate · Enter/Tab insert.`
      : "";
  function openModelPicker() {
    setModelPickerOpen(true);
  }
  const slashQuery =
    input.startsWith("/") && !input.includes(" ")
      ? input.slice(1).toLowerCase()
      : null;
  const clientCommands: SlashCommand[] = [
    {
      name: "new",
      description: "Start fresh context; keep worktree and dev server",
      source: "client",
    },
    {
      name: "resume",
      description: "Resume a project session; keep worktree and dev server",
      source: "client",
    },
    { name: "model", description: "Choose the active model", source: "client" },
    { name: "thinking", description: "Set reasoning level", source: "client" },
    {
      name: "compact",
      description: "Compact session context",
      source: "client",
    },
    {
      name: "sync",
      description: "Sync app-owned Pi extensions and reload this chat",
      source: "client",
    },
    {
      name: "research",
      description: "Run cited Deep Research in this chat",
      source: "client",
    },
  ];
  const slashCommands =
    slashQuery === null
      ? []
      : [...clientCommands, ...commands]
          .filter(
            (command, index, all) =>
              command.name.toLowerCase().includes(slashQuery) &&
              all.findIndex((item) => item.name === command.name) === index,
          )
          .slice(0, 12);

  function chooseCommand(command: SlashCommand) {
    if (command.name === "model") {
      setInput("");
      openModelPicker();
    } else if (command.name === "thinking" || command.name === "research")
      setInput(`/${command.name} `);
    else setInput(`/${command.name}`);
    setCommandIndex(0);
  }

  function handleFilePick(f: { name: string; path: string; relative: string }) {
    const atIdx = input.lastIndexOf("@");
    if (atIdx === -1) return;
    const before = input.slice(0, atIdx);
    const after = input.slice(atIdx + 1);
    const tokenEnd = after.search(/[\s\n]/);
    const rest = tokenEnd === -1 ? "" : after.slice(tokenEnd);
    setInput(`${before}@${f.relative} ${rest}`.trimStart() + " ");
    setFiles((current) =>
      current.some((file) => file.path === f.path) ? current : [...current, f],
    );
    setFilePickerQuery(null);
  }

  function handleRemoveTable() {
    // remove table block from input
    const lines = input.split("\n");
    const cleaned = [] as string[];
    let skipping = false;
    for (const l of lines) {
      const t = l.trim();
      if (!skipping && t.startsWith("|") && /\|/.test(t)) {
        // naive: skip all consecutive | lines that include separator
        if (
          /^\|\s*:?-{2,}/.test(t) ||
          (cleaned.length > 0 &&
            cleaned[cleaned.length - 1]?.trim().startsWith("|"))
        ) {
          skipping = true;
        }
      }
      if (skipping) {
        if (!t.startsWith("|") && t !== "") {
          skipping = false;
          cleaned.push(l);
        }
        continue;
      }
      cleaned.push(l);
    }
    setInput(cleaned.join("\n").trim());
  }

  async function submitInput(
    submitMode: "prompt" | "follow_up" | "steer" = "prompt",
  ) {
    const text = input.trim();
    const query = researchQuery(text);
    if (query !== null) {
      if (!query) {
        setResearchUsageError(true);
        return;
      }
      setResearchUsageError(false);
      if (images.length || files.length) {
        onToast("Remove attachments before starting Deep Research");
        return;
      }
      if (researchBusy || researchResults.some(isActiveResearch)) {
        onToast("Another Deep Research run is active");
        return;
      }
      if (
        !(await confirm({
          title: "Run Deep Research",
          message: `${query}\n\nThis spins up a multi-step web research job that uses tokens.`,
          confirmLabel: "Run",
          cancelLabel: "Cancel",
        }))
      )
        return;
      setResearchBusy(true);
      try {
        const slash = modelRef.current.indexOf("/");
        const run = await invoke<ResearchRun>("start_deep_research", {
          input: {
            query,
            model:
              slash < 0
                ? modelRef.current || null
                : modelRef.current.slice(slash + 1),
            provider: slash < 0 ? null : modelRef.current.slice(0, slash),
            thinking: thinkingRef.current || null,
            originChatId: chatId,
            originSessionId: sessionId,
          },
        });
        setResearchResults((runs) => [
          run,
          ...runs.filter((item) => item.id !== run.id),
        ]);
        setInput("");
        onToast("Deep Research started");
      } catch (error) {
        onToast(`Deep Research failed: ${String(error)}`);
      } finally {
        setResearchBusy(false);
      }
      return;
    }
    if (text === "/new") {
      setInput("");
      setIsNewSessionLoading(true);
      if (!(await sendRaw({ type: "new_session" })))
        setIsNewSessionLoading(false);
      return;
    }
    if (text === "/resume") {
      setInput("");
      if (resumableSessions.length === 0)
        onToast("No other saved sessions for this project");
      else setResumePickerOpen(true);
      return;
    }
    if (text === "/compact") {
      setInput("");
      await sendRaw({ type: "compact" });
      return;
    }
    if (text === "/sync") {
      setInput("");
      try {
        await invoke("sync_pi_extensions");
        await handleRestart(false);
        onToast("Pi extensions synced");
      } catch (error) {
        onToast(`Pi sync: ${String(error)}`);
      }
      return;
    }
    if (text === "/model") {
      setInput("");
      openModelPicker();
      return;
    }
    if (text.startsWith("/model ")) {
      await handleSetModel(text.slice(7).trim());
      setInput("");
      return;
    }
    if (text.startsWith("/thinking ")) {
      await handleSetThinking(text.slice(10).trim());
      setInput("");
      return;
    }
    if (agentStatus === "running") {
      if (!text && images.length === 0 && files.length === 0) return;
      let fileContext = "";
      try {
        fileContext = await readAttachments();
      } catch (error) {
        onToast(`File attachment: ${String(error)}`);
        return;
      }
      const messageText = `${text}${fileContext}`;
      const type = submitMode === "steer" ? "steer" : "follow_up";
      setMessages((prev) => {
        const message = {
          id: uid(),
          role: "user",
          text: messageText,
          images,
          thinking: "",
          toolCalls: [],
          createdAt: Date.now(),
        } as ChatMessage;
        const next =
          type === "steer"
            ? insertSteerMessage(prev, message)
            : [...prev, message];
        return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
      });
      setInput("");
      setImages([]);
      setFiles([]);
      if (type === "follow_up") setPendingMessageCount((count) => count + 1);
      await sendRaw({ type, message: messageText, images });
      onToast(
        type === "steer"
          ? "Steering current turn"
          : "Message queued for next turn",
      );
      return;
    }
    await handleSend();
  }

  useEffect(() => {
    function applySavedSettings(event: Event) {
      const settings = (event as CustomEvent<Record<string, unknown>>).detail;
      if (
        typeof settings.defaultProvider === "string" &&
        typeof settings.defaultModel === "string"
      ) {
        sendRaw({
          type: "set_model",
          provider: settings.defaultProvider,
          modelId: settings.defaultModel,
        });
      }
      if (typeof settings.defaultThinkingLevel === "string")
        sendRaw({
          type: "set_thinking_level",
          level: settings.defaultThinkingLevel,
        });
      const compaction = settings.compaction as
        | Record<string, unknown>
        | undefined;
      if (typeof compaction?.enabled === "boolean")
        sendRaw({ type: "set_auto_compaction", enabled: compaction.enabled });
      const retry = settings.retry as Record<string, unknown> | undefined;
      if (typeof retry?.enabled === "boolean")
        sendRaw({ type: "set_auto_retry", enabled: retry.enabled });
      if (
        settings.steeringMode === "all" ||
        settings.steeringMode === "one-at-a-time"
      )
        sendRaw({ type: "set_steering_mode", mode: settings.steeringMode });
      if (
        settings.followUpMode === "all" ||
        settings.followUpMode === "one-at-a-time"
      )
        sendRaw({ type: "set_follow_up_mode", mode: settings.followUpMode });
      setTimeout(() => sendRaw({ type: "get_state" }), 100);
    }
    window.addEventListener("pi-settings-saved", applySavedSettings);
    return () =>
      window.removeEventListener("pi-settings-saved", applySavedSettings);
  }, [sendRaw]);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (!isActive || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (agentStatus === "running") void handleAbort();
      } else if (event.ctrlKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        openModelPicker();
      } else if (event.ctrlKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        sendRaw({ type: "cycle_model" });
      } else if (event.key === "Tab" && event.shiftKey) {
        event.preventDefault();
        sendRaw({ type: "cycle_thinking_level" });
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [agentStatus, sendRaw, models, currentModel, isActive]);

  const loadResearchResults = useCallback(async () => {
    const data = await invoke<{ runs: ResearchRun[] }>(
      "get_deep_research_data",
    );
    setResearchResults(
      data.runs.filter(
        (run) =>
          run.origin_chat_id === chatId && run.origin_session_id === sessionId,
      ),
    );
  }, [chatId, sessionId]);

  useEffect(() => {
    void loadResearchResults().catch(() => {});
    const unlisten = listen(
      "deep-research-changed",
      () => void loadResearchResults().catch(() => {}),
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [loadResearchResults]);

  const handleResearchCompleted = useCallback(
    async (run: ResearchRun) => {
      if (
        !chatReady ||
        run.origin_chat_id !== chatId ||
        run.origin_session_id !== sessionId ||
        researchHandoffRef.current
      )
        return;
      researchHandoffRef.current = run.id;
      setResearchHandoffError(null);
      try {
        const result = await invoke<{
          outcome: "delivered" | "no_op";
          run: ResearchRun;
        }>("handoff_deep_research", {
          runId: run.id,
          originSessionId: sessionId,
        });
        if (result.outcome === "delivered" || result.run.handoff_delivered) {
          await loadResearchResults();
          setMessages((messages) => [
            ...messages,
            {
              id: uid(),
              role: "system",
              text: "Deep Research selesai. Laporan dan sitasinya sudah ditambahkan ke konteks chat ini — lanjutkan dengan pertanyaan follow-up.",
              thinking: "",
              toolCalls: [],
              createdAt: Date.now(),
            },
          ]);
          window.setTimeout(() => inputRef.current?.focus(), 0);
          onToast("Deep Research accepted by this chat process");
        }
      } catch (error) {
        const message = String(error);
        setResearchHandoffError(message);
        onToast(`Research context handoff failed: ${message}`);
      } finally {
        researchHandoffRef.current = null;
      }
    },
    [chatId, chatReady, loadResearchResults, onToast, sessionId],
  );

  useEffect(() => {
    const completed = researchResults.find(
      (run) =>
        run.state === "completed" &&
        !run.handoff_delivered &&
        run.handoff_state !== "delivering",
    );
    if (completed) void handleResearchCompleted(completed);
  }, [handleResearchCompleted, researchResults]);

  async function researchAction(command: string, run: ResearchRun) {
    setResearchBusy(true);
    try {
      await invoke(command, { runId: run.id });
      await loadResearchResults();
    } catch (error) {
      onToast(`Deep Research: ${String(error)}`);
    } finally {
      setResearchBusy(false);
    }
  }

  const lastAssistantId = [...messages]
    .reverse()
    .find((message) => message.role === "assistant")?.id;

  // ponytail: settled rows keep element identity across streaming frames,
  // so React bails out and only the live message re-renders.
  const rowCacheRef = useRef(
    new Map<
      string,
      {
        message: ChatMessage;
        diff: typeof worktreeDiff;
        approval: typeof terminalApproval;
        restart: typeof handleRestart;
        refresh: typeof refreshDiff;
        send: typeof sendRaw;
        toast: typeof onToast;
        flags: string;
        node: ReactNode;
      }
    >(),
  );
  const rowFlags = `${chatId}|${copiedMessageId}|${savingMessageId}|${agentStatus}|${messages[messages.length - 1]?.id}|${worktreeDiff?.files.length}|${lastAssistantId}|${isRestarting}|${fixingPiIssueId}|${globalChat}|${terminalApprovalStatus}`;
  if (rowCacheRef.current.size > messages.length + 32) {
    const alive = new Set(messages.map((message) => message.id));
    for (const id of rowCacheRef.current.keys())
      if (!alive.has(id)) rowCacheRef.current.delete(id);
  }

  // Chronological feed driving the virtualized message list. Message and
  // research rows interleave by their original flex `order` keys so the
  // virtual list renders in exactly the same visual order as before.
  const feedItems = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = [];
    if (isNewSessionLoading) items.push({ kind: "session-loading", order: -2 });
    if (
      messages.length === 0 &&
      researchResults.length === 0 &&
      !isNewSessionLoading
    )
      items.push({ kind: "history-state", order: -1 });
    for (const run of [...researchResults].reverse()) {
      items.push(
        { kind: "research-request", run, order: run.created_at * 1000 },
        { kind: "research-report", run, order: run.created_at * 1000 + 1 },
      );
    }
    for (const message of messages)
      items.push({ kind: "message", message, order: message.createdAt ?? 0 });
    if (backgroundWork && agentStatus !== "running")
      items.push({
        kind: "background-work",
        order: Number.MAX_SAFE_INTEGER - 1,
      });
    if (agentStatus === "running" || isRestarting)
      items.push({
        kind: "agent-activity",
        order: Number.MAX_SAFE_INTEGER - 1,
      });
    // Stable sort: equal order keys keep insertion order, matching the old
    // CSS flexbox behavior for research pairs and trailing indicators.
    items.sort((a, b) => a.order - b.order);
    return items;
  }, [
    isNewSessionLoading,
    messages,
    researchResults,
    backgroundWork,
    agentStatus,
    isRestarting,
  ]);

  // Renders one virtualized feed row. Unchanged message rows are served from
  // rowCacheRef so streamed tokens only re-render the active row.
  const renderFeedItemInner = (item: FeedItem): ReactNode => {
    if (item.kind === "session-loading") {
      return (
        <div className="session-loading" role="status" aria-live="polite">
          <span className="agent-working-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <div>
            <strong>STARTING NEW CONTEXT</strong>
            <small>KEEPING WORKTREE AND DEV SERVER</small>
          </div>
        </div>
      );
    }
    if (item.kind === "history-state") {
      return isHistoryLoading ? (
        <div className="session-loading" role="status" aria-live="polite">
          <span className="agent-working-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <div>
            <strong>LOADING SESSION</strong>
            <small>RESTORING CHAT HISTORY</small>
          </div>
        </div>
      ) : (
        <div
          className="display-sm"
          style={{
            color: "var(--colors-muted)",
            marginTop: "var(--spacing-xl)",
          }}
        >
          AGENT IDLE. SEND PROMPT.
        </div>
      );
    }
    if (item.kind === "research-request") {
      const run = item.run;
      return (
        <div className="chat-bubble-user body-md">/research {run.query}</div>
      );
    }
    if (item.kind === "research-report") {
      const run = item.run;
      const report = run.final_report ?? run.partial_report;
      return (
        <article
          className={`research-result-card${isActiveResearch(run) ? " is-active" : ""}`}
          aria-live={isActiveResearch(run) ? "polite" : undefined}
        >
          <small>
            {isActiveResearch(run) && (
              <span className="research-live-mark" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            )}
            Deep Research · {run.progress.phase || run.state} ·{" "}
            {elapsedResearch(run.created_at)}
          </small>
          <h3>{run.query}</h3>
          {isActiveResearch(run) ? (
            <p>{run.progress.activity || "Preparing research…"}</p>
          ) : report ? (
            <div className="research-inline-report">
              <MarkdownMessage>{report}</MarkdownMessage>
            </div>
          ) : null}
          {run.error && <p className="research-run-error">{run.error}</p>}
          {researchHandoffError &&
            run.state === "completed" &&
            !run.handoff_delivered && (
              <p className="research-run-error" role="alert">
                Context handoff failed: {researchHandoffError}
              </p>
            )}
          <footer>
            <span>
              {run.progress.searches} searches · {run.progress.reads} reads ·{" "}
              {run.progress.checks} checks · {run.sources.length} sources
            </span>
            <div>
              {isActiveResearch(run) && (
                <button
                  disabled={researchBusy}
                  onClick={() =>
                    void researchAction("cancel_deep_research", run)
                  }
                >
                  Cancel
                </button>
              )}
              {canResumeResearch(run) && (
                <button
                  disabled={researchBusy}
                  onClick={() =>
                    void researchAction("resume_deep_research", run)
                  }
                >
                  Resume
                </button>
              )}
              {researchHandoffError &&
                run.state === "completed" &&
                !run.handoff_delivered && (
                  <button onClick={() => void handleResearchCompleted(run)}>
                    Retry context handoff
                  </button>
                )}
              <button onClick={() => onOpenResearch(run.id)}>
                Open full report
              </button>
            </div>
          </footer>
        </article>
      );
    }
    if (item.kind === "message") {
      const m = item.message;
      const cachedRow = rowCacheRef.current.get(m.id);
      if (
        cachedRow &&
        cachedRow.message === m &&
        cachedRow.diff === worktreeDiff &&
        cachedRow.approval === terminalApproval &&
        cachedRow.restart === handleRestart &&
        cachedRow.refresh === refreshDiff &&
        cachedRow.send === sendRaw &&
        cachedRow.toast === onToast &&
        cachedRow.flags === rowFlags
      )
        return cachedRow.node;
      const node = (
        <div
          key={m.id}
          className={
            m.role === "user"
              ? `chat-bubble-user body-md${m.images?.length ? " has-images" : ""}${!m.text ? " image-only" : ""}`
              : m.role === "system"
                ? "chat-notice body-sm"
                : "chat-bubble-assistant body-md"
          }
        >
          {m.role === "system" && <small>PI CONTEXT</small>}
          {m.thinking && (
            <ThinkingBlock isStreaming={Boolean(m.isStreaming)}>
              {m.thinking}
            </ThinkingBlock>
          )}
          {m.images && m.images.length > 0 && (
            <div className="chat-images">
              {m.images.map((image, index) => (
                <button
                  key={index}
                  onClick={() => setPreviewImage(image)}
                  aria-label={`Preview attachment ${index + 1}`}
                >
                  <img
                    src={`data:${image.mimeType};base64,${image.data}`}
                    alt="Pasted attachment"
                  />
                </button>
              ))}
            </div>
          )}
          {m.toolCalls
            .filter((tool) => tool.name === "recommend_global_skills")
            .map((tool) => {
              const skills = Array.isArray(tool.args.skills)
                ? tool.args.skills.filter(
                    (name): name is string => typeof name === "string",
                  )
                : [];
              return skills.length ? (
                <section
                  className="skill-recommendation"
                  key={tool.callId}
                  role="status"
                >
                  <div>
                    <small>SKILL RECOMMENDATION</small>
                    <strong>{skills.join(" · ")}</strong>
                    <span>
                      {typeof tool.args.reason === "string"
                        ? tool.args.reason
                        : "Recommended by the agent."}
                    </span>
                  </div>
                  <div>
                    {skills.map((name) => (
                      <button
                        key={name}
                        onClick={() => {
                          setInput(`/skill:${name}`);
                          inputRef.current?.focus();
                        }}
                      >
                        Use {name}
                      </button>
                    ))}
                  </div>
                </section>
              ) : null;
            })}
          {m.toolCalls
            .filter((tool) => isWebSearchTool(tool.name))
            .map((tool) => (
              <ToolCallView key={tool.callId} tc={tool} />
            ))}
          {m.toolCalls.some(
            (tool) =>
              !isWebSearchTool(tool.name) &&
              tool.name !== "recommend_global_skills",
          ) &&
            (() => {
              const tools = m.toolCalls.filter(
                (tool) =>
                  !isWebSearchTool(tool.name) &&
                  tool.name !== "recommend_global_skills",
              );
              return (
                <details className="tool-stack">
                  <summary>
                    <span className="tool-stack-icon">
                      {tools.some((tool) => tool.phase !== "end") ? "◌" : "✓"}
                    </span>
                    <strong>
                      {tools.length} TOOL{" "}
                      {tools.length === 1 ? "CALL" : "CALLS"}
                    </strong>
                    <span>
                      {tools
                        .map((tool) => tool.name)
                        .filter(
                          (name, index, all) => all.indexOf(name) === index,
                        )
                        .join(" · ")}
                    </span>
                    <small>DETAILS</small>
                  </summary>
                  <div className="tool-stack-items">
                    {tools.map((tool) => (
                      <ToolCallView key={tool.callId} tc={tool} />
                    ))}
                  </div>
                </details>
              );
            })()}
          {m.toolCalls
            .filter((tool) => browserScreenshotRef(tool))
            .map((tool) => (
              <BrowserScreenshot key={`screenshot-${tool.callId}`} tc={tool} />
            ))}
          {m.toolCalls.length === 0 && browserScreenshotRefFromText(m.text) && (
            <BrowserScreenshot
              tc={{
                callId: `restored-${m.id}`,
                name: "browser_screenshot",
                args: {},
                phase: "end",
                result: {
                  data: {
                    artifactRef: browserScreenshotRefFromText(m.text),
                  },
                },
              }}
            />
          )}
          {m.text && (
            <MarkdownMessage isStreaming={m.isStreaming}>
              {m.text}
            </MarkdownMessage>
          )}
          {m.role === "assistant" && m.text && !m.isStreaming && (
            <div className="chat-actions">
              <button
                className="chat-copy"
                onClick={() =>
                  navigator.clipboard
                    .writeText(m.text)
                    .then(() => {
                      setCopiedMessageId(m.id);
                      window.setTimeout(
                        () =>
                          setCopiedMessageId((id) => (id === m.id ? null : id)),
                        1600,
                      );
                    })
                    .catch((error) => onToast(`Copy failed: ${String(error)}`))
                }
                aria-label="Copy assistant response"
                title="Copy response"
              >
                {copiedMessageId === m.id ? "✓ COPIED" : "⧉ COPY"}
              </button>
              <button
                className="chat-retry-inline"
                onClick={() => {
                  const lastUser = [...messages]
                    .reverse()
                    .find((item) => item.role === "user");
                  if (lastUser?.text) {
                    setInput(lastUser.text);
                    inputRef.current?.focus();
                  }
                }}
                aria-label="Try again with last prompt"
                title="Copy last prompt back to composer"
              >
                ↻ TRY AGAIN
              </button>
              {globalChat && (
                <details className="chat-save">
                  <summary>
                    {savingMessageId === m.id ? "SAVING…" : "+ SAVE AS"}
                  </summary>
                  <div
                    className="chat-save-options"
                    aria-label="Save response as"
                  >
                    {["knowledge", "memory", "context", "skill"].map((kind) => (
                      <button
                        key={kind}
                        disabled={savingMessageId === m.id}
                        onClick={async (event) => {
                          const details =
                            event.currentTarget.closest("details");
                          setSavingMessageId(m.id);
                          try {
                            await invoke("save_rag_chat_response", {
                              text: m.text,
                              kind,
                            });
                            onToast(`Saved as ${kind}.`);
                            details?.removeAttribute("open");
                          } catch (error) {
                            onToast(`Save failed: ${String(error)}`);
                          } finally {
                            setSavingMessageId(null);
                          }
                        }}
                      >
                        {kind}
                        <small>
                          {kind === "knowledge"
                            ? "Reusable answer"
                            : kind === "context"
                              ? "Chat reference"
                              : kind === "memory"
                                ? "Stored preference"
                                : "Reusable procedure"}
                        </small>
                      </button>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
          {m.role === "system" && shouldOfferRestart(m.text) && (
            <button
              onClick={() => handleRestart(true)}
              className="chat-restart"
              disabled={isRestarting}
            >
              {isRestarting ? "RESTARTING…" : "↻ RESTART CHAT"}
            </button>
          )}
          {m.role === "system" && isPiRuntimeIssue(m.text) && (
            <button
              onClick={() => void handleFixPiIssue(m)}
              className="chat-restart"
              disabled={fixingPiIssueId !== null}
            >
              {fixingPiIssueId === m.id ? "AI IS FIXING…" : "✦ FIX WITH AI"}
            </button>
          )}
          {(m.createdAt || m.durationMs) && (
            <div className="chat-message-meta">
              {m.createdAt && (
                <time dateTime={new Date(m.createdAt).toISOString()}>
                  {formatMessageTime(m.createdAt)}
                </time>
              )}
              {m.role === "assistant" && m.durationMs && (
                <span title="Task completion time">
                  SELESAI DALAM {formatTaskDuration(m.durationMs)}
                </span>
              )}
            </div>
          )}
          {agentStatus === "stopped" &&
            m.role === "user" &&
            m.id === messages[messages.length - 1]?.id && (
              <button
                onClick={() => handleRestart(true)}
                className="chat-retry"
                title="Retry interrupted task"
                aria-label="Retry interrupted task"
              >
                ↻
              </button>
            )}
          {worktreeDiff &&
            shouldShowChanges(
              m,
              lastAssistantId,
              worktreeDiff.files.length,
            ) && (
              <details className="chat-changes">
                <summary>
                  <strong>FILES CHANGED</strong>
                  <span>{worktreeDiff.files.length}</span>
                </summary>
                {worktreeDiff.files.map((file) => (
                  <button
                    key={`${file.repository ?? ""}:${file.path}`}
                    onClick={() => setExpandedDiff(file.path)}
                  >
                    <span>{file.status}</span>
                    <b>
                      {file.repository && <small>{file.repository}</small>}
                      {file.path}
                    </b>
                    <i>+{file.added}</i>
                    <em>-{file.removed}</em>
                  </button>
                ))}
              </details>
            )}
          {m.id === lastAssistantId && terminalApproval && (
            <section className="terminal-command-approval" role="alert">
              <small>AGENT REQUEST · TERMINAL COMMAND</small>
              <pre>{terminalApproval.data}</pre>
              <div>
                <button
                  className="approval-primary"
                  onClick={() => {
                    const request = terminalApproval;
                    setTerminalApprovalStatus("executing");
                    const approved = request.pane
                      ? invoke("terminal_write", {
                          chatId: `${chatId}__${request.pane}`,
                          data: request.data,
                        }).then(
                          () =>
                            `Command sent to pane ${request.pane}. Read its output now.`,
                        )
                      : invoke<string>("terminal_execute_approved", {
                          cwd: cwdRef.current,
                          command: request.data,
                        });
                    void approved
                      .then(async (output) => {
                        setTerminalApprovalStatus("refreshing");
                        await refreshDiff();
                        setTerminalApproval(null);
                        return sendRaw({
                          type: agentStatus === "running" ? "steer" : "prompt",
                          message: `The user approved the destructive terminal command.\n\nExecution result:\n${output}\n\nContinue the task now and report the outcome.`,
                        });
                      })
                      .catch((error) => {
                        const message = `Approved terminal command failed: ${String(error)}`;
                        onToast(message);
                        void sendRaw({
                          type: agentStatus === "running" ? "steer" : "prompt",
                          message,
                        });
                      })
                      .finally(() => setTerminalApprovalStatus(null));
                  }}
                  disabled={terminalApprovalStatus !== null}
                >
                  {terminalApprovalStatus === "executing"
                    ? "EXECUTING…"
                    : terminalApprovalStatus === "refreshing"
                      ? "REFRESHING CHANGES…"
                      : "✅ Approve"}
                </button>
                <button
                  disabled={terminalApprovalStatus !== null}
                  onClick={() => {
                    setTerminalApproval(null);
                    void sendRaw({
                      type: agentStatus === "running" ? "steer" : "prompt",
                      message:
                        "Terminal command denied by the user. Do not execute it; explain alternatives if needed.",
                    });
                    onToast("Terminal command denied");
                  }}
                >
                  ❌ Deny
                </button>
              </div>
            </section>
          )}
        </div>
      );
      rowCacheRef.current.set(m.id, {
        message: m,
        diff: worktreeDiff,
        approval: terminalApproval,
        restart: handleRestart,
        refresh: refreshDiff,
        send: sendRaw,
        toast: onToast,
        flags: rowFlags,
        node,
      });
      return node;
    }
    if (item.kind === "background-work") {
      // Guarded by the feedItems condition; narrows the type here.
      if (!backgroundWork) return null;
      return (
        <div
          className="agent-working activity-nodes phase-executing"
          role="status"
          aria-live="polite"
        >
          <span className="agent-working-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <div>
            <strong>BACKGROUND AGENT WORKING</strong>
            <small className="agent-working-detail">
              {backgroundWork.runId
                ? `Run ${backgroundWork.runId}`
                : "Detached task in progress"}
            </small>
          </div>
          <span className="agent-working-stats">
            <span>
              <ElapsedLabel
                startedAt={backgroundWork.startedAt}
                ticking={isActive}
              />
            </span>
          </span>
        </div>
      );
    }
    if (item.kind === "agent-activity") {
      return (() => {
        const allTools = messages.flatMap((message) => message.toolCalls);
        const allActive = allTools.filter((tool) => tool.phase !== "end");
        const activeTool = [...allActive].reverse()[0];
        const completedCount = allTools.filter(
          (tool) => tool.phase === "end",
        ).length;
        const completedApiCount = allTools.filter(
          (tool) =>
            tool.phase === "end" &&
            /(?:^|\.)(?:api_request|api_contract_test)$/.test(tool.name),
        ).length;
        const lastCompleted = [...allTools]
          .reverse()
          .find((tool) => tool.phase === "end");
        const streamingMsg = [...messages]
          .reverse()
          .find((m) => m.role === "assistant" && m.isStreaming);
        const streamingText = streamingMsg?.text?.trim() || "";
        const thinkingText = streamingMsg?.thinking?.trim() || "";
        const activeRequest = [...messages]
          .reverse()
          .find((m) => m.role === "user" && m.text.trim())
          ?.text.replace(/\s+/g, " ")
          .trim()
          .slice(0, 90);

        // Multi sub-agent aggregation
        const activeSubagents = allActive.filter((t) => isSubagentTool(t.name));
        const primarySubagent = [...activeSubagents].reverse()[0];
        const subMeta = primarySubagent
          ? getSubagentMeta(primarySubagent.args)
          : null;
        const totalSubagentTasks = activeSubagents.reduce(
          (acc, t) => acc + getSubagentMeta(t.args).count,
          0,
        );

        let title: string;
        let detail: string;
        let icon: string;
        let phase: "executing" | "writing" | "thinking";

        if (isRestarting) {
          phase = "thinking";
          title = "RESTARTING PI";
          detail = "Starting the agent session";
          icon = "meter";
        } else if (activeTool) {
          phase = "executing";
          const build = buildPhase(activeTool);
          const isMultiSub = activeSubagents.length > 0 && subMeta;
          if (build) {
            title = "BUILDING";
            detail = build;
            icon = "build";
          } else if (isMultiSub && subMeta) {
            title =
              totalSubagentTasks > 1 || activeSubagents.length > 1
                ? `SUB-AGENTS WORKING (${activeSubagents.length > 1 ? `${activeSubagents.length} CALLS · ` : ""}${totalSubagentTasks} TASKS)`
                : "SUB-AGENT WORKING";
            detail =
              totalSubagentTasks > 1
                ? `${totalSubagentTasks} ${subMeta.mode === "CHAIN" ? "STAGES" : "CHILD AGENTS"} · ${subMeta.mode}`
                : subMeta.detail;
            icon = "nodes";
          } else if (isWebSearchTool(activeTool.name)) {
            title = "SEARCHING WEB";
            detail = describeToolActivity(activeTool);
            icon = "search";
          } else if (
            /(?:^|\.)(?:api_request|api_contract_test)$/.test(activeTool.name)
          ) {
            title = "TESTING API";
            detail = describeToolActivity(activeTool);
            icon = "api";
          } else {
            const kind = activityKind(activeTool.name);
            if (kind === "process") {
              title = "RUNNING SESSION";
              detail = "Interactive shell";
              icon = "terminal";
            } else if (kind === "index") {
              title = "INDEXING";
              detail = "Building knowledge graph";
              icon = "graph";
            } else if (kind === "loop") {
              title = "ITERATING";
              detail = "Autonomous pass";
              icon = "loop";
            } else {
              title = "EXECUTING";
              detail = describeToolActivity(activeTool);
              icon = "meter";
            }
          }
        } else if (streamingText) {
          phase = "writing";
          const lastLine =
            streamingText.split("\n").filter(Boolean).pop()?.slice(0, 55) || "";
          title = "RESPONDING";
          detail = lastLine
            ? `${lastLine}${lastLine.length >= 55 ? "…" : ""}`
            : "Writing response";
          icon = "meter";
        } else {
          phase = "thinking";
          const lastLine =
            thinkingText.split("\n").filter(Boolean).pop()?.slice(0, 55) || "";
          if (lastLine) {
            title = "REASONING";
            detail = `${lastLine}${lastLine.length >= 55 ? "…" : ""}`;
          } else if (lastCompleted) {
            title = "PLANNING NEXT";
            detail = describeToolActivity(lastCompleted);
          } else {
            title = "THINKING";
            detail = activeRequest
              ? `Working on: ${activeRequest}${activeRequest.length >= 90 ? "…" : ""}`
              : "Preparing next step";
          }
          icon = "meter";
        }

        const apiProgress =
          icon === "api"
            ? ((
                activeTool?.result as {
                  details?: {
                    stage?: unknown;
                    method?: unknown;
                    path?: unknown;
                    httpStatus?: unknown;
                  };
                }
              )?.details ?? null)
            : null;
        const apiStage = String(apiProgress?.stage ?? "request");
        const apiStages = [
          "contract",
          "destination",
          "authentication",
          "request",
          "response",
          "validation",
        ];
        const apiStageIndex = Math.max(0, apiStages.indexOf(apiStage));
        return (
          <section className="agent-activity" aria-label="Agent activity">
            <div
              className={`agent-working activity-${icon} phase-${phase}`}
              role="status"
              aria-live="polite"
            >
              <span className="agent-working-mark" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <div>
                <strong>{title}</strong>
                <small className="agent-working-detail" title={detail}>
                  {detail}
                </small>
                {apiProgress && (
                  <div className="api-live-progress">
                    <span className="api-live-target">
                      {String(apiProgress.method ?? "API")} ·{" "}
                      {String(apiProgress.path ?? "Resolving endpoint")}
                      {apiProgress.httpStatus != null &&
                        ` · HTTP ${String(apiProgress.httpStatus)}`}
                    </span>
                    <span
                      className="api-live-track"
                      aria-label={`API stage ${apiStageIndex + 1} of ${apiStages.length}`}
                    >
                      {apiStages.map((stage, index) => (
                        <i
                          key={stage}
                          className={
                            index < apiStageIndex
                              ? "done"
                              : index === apiStageIndex
                                ? "active"
                                : ""
                          }
                          title={stage}
                        />
                      ))}
                    </span>
                  </div>
                )}
              </div>
              <span className="agent-working-stats">
                {icon === "api" && completedApiCount > 0 ? (
                  <span>
                    {completedApiCount} API call
                    {completedApiCount !== 1 ? "s" : ""} done
                  </span>
                ) : completedCount > 0 ? (
                  <span>
                    {completedCount} tool
                    {completedCount !== 1 ? "s" : ""}
                  </span>
                ) : null}
                <span>
                  <ElapsedLabel
                    startedAt={taskStartedAtRef.current ?? Date.now()}
                    ticking={isActive}
                  />
                </span>
              </span>
              <button onClick={handleAbort} disabled={isAborting}>
                {isAborting ? "ABORTING…" : "ABORT"}
              </button>
            </div>
            <details className="agent-activity-log" open>
              <summary>
                {agentTranscript.length
                  ? `${agentTranscript.length} task${agentTranscript.length === 1 ? "" : "s"} active`
                  : "Preparing task"}
              </summary>
              <ul className="agent-transcript" aria-label="Agent tasks">
                {agentTranscript.length > 0 ? (
                  agentTranscript.map((entry) => (
                    <li key={entry.id}>
                      <span
                        className={`agent-transcript-mark ${entry.type === "Tool" ? "tool" : ""}`}
                        aria-hidden="true"
                      />
                      <span>
                        {entry.type === "Agent" && entry.detail === "Thinking"
                          ? activeRequest
                            ? `Working on: ${activeRequest}${activeRequest.length >= 90 ? "…" : ""}`
                            : "Preparing next step"
                          : entry.detail}
                      </span>
                      <small>{entry.type}</small>
                    </li>
                  ))
                ) : (
                  <li className="agent-transcript-empty">
                    <span
                      className="agent-transcript-mark"
                      aria-hidden="true"
                    />
                    <span>Analyzing request</span>
                  </li>
                )}
              </ul>
            </details>
          </section>
        );
      })();
    }
    return null;
  };

  const renderFeedItem = (index: number, item: FeedItem): ReactNode => (
    <div
      style={
        index === 0
          ? { ...FEED_ITEM_STYLE, paddingTop: "var(--spacing-xl)" }
          : FEED_ITEM_STYLE
      }
    >
      {renderFeedItemInner(item)}
    </div>
  );

  if (!isActive) return null;

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        position: "relative",
      }}
    >
      <div
        className={
          globalChat
            ? ""
            : rightSidebarOpen
              ? "has-code-rail-rail-open"
              : "has-code-rail"
        }
        style={{
          display: "flex",
          gap: "var(--spacing-xs)",
          alignItems: "center",
          paddingTop: "var(--spacing-sm)",
          paddingBottom: "var(--spacing-sm)",
          paddingLeft: "var(--spacing-md)",
          paddingRight: !globalChat
            ? rightSidebarOpen
              ? "448px"
              : "68px"
            : "var(--spacing-md)",
          borderBottom: "1px solid var(--colors-hairline)",
          flexWrap: "wrap",
          flexShrink: 0,
        }}
      >
        <strong
          className="title-md"
          style={{ color: "var(--colors-on-dark)", letterSpacing: "1px" }}
        >
          {projectName}
        </strong>
        <button
          onClick={handleClose}
          className="small-icon-button"
          title="Close chat"
          aria-label="Close chat"
        >
          ✕
        </button>
        {!globalChat && !isGit && !isWorkspace && (
          <span className="category-tag">NOT ISOLATED</span>
        )}
        {driveDetached && (
          <span
            className="category-tag"
            style={{ color: "var(--colors-muted-soft)" }}
          >
            DRIVE DETACHED
          </span>
        )}
        {agentStatus === "stopped" && (
          <span
            className="category-tag"
            style={{ color: "var(--colors-muted-soft)" }}
          >
            AGENT STOPPED
          </span>
        )}
        {approval && (
          <output className="follow-up-badge">● INPUT REQUIRED</output>
        )}
        {!globalChat && graphStatus && (
          <>
            <span
              className="category-tag graph-status"
              title={graphStatus.tracked_warning ?? "Graphify status"}
            >
              GRAPH {graphStatus.state}
            </span>
            <button
              className="dev-control"
              disabled={graphBusy}
              onClick={() =>
                refreshGraph(
                  graphStatus.state === "none" || graphStatus.docs_stale,
                )
              }
            >
              {graphBusy && (
                <span className="graph-spinner" aria-hidden="true" />
              )}
              {graphBusy
                ? "GRAPHIFYING…"
                : graphStatus.state === "none"
                  ? "BUILD GRAPH"
                  : "UPDATE GRAPH"}
            </button>
          </>
        )}
        {graphError && (
          <span className="dev-error" title={graphError}>
            GRAPH ERROR: {graphError}
          </span>
        )}
        {graphBusy && graphProgress && (
          <div className="graph-progress" role="status" aria-live="polite">
            <span>
              <b>
                {graphProgress.index}/{graphProgress.total}
              </b>{" "}
              {graphProgress.repository}
            </span>
            <small title={graphProgress.activity}>
              {graphProgress.activity}
            </small>
            <small>
              {graphProgress.index < graphProgress.total
                ? `${graphProgress.total - graphProgress.index} repositories remaining · `
                : "Finalizing repository · "}
              {Math.floor(graphElapsed / 60)}:
              {String(graphElapsed % 60).padStart(2, "0")} elapsed · CHAT
              AVAILABLE
            </small>
            <i
              style={{
                width: `${Math.max(5, ((graphProgress.index - 1) / graphProgress.total) * 100)}%`,
              }}
            />
          </div>
        )}

        <div className="chat-header-actions">
          <button
            onClick={openModelPicker}
            className="dev-control"
            style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
            title="Change model (Ctrl+L or /model) — works in Global and project chat"
            aria-label="Change model"
          >
            ◍{" "}
            {currentModel
              ? (currentModel.split("/").pop()?.toUpperCase().slice(0, 18) ??
                "MODEL")
              : "MODEL"}
          </button>
          {!globalChat && !devRunner && (
            <button onClick={handleRunDev} className="dev-control run">
              ▶ RUN DEV
            </button>
          )}
          <button
            onClick={handleOpenTerminal}
            className={`dev-control open${showTerminal ? " active" : ""}`}
          >
            ⌘ TERMINAL
          </button>
          {!globalChat && devRunner && (
            <>
              <button onClick={handleStopDev} className="dev-control stop">
                ■ STOP
              </button>
              <button
                onClick={() => openUrl(devRunner.url)}
                className="dev-control open"
              >
                ↗ {devRunner.url}
              </button>
            </>
          )}
          {!globalChat && devError && (
            <span className="dev-error" title={devError}>
              RUN DEV ERROR: {devError}
            </span>
          )}
          {agentStatus === "running" && (
            <button
              onClick={handleAbort}
              disabled={isAborting}
              className="caption-uppercase"
            >
              {isAborting ? "ABORTING…" : "ABORT"}
            </button>
          )}
          {agentStatus !== "running" && (
            <button
              onClick={() => handleRestart()}
              className="caption-uppercase"
              disabled={isRestarting}
            >
              {isRestarting
                ? "RELOADING…"
                : agentStatus === "stopped"
                  ? "RESTART"
                  : "RELOAD PI"}
            </button>
          )}
        </div>
      </div>

      {terminalMounted && (
        <TerminalPanel
          chatId={chatId}
          cwd={cwd}
          hidden={!showTerminal}
          onClose={() => setShowTerminal(false)}
        />
      )}

      {pendingDevCommand && (
        <div className="project-branch-backdrop" role="presentation">
          <div
            ref={devDialogRef}
            className="project-branch-picker dev-command-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dev-command-title"
            tabIndex={-1}
          >
            <small>DEV SERVER</small>
            <strong id="dev-command-title">Run dev commands</strong>
            <textarea
              aria-label="Dev commands"
              autoFocus
              rows={3}
              value={pendingDevCommand}
              onChange={(event) => setPendingDevCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.ctrlKey && event.key === "Enter")
                  void confirmRunDev();
              }}
            />
            <p>
              One command per line. Add <code>| PORT</code> to set a port. Both
              run and stop together.
            </p>
            <pre className="dev-command-example">
              npm run dev | 5173{`\n`}php artisan serve | 8000
            </pre>
            <small className="dev-command-hint">
              CTRL+ENTER TO RUN · SAVED FOR {projectName}
            </small>
            <div className="project-dialog-actions">
              <button
                className="project-save-branch"
                onClick={confirmRunDev}
                disabled={devStarting}
              >
                {devStarting ? "STARTING…" : "RUN DEV"}
              </button>
              <button
                className="project-dialog-cancel"
                onClick={() => setPendingDevCommand(null)}
                disabled={devStarting}
              >
                CANCEL
              </button>
            </div>
          </div>
        </div>
      )}

      {modelPickerOpen && (
        <ModelPickerDialog
          models={models}
          currentModel={currentModel}
          dialogRef={modelDialogRef}
          onClose={() => setModelPickerOpen(false)}
          onSelect={(model) => void handleSetModel(model)}
        />
      )}

      {resumePickerOpen && (
        <div
          className="model-picker-backdrop"
          onMouseDown={() => setResumePickerOpen(false)}
        >
          <section
            ref={resumeDialogRef}
            className="model-picker"
            role="dialog"
            aria-modal="true"
            aria-label="Resume session"
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <span>PROJECT SESSIONS</span>
              <button
                onClick={() => setResumePickerOpen(false)}
                aria-label="Close session picker"
              >
                ESC
              </button>
            </header>
            <div className="model-list" role="listbox">
              {resumableSessions.map((session) => (
                <button
                  key={session.sessionFile}
                  onClick={() => {
                    setResumePickerOpen(false);
                    void sendRaw({
                      type: "switch_session",
                      sessionPath: session.sessionFile,
                    });
                  }}
                  role="option"
                >
                  <span className="model-arrow">→</span>
                  <strong>{session.title}</strong>
                  <small>{session.sessionFile}</small>
                  <b />
                </button>
              ))}
            </div>
            <footer>
              <span>{resumableSessions.length} SESSIONS</span>
              <span>SELECT TO RESUME</span>
            </footer>
          </section>
        </div>
      )}

      {driveDetached && (
        <div
          className="surface-card"
          style={{
            padding: "var(--spacing-sm) var(--spacing-md)",
            borderBottom: "1px solid var(--colors-hairline)",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span className="caption-uppercase">DRIVE DETACHED — RECONNECT</span>
          <button
            onClick={() => handleRestart()}
            className="button-primary"
            style={{ padding: "var(--spacing-xxs) var(--spacing-sm)" }}
          >
            RECONNECT
          </button>
        </div>
      )}

      <div
        className={
          !globalChat
            ? rightSidebarOpen
              ? "chat-content has-code-rail-rail-open"
              : "chat-content has-code-rail"
            : "chat-content"
        }
        style={
          !globalChat && rightSidebarOpen
            ? { marginRight: rightPanelWidth + 38 }
            : undefined
        }
      >
        <Virtuoso
          ref={virtuosoRef}
          style={{ flex: 1, minHeight: 0 }}
          data={feedItems}
          computeItemKey={feedItemKey}
          followOutput="auto"
          alignToBottom
          atBottomStateChange={handleAtBottomStateChange}
          itemContent={renderFeedItem}
        />

        <ChatComposer
          globalChat={globalChat}
          driveDetached={driveDetached}
          agentStatus={agentStatus}
          isNewSessionLoading={isNewSessionLoading}
          chatReady={chatReady}
          isAborting={isAborting}
          researchBusy={researchBusy}
          researchUsageError={researchUsageError}
          pendingMessageCount={pendingMessageCount}
          projectPath={projectPath}
          inputPlaceholder={inputPlaceholder}
          input={input}
          images={images}
          files={files}
          currentThinking={currentThinking}
          slashCommands={slashCommands}
          commandIndex={commandIndex}
          filePickerQuery={filePickerQuery}
          atHint={atHint}
          tablePreviews={tablePreviews}
          inputRef={inputRef}
          filePickerRef={filePickerRef}
          setInput={setInput}
          setImages={setImages}
          setFiles={setFiles}
          setPreviewImage={setPreviewImage}
          setFilePickerQuery={setFilePickerQuery}
          setResearchUsageError={setResearchUsageError}
          setCommandIndex={setCommandIndex}
          onPaste={handlePaste}
          onAttachFiles={attachFiles}
          onSubmit={submitInput}
          onChooseCommand={chooseCommand}
          onFilePick={handleFilePick}
          onRemoveTable={handleRemoveTable}
          onSetThinking={handleSetThinking}
        />
      </div>
      {!globalChat &&
        (atHint ? (
          <div
            className="caption-uppercase"
            style={{
              maxWidth: 880,
              margin: "0 auto",
              padding: "0 var(--spacing-md) var(--spacing-md)",
            }}
          >
            {atHint.toUpperCase()}
          </div>
        ) : (
          <p id="chat-composer-help" className="chat-composer-help">
            Type <kbd>@</kbd> to add a project file. Press Enter to send,
            Shift+Enter for a new line.
          </p>
        ))}
      {/* VSCode right sidebar: activity rail + explorer + diff, now with proper hide toggle */}
      {!globalChat && (
        <ChatRightSidebar
          open={rightSidebarOpen}
          activity={rightActivity}
          panelWidth={rightPanelWidth}
          worktree={worktree}
          isWorkspace={isWorkspace}
          worktreeDiff={worktreeDiff}
          cwd={cwd}
          projectName={projectName}
          repositoryStatuses={repositoryStatuses}
          onOpenChange={setRightSidebarOpen}
          onActivityChange={setRightActivity}
          onPanelWidthChange={setRightPanelWidth}
          onOpenDiff={setExpandedDiff}
          onWorktreeDiffChange={setWorktreeDiff}
          onToast={onToast}
        />
      )}
      <footer className="chat-status">
        <span>
          ⑂{" "}
          {worktree?.branch ??
            (isWorkspace
              ? `${repositories.length} repositories`
              : isGit
                ? "main"
                : "not isolated")}
        </span>
        {pipelineStatus && (
          <button className="pipeline-chat-status" onClick={onOpenPipeline}>
            PIPELINE · {pipelineStatus.step} · {pipelineStatus.completed}/
            {pipelineStatus.total} · OPEN VIEW ↗
          </button>
        )}
        {sessionStats && (
          <button
            className="usage-summary"
            onClick={() => setUsageOpen(true)}
            title="Show token usage"
          >
            CONTEXT{" "}
            {sessionStats.contextUsage?.percent == null
              ? "—"
              : `${Math.round(sessionStats.contextUsage.percent)}%`}{" "}
            · ↑ {formatTokens(sessionStats.tokens.input)} · ↓{" "}
            {formatTokens(sessionStats.tokens.output)}
          </button>
        )}
        <button
          className="chat-status-model"
          onClick={openModelPicker}
          title="Change model — Ctrl+L or /model"
          style={
            {
              background: "transparent",
              border: "1px solid transparent",
              color: "inherit",
              cursor: "pointer",
              padding: "2px 6px",
              fontSize: "inherit",
              fontFamily: "inherit",
              letterSpacing: "0.08em",
            } as React.CSSProperties
          }
        >
          {currentModel ? currentModel.replace("/", " | ") : "model loading…"}
          {currentThinking ? ` | ${currentThinking}` : ""}
        </button>
      </footer>
      {usageOpen && sessionStats && (
        <div className="usage-backdrop" onMouseDown={() => setUsageOpen(false)}>
          <section
            ref={usageDialogRef}
            className="usage-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="usage-title"
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <strong id="usage-title">CONTEXT USAGE</strong>
              <button
                onClick={() => setUsageOpen(false)}
                aria-label="Close context usage"
              >
                ×
              </button>
            </header>
            <div
              className="usage-meter"
              role="meter"
              aria-label="Context used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={sessionStats.contextUsage?.percent ?? undefined}
            >
              <i
                style={{
                  width: `${Math.min(100, sessionStats.contextUsage?.percent ?? 0)}%`,
                }}
              />
            </div>
            <strong className="usage-percent">
              {sessionStats.contextUsage?.percent == null
                ? "—"
                : `${Math.round(sessionStats.contextUsage.percent)}%`}
            </strong>
            <dl>
              <div>
                <dt>CONTEXT</dt>
                <dd>
                  {sessionStats.contextUsage?.tokens == null
                    ? "—"
                    : formatTokens(sessionStats.contextUsage.tokens)}{" "}
                  /{" "}
                  {sessionStats.contextUsage
                    ? formatTokens(sessionStats.contextUsage.contextWindow)
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>INPUT</dt>
                <dd>{sessionStats.tokens.input.toLocaleString()}</dd>
              </div>
              <div>
                <dt>OUTPUT</dt>
                <dd>{sessionStats.tokens.output.toLocaleString()}</dd>
              </div>
              <div>
                <dt>TOTAL</dt>
                <dd>{sessionStats.tokens.total.toLocaleString()}</dd>
              </div>
            </dl>
          </section>
        </div>
      )}
      {previewImage && (
        <div
          ref={imageDialogRef}
          className="image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          tabIndex={-1}
          onClick={() => setPreviewImage(null)}
        >
          <button
            onClick={() => setPreviewImage(null)}
            aria-label="Close image preview"
          >
            ×
          </button>
          <img
            src={`data:${previewImage.mimeType};base64,${previewImage.data}`}
            alt="Attachment preview"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
      {expandedDiff &&
        worktreeDiff?.files.find(
          (f) =>
            `${f.repository ? `${f.repository}:` : ""}${f.path}` ===
              expandedDiff || f.path === expandedDiff,
        ) && (
          <ExpandedDiffPanel
            diffKey={expandedDiff}
            worktreeDiff={worktreeDiff}
            position={diffPos}
            dialogRef={expandedDiffRef}
            onPositionChange={setDiffPos}
            onClose={() => setExpandedDiff(null)}
          />
        )}
      {approval && (
        <ApprovalDialog req={approval} onRespond={handleApprovalResponse} />
      )}
    </div>
  );
}
