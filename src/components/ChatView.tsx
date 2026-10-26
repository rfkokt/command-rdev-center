import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
import { withTimeout } from "../lib/with-timeout";
import {
  imageSupport,
  modelInputs,
  type ImageSupport,
} from "../lib/model-capabilities";
import {
  prepareComposerImage,
  dropLandsOn,
  fileName,
  inlineImageMime,
  storeAttachmentFile,
  storePastedFile,
  toChatImage,
} from "../lib/attachments";
import {
  planImageDelivery,
  stripDeliveryEnvelope,
} from "../lib/attachment-delivery";
import { useChatDraft } from "../lib/use-chat-draft";
import {
  buildChatHandoff,
  buildFullTranscript,
  isUsageLimitError,
} from "../lib/handoff";
import {
  findMatchIndex,
  REVEAL_EVENT,
  takeReveal,
} from "../lib/message-reveal";
import {
  formatDiffComments,
  loadDiffComments,
  saveDiffComments,
  type DiffComment,
} from "../lib/diff-comments";
import {
  formatTokens,
  cacheHitPercent,
  applyToolPatches,
  type ToolCallPatch,
  mergeAssistantMessage,
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
  applyPlanModePrefix,
  planApprovalPending,
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
import { warmTerminalWhenIdle } from "../lib/terminal-warmup";
import AgentRunCard, { buildRunSteps, noteToolPhase } from "./AgentRunCard";
import ApprovalDialog from "./ApprovalDialog";
import { confirm } from "./ConfirmDialog";
import { type FilePickerHandle } from "./FilePicker";
// Split the xterm bundle out of the main chunk; it only loads when the
// terminal is first mounted.
const loadTerminalPanel = () => import("./TerminalPanel");
const TerminalPanel = lazy(loadTerminalPanel);
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
import ChatRightSidebar, { type RightActivity } from "./ChatRightSidebar";
import type { OfficeView } from "./OfficePanel";
import ExpandedDiffPanel from "./ExpandedDiffPanel";
import SessionTreePanel, {
  activeBranchUserEntries,
  pickEditTarget,
} from "./SessionTreePanel";
import WorktreeSetup from "./WorktreeSetup";
import Mascot from "./Mascot";
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
  boxSizing: "border-box",
  overflowX: "hidden",
};

const ChatFeedTopSpacer = () => <div style={{ height: 16 }} />;
const ChatFeedBottomSpacer = () => <div style={{ height: 32 }} />;
const VIRTUOSO_COMPONENTS = {
  Header: ChatFeedTopSpacer,
  Footer: ChatFeedBottomSpacer,
};

type PiEventPayload = { session_id: string; raw: string };
type HarnessOption = {
  id: string;
  label: string;
  protocol: "native" | "acp";
  available: boolean;
  is_default: boolean;
};
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
  /** USD, when the harness reports it. */
  cost?: number;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
};
type CompactionState = {
  status: "running" | "failed" | "cancelled";
  reason: string;
  startedAt: number;
  message?: string;
  awaitingStart?: boolean;
};
export type ChatFile = { name: string; path: string };
type ChatAttachment = ChatFile & { content: string };

function attachmentContext(attachments: ChatAttachment[]) {
  return `\n\n<authoritative_attachments>\nThe user explicitly attached the files below. Use their exact contents as authoritative context.\n${attachments.map((file) => `--- ${file.name} (${file.path}) ---\n${file.content}\n--- end ${file.name} ---`).join("\n")}\n</authoritative_attachments>`;
}

const MAX_HISTORY = 600;
const AGENT_INACTIVITY_TIMEOUT_MS = 2 * 60_000;
const COMPACTION_TIMEOUT_MS = 5 * 60_000;

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
const OFFICE_AUTOSHOW_KEY = "crc-office-autoshow";
/** Where the office is drawn: side panel, full chat area, or mini window. */
const OFFICE_VIEW_KEY = "crc-office-view";
/** Mini office window: offset from the chat area's bottom-right, and size. */
const OFFICE_PIP_KEY = "crc-office-pip";
type OfficePip = {
  right: number;
  bottom: number;
  width: number;
  height: number;
};
const OFFICE_PIP_DEFAULT: OfficePip = {
  right: 16,
  bottom: 120,
  width: 420,
  height: 300,
};

function readStored<T>(key: string, parse: (raw: string) => T, fallback: T) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : parse(raw);
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

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
  if (granted) {
    let soundEnabled = true;
    try {
      soundEnabled =
        localStorage.getItem("kern:notification-sound") !== "false";
    } catch {
      /* OS default sound when preferences are unavailable. */
    }
    sendNotification(
      agentNotification(kind, projectName, chatId, response, soundEnabled),
    );
  }
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
  initialHarness,
  onHarnessChange,
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
  headerSlot,
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
  /** Agent harness chosen for this chat before its first message. */
  initialHarness?: string;
  onHarnessChange?: (chatId: string, harness: string) => void;
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
  /** App header element to render this chat's header into (single header bar). */
  headerSlot?: HTMLElement | null;
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
  const [historyLoadingStage, setHistoryLoadingStage] = useState(
    "PREPARING WORKSPACE",
  );
  const forkHistoryRequestRef = useRef<string | null>(null);
  const forkHistoryLoadingRef = useRef(false);
  const [isNewSessionLoading, setIsNewSessionLoading] = useState(false);

  // Mirror the existing loading state in the office scene without changing
  // session loading, retries, or the chat data flow.
  useEffect(() => {
    if (typeof window === "undefined" || !isActive) return;
    const dispatch = (loading: boolean) =>
      window.dispatchEvent(
        new CustomEvent("crc-session-loading", {
          detail: { loading, tabId: chatId },
        }),
      );
    dispatch(isHistoryLoading);
    // The initial history card can render before BackgroundMotion's passive
    // listener mounts. Replay once after the effect queue has settled so the
    // 3D character and the card enter the loading state together.
    let cancelled = false;
    const resync = window.setTimeout(() => {
      if (!cancelled) dispatch(isHistoryLoading);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(resync);
      dispatch(false);
    };
  }, [chatId, isActive, isHistoryLoading]);
  const {
    input,
    setInput,
    files,
    setFiles,
    images,
    setImages,
    restoring: restoringDraft,
  } = useChatDraft(chatId, onToast);
  // Cursor-style Plan/Build mode. Plan mode only prefixes the message sent to
  // pi; the displayed user message stays raw.
  const [planMode, setPlanMode] = useState(false);
  const [sessionTreeOpen, setSessionTreeOpen] = useState(false);
  const [diffComments, setDiffComments] = useState<DiffComment[]>(() =>
    loadDiffComments(chatId),
  );
  useEffect(
    () => saveDiffComments(chatId, diffComments),
    [chatId, diffComments],
  );
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
  const [, setAgentTranscript] = useState<
    Array<{ id: string; type: string; detail: string; at: number }>
  >([]);
  const [driveDetached, setDriveDetached] = useState(false);
  // Reconnect the startup effect after installation or a failed connection.
  const [piInstallRetry, setPiInstallRetry] = useState(0);
  const [models, setModels] = useState<string[]>([]);
  // What each model reads (text/image), so attachments go inline only where
  // they will be seen; see src/lib/model-capabilities.ts.
  const [inputsByModel, setInputsByModel] = useState<Record<string, string[]>>(
    {},
  );
  const [undeclaredModels, setUndeclaredModels] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [harnessImage, setHarnessImage] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    invoke<string[]>("models_without_declared_input")
      .then((list) => alive && setUndeclaredModels(new Set(list)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const [currentModel, setCurrentModel] = useState(initialModel ?? "");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [resumePickerOpen, setResumePickerOpen] = useState(false);
  const [currentThinking, setCurrentThinking] = useState(initialThinking ?? "");
  const [filePickerQuery, setFilePickerQuery] = useState<string | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [commandIndex, setCommandIndex] = useState(0);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [rightActivity, setRightActivity] = useState<RightActivity>(
    globalChat ? "office" : "explorer",
  );
  const [rightPanelWidth, setRightPanelWidth] = useState(300);
  // The office can leave the side panel: "full" fills the chat area and the
  // chat floats over it (Claw3D style); "pip" floats a mini office over the
  // chat. One chat either way; the crew only mirrors its tool calls.
  const [officeView, setOfficeView] = useState<OfficeView>(() =>
    readStored<OfficeView>(
      OFFICE_VIEW_KEY,
      (raw) => (raw === "full" || raw === "pip" ? raw : "panel"),
      "panel",
    ),
  );
  const [officeLayerEl, setOfficeLayerEl] = useState<HTMLDivElement | null>(
    null,
  );
  const [officeRosterEl, setOfficeRosterEl] = useState<HTMLDivElement | null>(
    null,
  );
  const [floatingChatOpen, setFloatingChatOpen] = useState(true);
  const [pipCollapsed, setPipCollapsed] = useState(false);
  const [pip, setPip] = useState<OfficePip>(() =>
    readStored(
      OFFICE_PIP_KEY,
      (raw) => ({ ...OFFICE_PIP_DEFAULT, ...(JSON.parse(raw) as OfficePip) }),
      OFFICE_PIP_DEFAULT,
    ),
  );
  const pipRef = useRef(pip);
  pipRef.current = pip;
  const changeOfficeView = useCallback((next: OfficeView) => {
    setOfficeView(next);
    setFloatingChatOpen(true);
    setPipCollapsed(false);
    writeStored(OFFICE_VIEW_KEY, next);
  }, []);
  /** Drag the mini window (move) or its top-left corner (resize). */
  const dragPip = useCallback(
    (event: ReactPointerEvent<HTMLElement>, kind: "move" | "resize") => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest("button")) return;
      event.preventDefault();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      const start = { x: event.clientX, y: event.clientY };
      const origin = pipRef.current;
      const box = target.closest(".chat-view")?.getBoundingClientRect();
      const maxW = Math.max(260, (box?.width ?? 1200) - 80);
      const maxH = Math.max(180, (box?.height ?? 800) - 80);
      let latest: OfficePip | null = null;
      target.onpointermove = (move) => {
        const dx = move.clientX - start.x;
        const dy = move.clientY - start.y;
        latest =
          kind === "move"
            ? {
                ...origin,
                right: Math.max(0, origin.right - dx),
                bottom: Math.max(0, origin.bottom - dy),
              }
            : {
                ...origin,
                width: Math.min(maxW, Math.max(260, origin.width - dx)),
                height: Math.min(maxH, Math.max(180, origin.height - dy)),
              };
        setPip(latest);
      };
      target.onpointerup = () => {
        target.onpointermove = null;
        target.onpointerup = null;
        if (target.hasPointerCapture(event.pointerId))
          target.releasePointerCapture(event.pointerId);
        if (latest) writeStored(OFFICE_PIP_KEY, JSON.stringify(latest));
      };
    },
    [],
  );
  // Tool calls of the current turn drive the office crew in the side panel.
  const officeData = useMemo(() => {
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--)
      if (messages[i].role === "user") {
        lastUser = i;
        break;
      }
    const turn = messages.slice(lastUser + 1);
    const tools = turn.flatMap((message) => message.toolCalls);
    const streaming = turn.find((m) => m.role === "assistant" && m.isStreaming);
    return {
      tools,
      running: agentStatus === "running",
      writing:
        Boolean(streaming?.text.trim()) &&
        tools.every((tool) => tool.phase === "end"),
    };
  }, [messages, agentStatus]);
  // Show the office when a run starts, unless the user closed it last time.
  useEffect(() => {
    if (!isActive || agentStatus !== "running") return;
    let autoShow = true;
    try {
      autoShow = localStorage.getItem(OFFICE_AUTOSHOW_KEY) !== "false";
    } catch {
      /* storage unavailable: keep the default */
    }
    // Full and mini views already have the office on screen.
    if (!autoShow || rightSidebarOpen || officeView !== "panel") return;
    setRightActivity("office");
    setRightPanelWidth((width) => Math.max(width, 400));
    setRightSidebarOpen(true);
    // Only react to the run starting, not to every sidebar change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentStatus, isActive]);
  const handleRightSidebarOpen = useCallback(
    (open: boolean) => {
      if (rightActivity === "office") {
        try {
          localStorage.setItem(OFFICE_AUTOSHOW_KEY, String(open));
        } catch {
          /* ignore */
        }
      }
      setRightSidebarOpen(open);
    },
    [rightActivity],
  );
  const handleRightActivity = useCallback((next: RightActivity) => {
    if (next === "office") {
      setRightPanelWidth((width) => Math.max(width, 400));
      try {
        localStorage.setItem(OFFICE_AUTOSHOW_KEY, "true");
      } catch {
        /* ignore */
      }
    }
    setRightActivity(next);
  }, []);
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
  const [graphEnabled, setGraphEnabled] = useState(false);
  const [devRunner, setDevRunner] = useState<DevRunnerInfo | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  // Global chat provisions a hidden pane immediately so the agent can use SSH/device tools
  // without asking the user to open the terminal first.
  const [terminalMounted, setTerminalMounted] = useState(globalChat);
  // Load the terminal chunk, WASM core and fonts while idle so opening the
  // terminal does not wait on them.
  useEffect(() => {
    if (!isActive) return;
    void loadTerminalPanel().catch(() => undefined);
    warmTerminalWhenIdle();
    // The Office panel opens when a run starts; have its 3D chunk ready.
    window.setTimeout(() => {
      void import("./OfficePanel").catch(() => undefined);
      void import("./office/office-scene").catch(() => undefined);
    }, 1500);
  }, [isActive]);
  const [devError, setDevError] = useState<string | null>(null);
  const [pendingDevCommand, setPendingDevCommand] = useState<string | null>(
    null,
  );
  const [devStarting, setDevStarting] = useState(false);
  const [pendingMessageCount, setPendingMessageCount] = useState(0);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [compactThresholds, setCompactThresholds] = useState<
    Record<string, number>
  >({});
  const [compactCount, setCompactCount] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(`kern-compact-count:${chatId}`));
      return Number.isSafeInteger(saved) && saved >= 0 ? saved : 0;
    } catch {
      return 0;
    }
  });
  const [compaction, setCompaction] = useState<CompactionState | null>(null);
  const [autoCompactionEnabled, setAutoCompactionEnabled] = useState<
    boolean | null
  >(null);
  const compactionRef = useRef<CompactionState | null>(null);
  const manualCompactionRef = useRef<string | null>(null);
  const compactionProbeRef = useRef<{ id: string; startedAt: number } | null>(
    null,
  );
  const updateCompaction = useCallback((value: CompactionState | null) => {
    compactionRef.current = value;
    setCompaction(value);
  }, []);
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
  const assistantMessageCountRef = useRef(0);
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
  // Harness for this chat. Undefined means the Settings default. The backend
  // only honours it when no session file exists yet, so a started chat always
  // reopens with the agent it began with.
  const [harness, setHarness] = useState<string | undefined>(initialHarness);
  const harnessRef = useRef<string | undefined>(initialHarness);
  /** Conversation so far, handed to an agent that took over mid-chat. */
  const handoffRef = useRef<string | undefined>(undefined);
  const [harnessOptions, setHarnessOptions] = useState<HarnessOption[]>([]);
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

  const scrollToBottom = useCallback((behavior: "auto" | "smooth" = "auto") => {
    atBottomRef.current = true;
    virtuosoRef.current?.scrollToIndex({
      index: "LAST",
      align: "end",
      behavior,
    });
  }, []);

  // Jump the virtualized list to the latest output when the chat tab becomes
  // active or its history finishes loading. followOutput takes over from there.
  useEffect(() => {
    if (!isActive || isHistoryLoading) return;
    scrollToBottom("auto");
    const timer = window.setTimeout(() => scrollToBottom("auto"), 80);
    return () => clearTimeout(timer);
  }, [isActive, isHistoryLoading, scrollToBottom]);

  // Keep list pinned to bottom whenever a new user message is appended or when at bottom
  useEffect(() => {
    if (!isActive || isHistoryLoading || messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === "user" || atBottomRef.current) {
      scrollToBottom("auto");
    }
  }, [messages.length, isActive, isHistoryLoading, scrollToBottom]);

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
          copy[i] = mergeAssistantMessage(copy[i], { text, thinking });
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
  // Same idea for tool calls: a burst of tool events in one frame (start /
  // progress / end for several calls) becomes a single setMessages.
  const pendingToolPatchesRef = useRef<
    Array<{ callId: string; patch: ToolCallPatch }>
  >([]);
  const toolCallRafRef = useRef(0);
  const flushToolCalls = useCallback(() => {
    toolCallRafRef.current = 0;
    const patches = pendingToolPatchesRef.current;
    pendingToolPatchesRef.current = [];
    if (patches.length === 0) return;
    setMessages((prev) => applyToolPatches(prev, patches, createAssistantTurn));
  }, [createAssistantTurn]);
  const upsertToolCall = useCallback(
    (callId: string, patch: ToolCallPatch) => {
      noteToolPhase(callId, patch.phase);
      pendingToolPatchesRef.current.push({ callId, patch });
      if (typeof window !== "undefined" && patch.name) {
        window.dispatchEvent(
          new CustomEvent("crc-agent-activity", {
            detail: {
              type: "tool",
              toolName: patch.name,
              phase: patch.phase || "start",
              args: patch.args,
              isError: patch.isError,
              tabId: chatId,
            },
          }),
        );
      }
      if (toolCallRafRef.current) return;
      toolCallRafRef.current = requestAnimationFrame(flushToolCalls);
    },
    [flushToolCalls, chatId],
  );
  useEffect(
    () => () => {
      if (deltaRafRef.current) cancelAnimationFrame(deltaRafRef.current);
      if (toolCallRafRef.current) cancelAnimationFrame(toolCallRafRef.current);
      if (fallbackRevealTimerRef.current)
        window.clearInterval(fallbackRevealTimerRef.current);
    },
    [],
  );
  const lastTextDispatchRef = useRef(0);
  const appendTextDelta = useCallback(
    (textDelta: string) => {
      if (!textDelta) return;
      pendingTextRef.current += textDelta;
      queueDeltaFlush();
      const now = Date.now();
      if (
        typeof window !== "undefined" &&
        now - lastTextDispatchRef.current > 500
      ) {
        lastTextDispatchRef.current = now;
        window.dispatchEvent(
          new CustomEvent("crc-agent-activity", {
            detail: {
              type: "streaming_text",
              phase: "streaming_text",
              tabId: chatId,
            },
          }),
        );
      }
    },
    [queueDeltaFlush, chatId],
  );

  const lastThinkingDispatchRef = useRef(0);
  const appendThinkingDelta = useCallback(
    (delta: string) => {
      if (!delta) return;
      pendingThinkingRef.current += delta;
      queueDeltaFlush();
      const now = Date.now();
      if (
        typeof window !== "undefined" &&
        now - lastThinkingDispatchRef.current > 500
      ) {
        lastThinkingDispatchRef.current = now;
        window.dispatchEvent(
          new CustomEvent("crc-agent-activity", {
            detail: {
              type: "thinking",
              phase: "thinking",
              tabId: chatId,
            },
          }),
        );
      }
    },
    [queueDeltaFlush, chatId],
  );

  useEffect(() => {
    if (typeof window === "undefined" || !isActive) return;
    if (agentStatus !== "running" && !isRestarting) {
      window.dispatchEvent(
        new CustomEvent("crc-agent-activity-sync", {
          detail: {
            active: false,
            phase: "idle",
            tabId: chatId,
          },
        }),
      );
      return;
    }

    const lastMsg = messages[messages.length - 1];
    const activeTool =
      lastMsg && lastMsg.role === "assistant"
        ? lastMsg.toolCalls.find((t) => t.phase !== "end")
        : null;

    const activeReq =
      [...messages]
        .reverse()
        .find((m) => m.role === "user")
        ?.text?.trim() || "";

    let assignedName = "Kern";
    let assignedRole = "Lead Agent";
    let title = "Thinking";
    let detail = activeReq
      ? `Working on: ${activeReq.slice(0, 48)}${activeReq.length > 48 ? "…" : ""}`
      : "Analyzing request";
    let phase = "thinking";

    if (activeTool) {
      phase = "executing";
      const rawName = activeTool.name.replace(/^functions\./, "").toLowerCase();
      const cmd = String(activeTool.args?.command || "").toLowerCase();
      if (rawName === "bash") {
        if (/(test|vitest|jest|cargo.*test|pytest)/.test(cmd)) {
          assignedName = "Bob";
          assignedRole = "QA Tester";
        } else if (/(build|compile|tauri.*build|vite.*build)/.test(cmd)) {
          assignedName = "Grace";
          assignedRole = "DevOps & Server";
        } else if (/^git\s+/.test(cmd)) {
          assignedName = "Linus";
          assignedRole = "Backend Dev";
        } else {
          assignedName = "Grace";
          assignedRole = "DevOps & Infra";
        }
      } else if (
        rawName === "read" ||
        rawName === "view" ||
        rawName === "cat"
      ) {
        assignedName = "Ada";
        assignedRole = "Frontend Dev";
      } else if (rawName === "edit" || rawName === "write") {
        assignedName = "Linus";
        assignedRole = "Backend Dev";
      } else if (
        rawName.includes("search") ||
        rawName.includes("grep") ||
        rawName.includes("graph")
      ) {
        assignedName = "Alan";
        assignedRole = "AST & Search";
      } else if (rawName.includes("web") || rawName.includes("fetch")) {
        assignedName = "Alan";
        assignedRole = "Research Agent";
      }
      title = activeTool.name.replace(/^functions\./, "");
      detail = describeToolActivity(activeTool);
    } else if (lastMsg && lastMsg.role === "assistant" && lastMsg.text) {
      phase = "writing";
      assignedName = "Kern";
      assignedRole = "Lead Agent";
      title = "Responding";
      const lastLine =
        lastMsg.text.split("\n").filter(Boolean).pop()?.slice(0, 45) || "";
      detail = lastLine ? `Writing: ${lastLine}…` : "Drafting response";
    } else if (lastMsg && lastMsg.role === "assistant" && lastMsg.thinking) {
      phase = "thinking";
      assignedName = "Kern";
      assignedRole = "Lead Agent";
      title = "Reasoning";
      const lastLine =
        lastMsg.thinking.split("\n").filter(Boolean).pop()?.slice(0, 45) || "";
      detail = lastLine ? `Thinking: ${lastLine}…` : "Evaluating solution";
    }

    window.dispatchEvent(
      new CustomEvent("crc-agent-activity-sync", {
        detail: {
          active: true,
          phase,
          agentName: assignedName,
          agentRole: assignedRole,
          title,
          detail,
          tabId: chatId,
        },
      }),
    );
  }, [agentStatus, isRestarting, messages, isActive, chatId]);

  useEffect(() => {
    if (globalChat) return;
    const unlisten = listen<GraphProgress>("graphify-progress", (event) =>
      setGraphProgress(event.payload),
    );
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [globalChat]);

  // Graphify is opt-in: without the toggle everything below stays dormant.
  useEffect(() => {
    if (globalChat) return;
    invoke<{ enabled: boolean }>("get_graphify_settings")
      .then((settings) => setGraphEnabled(!!settings.enabled))
      .catch(() => {});
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
    if (globalChat || !graphEnabled) return;
    try {
      const next = await invoke<GraphStatus>("get_graph_status", {
        projectPath,
      });
      if (!next) return;
      setGraphStatus(next);
      graphReportRef.current = next.report_path;
      if (next.code_stale) await refreshGraph(false);
    } catch (e) {
      onToast(`Graphify unavailable; coding continues (${String(e)})`);
    }
  }, [projectPath, refreshGraph, onToast, graphEnabled, globalChat]);

  useEffect(() => {
    if (globalChat || !graphEnabled || !isGit || !isActive) return;
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
  }, [graphEnabled, isActive, isGit, projectPath, refreshGraph, onToast]);

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
    if (agentStatus === "stopped") {
      setBackgroundWork(null);
      if (compactionRef.current?.status === "running")
        updateCompaction({
          ...compactionRef.current,
          status: "failed",
          message:
            "Agent stopped during context compaction. Restart the saved session and retry.",
        });
    }
  }, [agentStatus, updateCompaction]);

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

  // pi `fork` replaces the active session in place with the forked branch: the
  // frontend must re-read the session state (updates the tracked session file)
  // and reload messages from the forked history.
  const handleSessionForked = useCallback(
    (text: string) => {
      setSessionTreeOpen(false);
      setInput(text);
      setMessages([]);
      setPendingMessageCount(0);
      updateCompaction(null);
      manualCompactionRef.current = null;
      compactionProbeRef.current = null;
      trackedTaskRef.current = false;
      finalizedIdsRef.current.clear();
      finalizedContentRef.current.clear();
      pendingTextRef.current = "";
      pendingThinkingRef.current = "";
      historyLoadedRef.current = false;
      setIsHistoryLoading(true);
      setIsNewSessionLoading(true);
      const requestId = uid();
      forkHistoryRequestRef.current = requestId;
      forkHistoryLoadingRef.current = true;
      void sendRaw({ type: "get_state" });
      void sendRaw({ type: "get_messages", id: requestId }).then((sent) => {
        if (!sent && forkHistoryRequestRef.current === requestId) {
          forkHistoryLoadingRef.current = false;
          historyLoadedRef.current = true;
          setIsHistoryLoading(false);
          setIsNewSessionLoading(false);
        }
      });
    },
    [sendRaw, updateCompaction],
  );

  const finishCompaction = useCallback(
    (event: Record<string, unknown>) => {
      const previous = compactionRef.current;
      const reason =
        typeof event.reason === "string"
          ? event.reason
          : (previous?.reason ?? "manual");
      const error =
        typeof event.errorMessage === "string" ? event.errorMessage : "";
      if (previous?.status === "failed" && event.aborted === true) {
        // Preserve the watchdog's explanation when its abort is acknowledged.
      } else if (error || event.aborted === true) {
        const message =
          error || "Context compaction canceled. Retry compaction when ready.";
        updateCompaction({
          status: error ? "failed" : "cancelled",
          reason,
          startedAt: previous?.startedAt ?? Date.now(),
          message,
        });
        if (previous?.message !== message) onToast(message);
      } else {
        updateCompaction(null);
        // Pre-compaction usage must not keep displaying an old value such as 107%.
        setSessionStats((stats) =>
          stats?.contextUsage
            ? {
                ...stats,
                contextUsage: {
                  ...stats.contextUsage,
                  tokens: null,
                  percent: null,
                },
              }
            : stats,
        );
        setCompactCount((count) => {
          try {
            localStorage.setItem(
              `kern-compact-count:${chatId}`,
              String(count + 1),
            );
          } catch {
            /* The suggestion just resets with the session. */
          }
          return count + 1;
        });
        onToast("Context compacted");
      }
      compactionProbeRef.current = null;
      lastAgentActivityRef.current = Date.now();
      if (reason === "manual") {
        setAgentStatus("idle");
        setIsStreaming(false);
        setMessages(settleAgentMessages);
        onAgentRunning(chatId, false);
      }
      // Automatic compaction may retry or drain queued work. Wait for agent_settled.
      void sendRaw({ type: "get_session_stats" });
      void sendRaw({ type: "get_state" });
    },
    [chatId, onAgentRunning, onToast, sendRaw, updateCompaction],
  );

  const requestCompaction = useCallback(async () => {
    if (compactionRef.current?.status === "running") return;
    const id = uid();
    manualCompactionRef.current = id;
    updateCompaction({
      status: "running",
      reason: "manual",
      startedAt: Date.now(),
      awaitingStart: true,
    });
    setAgentStatus("running");
    onAgentRunning(chatId, true);
    if (!(await sendRaw({ type: "compact", id }))) {
      manualCompactionRef.current = null;
      updateCompaction({
        status: "failed",
        reason: "manual",
        startedAt: Date.now(),
        message:
          "Compaction command could not be sent. Restart the agent and retry.",
      });
      setAgentStatus("stopped");
      onAgentRunning(chatId, false);
    }
  }, [chatId, onAgentRunning, sendRaw, updateCompaction]);

  useEffect(() => {
    if (compaction?.status !== "running") return;
    const id = window.setInterval(() => {
      const current = compactionRef.current;
      if (current?.status !== "running") return;
      const requestId = uid();
      compactionProbeRef.current = {
        id: requestId,
        startedAt: current.startedAt,
      };
      void sendRaw({ type: "get_state", id: requestId });
    }, 10_000);
    return () => window.clearInterval(id);
  }, [compaction?.status, compaction?.startedAt, sendRaw]);

  useEffect(() => {
    if (agentStatus !== "running" && compaction?.status !== "running") return;
    const id = window.setInterval(() => {
      if (approval) return;
      const current = compactionRef.current;
      if (current?.status === "running") {
        if (Date.now() - current.startedAt < COMPACTION_TIMEOUT_MS) return;
        const message =
          "Context compaction exceeded 5 minutes. It was stopped; retry compaction or restart the agent to resume this saved session.";
        updateCompaction({ ...current, status: "failed", message });
        lastAgentActivityRef.current = Date.now();
        void sendRaw({ type: "abort" });
        setAgentStatus("stopped");
        setIsStreaming(false);
        onAgentRunning(chatId, false);
        setMessages(settleAgentMessages);
        onToast(message);
        return;
      }
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
  }, [
    agentStatus,
    compaction?.status,
    approval,
    chatId,
    onAgentRunning,
    onToast,
    sendRaw,
    updateCompaction,
  ]);

  // LISTENERS + SPAWN in one effect to avoid race: get_available_models lost if spawn before listen
  useEffect(() => {
    if (!globalChat && !repositoryMapLoaded) return;
    let mounted = true;
    let startupExpired = false;
    let settlementHandled = false;
    const visibleCustomMessages = new Set<string>();
    let startupStage = "connecting to the agent";
    const unlisteners: Array<() => void> = [];
    const retryIds: number[] = [];
    const stopWithError = (error: string) => {
      if (!mounted) return;
      startupExpired = true;
      window.clearTimeout(startupTimer);
      historyLoadedRef.current = true;
      setIsHistoryLoading(false);
      setIsNewSessionLoading(false);
      setAgentStatus("stopped");
      setIsStreaming(false);
      onAgentRunning(chatId, false);
      setMessages((prev) => settleWithError(prev, error));
      onToast(error);
    };
    const startupTimer = window.setTimeout(() => {
      startupExpired = true;
      stopWithError(
        `Agent startup timed out while ${startupStage} — use Restart to reconnect. Chat history has not been changed.`,
      );
    }, 30_000);
    retryIds.push(startupTimer);
    const setStartupStage = (stage: string, label: string) => {
      startupStage = stage;
      if (mounted) setHistoryLoadingStage(label);
    };

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
        assistantMessageCountRef.current <= 1 &&
        (content.text.length > 120 || content.thinking.length > 120)
      ) {
        revealFinalAssistant(content);
        return;
      }
      setMessages((prev) => {
        const copy = [...prev];
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i].role === "assistant" && copy[i].isStreaming) {
            copy[i] = mergeAssistantMessage(copy[i], content, true);
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
        // State/stat polling is not evidence that the model is making progress.
        if (t !== "response") lastAgentActivityRef.current = Date.now();

        if (t === "compaction_start" || t === "auto_compaction_start") {
          settlementHandled = false;
          flushDeltas();
          const previous = compactionRef.current;
          updateCompaction({
            status: "running",
            reason: typeof ev.reason === "string" ? ev.reason : "auto",
            startedAt:
              previous?.status === "running" ? previous.startedAt : Date.now(),
          });
          setAgentStatus("running");
          setIsStreaming(false);
          setMessages(settleAgentMessages);
          onAgentRunning(chatId, true);
          return;
        }
        if (t === "compaction_end" || t === "auto_compaction_end") {
          finishCompaction(ev);
          return;
        }

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
          if (cmd === "prompt" && ev.success === false) {
            // Preflight can reject before agent_start (for example during
            // compaction). There will be no run/settlement event to clear the UI.
            const error = String(
              ev.error ?? "Agent could not start this prompt",
            );
            setAgentStatus("idle");
            setIsStreaming(false);
            setMessages((previous) => settleWithError(previous, error));
            onAgentRunning(chatId, false);
            onToast(error);
            void sendRaw({ type: "get_state" });
            return;
          }
          if (cmd === "compact" && manualCompactionRef.current === ev.id) {
            manualCompactionRef.current = null;
            // Pi emits compaction_end before this RPC acknowledgement. Older or
            // disconnected runtimes may deliver only the acknowledgement.
            if (
              compactionRef.current?.status === "running" &&
              compactionRef.current.reason === "manual"
            )
              finishCompaction({
                reason: "manual",
                errorMessage:
                  ev.success === false
                    ? String(ev.error ?? "Compaction failed")
                    : undefined,
              });
            return;
          }
          if (cmd === "abort") {
            abortResponseRef.current?.();
            abortResponseRef.current = null;
            return;
          }
          const replacesForkHistory =
            cmd === "get_messages" &&
            forkHistoryRequestRef.current !== null &&
            ev.id === forkHistoryRequestRef.current;
          if (
            cmd === "get_messages" &&
            forkHistoryRequestRef.current &&
            !replacesForkHistory
          )
            return;
          if (replacesForkHistory) {
            if (!forkHistoryLoadingRef.current) return;
            forkHistoryLoadingRef.current = false;
            historyLoadedRef.current = true;
            setIsHistoryLoading(false);
            setIsNewSessionLoading(false);
            if (ev.success === false) {
              onToast(
                `Fork history: ${String(ev.error ?? "Could not reload messages")}`,
              );
              return;
            }
          }
          if (cmd === "get_messages" && ev.success === false) {
            historyLoadedRef.current = true;
            setIsHistoryLoading(false);
            setMessages((prev) =>
              settleWithError(
                prev,
                `Chat history could not be restored: ${String(ev.error ?? "Agent returned no history")} — use Restart to retry.`,
              ),
            );
            return;
          }
          const data = ev.data as Record<string, unknown> | undefined;
          if (!data) return;
          if (cmd === "get_commands") {
            setCommands((data.commands as SlashCommand[]) ?? []);
          } else if (cmd === "new_session") {
            forkHistoryRequestRef.current = null;
            forkHistoryLoadingRef.current = false;
            setIsNewSessionLoading(false);
            if (data.cancelled !== true) {
              updateCompaction(null);
              manualCompactionRef.current = null;
              compactionProbeRef.current = null;
              setSessionStats(null);
              setCompactCount(0);
              try {
                localStorage.removeItem(`kern-compact-count:${chatId}`);
              } catch {
                /* Nothing stored. */
              }
              setMessages([]);
              setPendingMessageCount(0);
              trackedTaskRef.current = false;
              sendRaw({ type: "get_state" });
              onToast("New context started — dev server unchanged");
            }
          } else if (cmd === "switch_session" && data.cancelled !== true) {
            updateCompaction(null);
            manualCompactionRef.current = null;
            compactionProbeRef.current = null;
            setSessionStats(null);
            forkHistoryRequestRef.current = null;
            forkHistoryLoadingRef.current = false;
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
            const inputs = modelInputs(arr);
            if (Object.keys(inputs).length > 0)
              setInputsByModel((current) => ({ ...current, ...inputs }));
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
            if (typeof data.autoCompactionEnabled === "boolean")
              setAutoCompactionEnabled(data.autoCompactionEnabled);
            const current = compactionRef.current;
            const probe = compactionProbeRef.current;
            if (probe && probe.id === ev.id) {
              compactionProbeRef.current = null;
              if (
                current?.status === "running" &&
                current.startedAt === probe.startedAt &&
                !current.awaitingStart &&
                data.isCompacting === false
              ) {
                if (data.isStreaming === true) {
                  // The runtime has resumed; a compaction_end event was missed.
                  updateCompaction(null);
                  void sendRaw({ type: "get_session_stats" });
                } else if (data.isStreaming === false) {
                  updateCompaction({
                    ...current,
                    status: "failed",
                    message:
                      "Agent is idle but no compaction result was received. Retry compaction or restart this saved session.",
                  });
                  setAgentStatus("idle");
                  setIsStreaming(false);
                  setMessages(settleAgentMessages);
                  onAgentRunning(chatId, false);
                  void sendRaw({ type: "get_session_stats" });
                }
              } else if (
                current?.status === "running" &&
                current.awaitingStart &&
                data.isCompacting === true
              ) {
                updateCompaction({ ...current, awaitingStart: false });
              }
            } else if (data.isCompacting === true && current === null) {
              // Recover the visible phase after reconnecting to a busy runtime.
              settlementHandled = false;
              updateCompaction({
                status: "running",
                reason: "auto",
                startedAt: Date.now(),
              });
              setAgentStatus("running");
              onAgentRunning(chatId, true);
            }
            if (typeof data.sessionFile === "string") {
              sessionFileRef.current = data.sessionFile;
              onSessionFile(chatId, data.sessionFile);
            }
            if ("imageInput" in data)
              setHarnessImage(
                typeof data.imageInput === "boolean" ? data.imageInput : null,
              );
            if (data.model) {
              const m = data.model as { id: string; provider?: string };
              const inputs = modelInputs([m]);
              if (Object.keys(inputs).length > 0)
                setInputsByModel((current) => ({ ...current, ...inputs }));
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
                  // The agent got image paths + a fallback marker; show what
                  // the user typed.
                  if (role === "user") text = stripDeliveryEnvelope(text);
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
                setMessages((prev) =>
                  replacesForkHistory || prev.length === 0 ? recent : prev,
                );
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
          if (
            compactionRef.current &&
            (compactionRef.current.status !== "running" ||
              manualCompactionRef.current === null)
          )
            updateCompaction(null);
          settlementHandled = false;
          setAgentTranscript([]);
          setBackgroundWork(null);
          latestAssistantResponseRef.current = "";
          receivedStreamDeltaRef.current = false;
          assistantMessageCountRef.current = 0;
          finalizedIdsRef.current.clear();
          finalizedContentRef.current.clear();
          setAgentStatus("running");
          onAgentRunning(chatId, true);
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("crc-agent-activity", {
                detail: {
                  type: "agent_start",
                  phase: "start",
                  tabId: chatId,
                },
              }),
            );
          }
          setIsStreaming(true);
          setMessages((prev) => {
            const next = ensureAssistantTurn(prev, createAssistantTurn);
            return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
          });
          return;
        }
        if (
          t === "message_start" &&
          (ev.message as { role?: string })?.role === "assistant"
        ) {
          flushDeltas();
          flushToolCalls();
          assistantMessageCountRef.current += 1;
          // Text similarity deduplicates event variants of this message only.
          // A later answer can legitimately repeat the preceding finding.
          finalizedContentRef.current.clear();
          setMessages((previous) => {
            const next = ensureAssistantTurn(previous, createAssistantTurn);
            const index = next.length - 1;
            next[index] = {
              ...next[index],
              assistantMessageStart: {
                text: next[index].text.length,
                thinking: (next[index].thinking ?? "").length,
              },
            };
            return next;
          });
          return;
        }
        if (t === "message_end" || t === "turn_end") {
          if (t === "turn_end") void sendRaw({ type: "get_session_stats" });
          flushDeltas();
          flushToolCalls();
          const message = ev.message as Record<string, unknown> | undefined;
          if (message?.role === "custom" && message.display === true) {
            const text =
              typeof message.content === "string"
                ? message.content
                : Array.isArray(message.content)
                  ? message.content
                      .filter(
                        (item) =>
                          item?.type === "text" &&
                          typeof item.text === "string",
                      )
                      .map((item) => item.text)
                      .join("\n")
                  : "";
            const key = `${message.customType}\0${message.timestamp}\0${text}`;
            if (text && !visibleCustomMessages.has(key)) {
              visibleCustomMessages.add(key);
              if (visibleCustomMessages.size > 100)
                visibleCustomMessages.delete(
                  visibleCustomMessages.values().next().value!,
                );
              setMessages((previous) => [
                ...previous,
                {
                  id: uid(),
                  role: "system",
                  text: text.slice(0, 200_000),
                  thinking: "",
                  toolCalls: [],
                  createdAt:
                    typeof message.timestamp === "number"
                      ? message.timestamp
                      : Date.now(),
                  isStreaming: false,
                },
              ]);
            }
          } else finalizeAssistant(message);
          return;
        }
        if (t === "agent_end") {
          flushDeltas();
          flushToolCalls();
          const generated = ev.messages as
            | Array<Record<string, unknown>>
            | undefined;
          const assistants =
            generated?.filter((message) => message.role === "assistant") ?? [];
          finalizeAssistant(assistants[assistants.length - 1]);
          // A low-level run ended. Retry, compaction, or queued work can still
          // continue; only agent_settled makes the session idle.
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
          if (
            compactionRef.current?.status === "running" &&
            compactionRef.current.reason === "manual" &&
            compactionRef.current.awaitingStart
          ) {
            // compact() first aborts an active turn; this is not task completion.
            flushDeltas();
            activeToolCallsRef.current.clear();
            setIsStreaming(false);
            setMessages(settleAgentMessages);
            return;
          }
          if (settlementHandled) return;
          settlementHandled = true;
          // Batched tool events must land before the run settles, or a late
          // flush opens a new bubble that never stops "Typing…".
          flushDeltas();
          flushToolCalls();
          activeToolCallsRef.current.clear();
          setAgentStatus("idle");
          sendRaw({ type: "get_session_stats" });
          onAgentRunning(chatId, false);
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("crc-agent-activity", {
                detail: {
                  type: "agent_settled",
                  phase: "idle",
                  tabId: chatId,
                },
              }),
            );
          }
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
          if (
            compactionRef.current?.status === "failed" ||
            compactionRef.current?.status === "cancelled"
          )
            return;
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
            name,
            args,
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
      setStartupStage("connecting to the agent", "CONNECTING TO AGENT");
      // listeners FIRST
      const u1 = await listen<PiEventPayload>("pi-rpc-event", (e) => {
        if (e.payload.session_id !== sessionId) return;
        handleRaw(e.payload.raw);
      });
      if (!mounted || startupExpired) {
        u1();
        return;
      }
      unlisteners.push(u1);
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
      if (!mounted || startupExpired) {
        u2();
        return;
      }
      unlisteners.push(u2);
      const u3 = await listen<{ session_id: string; error: string }>(
        "pi-rpc-error",
        (e) => {
          if (e.payload.session_id !== sessionId) return;
          stopWithError(e.payload.error);
        },
      );
      if (!mounted || startupExpired) {
        u3();
        return;
      }
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
      if (!mounted || startupExpired) {
        u4();
        return;
      }
      unlisteners.push(u4);

      try {
        if (globalChat) {
          const globalCwd = await invoke<string>("get_global_chat_cwd");
          if (!mounted || startupExpired) return;
          setCwd(globalCwd);
          setStartupStage("starting the agent", "STARTING AGENT");
          const [provider, ...modelParts] = modelRef.current.split("/");
          await invoke("spawn_pi_rpc", {
            harness: harnessRef.current,
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
          let graph: GraphStatus | null = null;
          try {
            const settings = await withTimeout(
              invoke<{ enabled: boolean }>("get_graphify_settings"),
              1500,
              "Graphify settings check timed out",
            );
            if (!mounted || startupExpired) return;
            const enabled = settings?.enabled === true;
            setGraphEnabled(enabled);
            if (enabled) {
              graph = await withTimeout(
                invoke<GraphStatus>("get_graph_status", { projectPath }),
                1500,
                "Graphify status check timed out",
              );
            }
          } catch (e) {
            // Graphify is optional; coding continues without it.
            onToast(`Graphify unavailable; coding continues (${String(e)})`);
          }
          if (!mounted || startupExpired) return;
          if (graph) {
            setGraphStatus(graph);
            graphReportRef.current = graph.report_path;
            if (graph.tracked_warning) onToast(graph.tracked_warning);
            if (graph.code_stale) {
              // Keep the existing graph available to Pi while the incremental refresh runs.
              void refreshGraph(false);
            }
          }

          if (isWorkspace) {
            setStartupStage("preparing the workspace", "PREPARING WORKSPACE");
            const workspaceCwd = await invoke<string>(
              "ensure_workspace_session",
              { workspacePath: projectPath, slug },
            );
            if (!mounted || startupExpired) return;
            setCwd(workspaceCwd);
            setStartupStage("starting the agent", "STARTING AGENT");
            const [provider, ...modelParts] = modelRef.current.split("/");
            await invoke("spawn_pi_rpc", {
              harness: harnessRef.current,
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
            setStartupStage("starting the agent", "STARTING AGENT");
            const [provider, ...modelParts] = modelRef.current.split("/");
            await invoke("spawn_pi_rpc", {
              harness: harnessRef.current,
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
            setStartupStage("preparing the worktree", "PREPARING WORKTREE");
            const wt = await invoke<WorktreeInfo>("ensure_worktree", {
              repoPath: projectPath,
              repoName: projectName,
              slug,
            });
            if (!mounted || startupExpired) return;
            if (!wt?.worktree_path)
              throw new Error(
                `Couldn't prepare a worktree for ${projectName}. Check that the repository is readable.`,
              );
            setWorktree(wt);
            setCwd(wt.worktree_path);
            // Dev-server status is independent of the agent connection.
            void invoke<DevRunnerInfo | null>("get_dev_server", {
              chatId,
              cwd: wt.worktree_path,
            })
              .then((runner) => {
                if (mounted) setDevRunner(runner);
              })
              .catch((error) => {
                if (mounted) onToast(`Dev server status: ${String(error)}`);
              });
            setStartupStage("starting the agent", "STARTING AGENT");
            const [provider, ...modelParts] = modelRef.current.split("/");
            await invoke("spawn_pi_rpc", {
              harness: harnessRef.current,
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

        if (!mounted || startupExpired) return;
        window.clearTimeout(startupTimer);
        setHistoryLoadingStage("RESTORING CHAT HISTORY");

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
        if (!mounted || startupExpired) return;
        window.clearTimeout(startupTimer);
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

    void run().catch((error) => {
      window.clearTimeout(startupTimer);
      if (!startupExpired)
        stopWithError(`Agent connection failed: ${String(error)}`);
    });
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
    finishCompaction,
    updateCompaction,
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
      forkHistoryLoadingRef.current ||
      !text.trim() ||
      driveDetached ||
      agentStatus === "stopped"
    )
      return false;
    if (text) {
      onFirstMessage(chatId, text.replace(/\s+/g, " ").slice(0, 60));
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("crc-agent-prompt", {
            detail: { text, tabId: chatId },
          }),
        );
      }
    }
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
    scrollToBottom("smooth");
    window.setTimeout(() => scrollToBottom("auto"), 60);
    await maybeCreateCheckpoint(text);
    return sendRaw({
      type: "prompt",
      message: `${text}${await taskContext(text)}`,
      images: [],
    });
  }

  async function sendWithSkill(text: string, inlineImages: ChatImage[]) {
    const context = globalChat
      ? await invoke<string>("get_rag_context", { query: text }).catch(
          (error) => {
            onToast(`RAG: ${String(error)}`);
            return "";
          },
        )
      : await taskContext(text);
    return sendRaw({
      type: "prompt",
      message: `${applyPlanModePrefix(text, planMode)}${context}`,
      images: inlineImages,
    });
  }

  // Finish the best-effort checkpoint before dispatching the next prompt so
  // its snapshot cannot include edits made by that prompt's agent turn.
  const maybeCreateCheckpoint = async (preview: string) => {
    const path = worktree?.worktree_path;
    if (!path) return;
    const message = preview.replace(/\s+/g, " ").slice(0, 120);
    await invoke("create_checkpoint", {
      worktreePath: path,
      message: message || "user message",
    }).catch((error) => {
      onToast(`Checkpoint unavailable: ${String(error)}`);
    });
  };

  // Plan-mode approval: the agent ended its plan with AWAITING PLAN APPROVAL.
  const approvePlan = async () => {
    setPlanMode(false);
    await sendPrompt("Plan approved. Proceed with implementation.");
  };

  const rejectPlan = () => {
    setPlanMode(true);
    setInput("Plan rejected: ");
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  async function handleSend() {
    const text = input.trim();
    if (
      !chatReady ||
      forkHistoryLoadingRef.current ||
      restoringDraft ||
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
    let delivery;
    try {
      delivery = planImageDelivery(
        `${text}${fileContext}`,
        images,
        imageSupportOf(modelRef.current),
      );
    } catch (error) {
      onToast(String(error));
      return;
    }
    const message = delivery.message;
    const visibleMessage =
      text || files.map((file) => `@${file.name}`).join(" ");
    if (visibleMessage) {
      onFirstMessage(chatId, visibleMessage.replace(/\s+/g, " ").slice(0, 60));
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("crc-agent-prompt", {
            detail: { text: visibleMessage, tabId: chatId },
          }),
        );
      }
    }
    taskStartedAtRef.current ??= Date.now();
    setMessages((prev) => {
      const next = [
        ...prev,
        {
          id: uid(),
          role: "user",
          text: visibleMessage,
          images: images.map(toChatImage),
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
    scrollToBottom("smooth");
    window.setTimeout(() => scrollToBottom("auto"), 60);
    await maybeCreateCheckpoint(text || visibleMessage);
    if (!(await sendWithSkill(message, delivery.images))) {
      setInput((current) => current || text);
      setImages((current) => [...images, ...current]);
      setFiles((current) => [...files, ...current]);
    }
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
      addAttachmentPaths(Array.isArray(paths) ? paths : [paths]);
    } catch (error) {
      onToast(`File attachment: ${String(error)}`);
    }
  }

  // Files dragged from Finder: Tauri owns native drops, so match the drop
  // point against the composer instead of relying on DOM drop events.
  const [dropActive, setDropActive] = useState(false);
  const addAttachmentPathsRef = useRef(addAttachmentPaths);
  addAttachmentPathsRef.current = addAttachmentPaths;
  useEffect(() => {
    if (!isActive) return;
    const composer = () => inputRef.current?.closest(".chat-composer");
    let unlisten: Promise<() => void>;
    try {
      unlisten = getCurrentWindow().onDragDropEvent(({ payload }) => {
        if (payload.type === "leave") {
          setDropActive(false);
          return;
        }
        const inside = dropLandsOn(composer(), payload.position);
        if (payload.type === "drop") {
          setDropActive(false);
          if (inside && payload.paths.length)
            addAttachmentPathsRef.current(payload.paths);
        } else setDropActive(inside);
      });
    } catch {
      return; // not inside a Tauri window (tests)
    }
    return () => {
      setDropActive(false);
      void unlisten.then((stop) => stop()).catch(() => undefined);
    };
  }, [isActive]);

  /** One way in for picked and dropped files: images go to the attachment
   * store and stay inline; other files keep the text/PDF context route. */
  function addAttachmentPaths(paths: string[]) {
    const imagePaths = paths.filter((path) => inlineImageMime(path));
    const otherPaths = paths.filter((path) => !inlineImageMime(path));
    if (otherPaths.length)
      setFiles((current) => [
        ...current,
        ...otherPaths
          .filter((path) => !current.some((item) => item.path === path))
          .map((path) => ({ path, name: fileName(path) })),
      ]);
    for (const path of imagePaths) {
      void storeAttachmentFile(chatId, path)
        .then(prepareComposerImage)
        .then((image) => {
          setImages((prev) =>
            prev.some((item) => item.path === image.path)
              ? prev
              : [...prev, image],
          );
        })
        .catch((error) =>
          onToast(`Couldn't attach ${fileName(path)}: ${String(error)}`),
        );
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (files.length > 0) {
      event.preventDefault();
      files.forEach((file) => {
        // Only expose a sendable chip after its durable copy exists.
        void storePastedFile(chatId, file)
          .then(prepareComposerImage)
          .then((image) => setImages((prev) => [...prev, image]))
          .catch((error) =>
            onToast(`Couldn't store pasted image: ${String(error)}`),
          );
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
      const current = compactionRef.current;
      if (current?.status === "running")
        updateCompaction({
          ...current,
          status: "cancelled",
          message: "Context compaction canceled. Retry compaction when ready.",
        });
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
      updateCompaction(null);
      manualCompactionRef.current = null;
      compactionProbeRef.current = null;
      try {
        await invoke("kill_pi_session", { sessionId }).catch(() => {});
        if (!chatReady) {
          // A failed bootstrap may not have installed all event listeners or
          // prepared the worktree. Retry that entire flow, not only the process.
          setMessages(clearRestartErrors);
          setIsHistoryLoading(Boolean(sessionFileRef.current));
          setAgentStatus("idle");
          setPiInstallRetry((value) => value + 1);
          onToast("Reconnecting agent session");
          return;
        }
        const [provider, ...modelParts] = modelRef.current.split("/");
        await invoke("spawn_pi_rpc", {
          harness: harnessRef.current,
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
          handoff: handoffRef.current,
        });
        // The old process's fork request must not filter the new process's history.
        forkHistoryRequestRef.current = null;
        forkHistoryLoadingRef.current = false;
        setIsHistoryLoading(false);
        setIsNewSessionLoading(false);
        updateCompaction(null);
        setAgentStatus("idle");
        setMessages(clearRestartErrors);
        onToast(retry ? "Agent retrying" : "Agent reloaded");
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
      chatReady,
      onToast,
      projectName,
      sendRaw,
      sessionId,
      updateCompaction,
    ],
  );

  // Installed agents for the composer's agent picker.
  useEffect(() => {
    let active = true;
    invoke<HarnessOption[] | null>("list_harnesses")
      .then((list) => {
        if (active && Array.isArray(list))
          setHarnessOptions(list.filter((item) => item.available));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const hasUserMessage = messages.some((message) => message.role === "user");
  // Agents can change between turns; a running turn, restart or compaction
  // belongs to the current agent.
  const agentLocked =
    agentStatus === "running" ||
    isRestarting ||
    compaction?.status === "running";
  useEffect(() => {
    const refresh = () => {
      void invoke<Record<string, number>>("get_compact_thresholds")
        .then((value) => setCompactThresholds(value ?? {}))
        .catch((error) => onToast(`Context settings: ${String(error)}`));
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("kern-context-settings-changed", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("kern-context-settings-changed", refresh);
    };
  }, [harness, isActive, onToast]);

  const currentHarness =
    harness ?? harnessOptions.find((item) => item.is_default)?.id ?? "pi";
  // A different agent answers for itself once it is up.
  useEffect(() => setHarnessImage(null), [currentHarness]);
  const imageSupportOf = useCallback(
    (model: string): ImageSupport =>
      imageSupport({
        harness: currentHarness,
        model,
        inputs: inputsByModel,
        undeclared: undeclaredModels,
        harnessImage,
      }),
    [currentHarness, inputsByModel, undeclaredModels, harnessImage],
  );
  const harnessLabel = (id: string) =>
    harnessOptions.find((item) => item.id === id)?.label ?? id;

  /**
   * Context for the agent taking over: goal, every request, files changed,
   * commands run, worktree state and the recent conversation inline, plus the
   * full transcript saved to a file it can read on demand. Built without the
   * outgoing model, which may be out of quota.
   */
  const prepareHandoff = useCallback(
    async (from: string) => {
      let source: ChatMessage[] = messages;
      // A reloaded chat only shows text; take the tool calls from the session.
      if (
        !messages.some((message) => message.toolCalls.length) &&
        sessionFileRef.current
      ) {
        try {
          const calls = await invoke<
            Array<{
              name: string;
              args: Record<string, unknown>;
              isError: boolean;
            }>
          >("session_tool_calls", { sessionFile: sessionFileRef.current });
          if (calls.length)
            source = [
              {
                id: "session-tools",
                role: "assistant",
                text: "",
                toolCalls: calls.map((call, index) => ({
                  callId: `session-${index}`,
                  name: call.name,
                  args: call.args ?? {},
                  isError: call.isError,
                  phase: "end",
                })),
              },
              ...messages,
            ];
        } catch {
          /* The text-only handoff still works. */
        }
      }
      let fullPath: string | undefined;
      try {
        fullPath = await invoke<string>("write_chat_handoff", {
          chatId,
          content: buildFullTranscript(source, from),
        });
      } catch {
        fullPath = undefined;
      }
      return buildChatHandoff({
        messages: source,
        from,
        changes: worktreeDiff?.files ?? [],
        fullPath,
      });
    },
    [chatId, messages, worktreeDiff],
  );

  const switchingAgentRef = useRef(false);
  /** Start the chosen agent in this chat. Each agent keeps its own session,
   * so a chat already underway hands the new one its conversation so far.
   * `resume` continues the interrupted request right away. */
  const changeHarness = useCallback(
    async (next: string, resume = false) => {
      if (agentLocked || next === currentHarness || switchingAgentRef.current)
        return;
      switchingAgentRef.current = true;
      try {
        const from = `${harnessLabel(currentHarness)}${modelRef.current ? ` (${modelRef.current})` : ""}`;
        const label = harnessLabel(next);
        handoffRef.current = hasUserMessage
          ? await prepareHandoff(from)
          : undefined;
        setHarness(next);
        harnessRef.current = next;
        sessionFileRef.current = undefined;
        onSessionFile(chatId, "");
        onHarnessChange?.(chatId, next);
        // A model id from one agent means nothing to another.
        modelRef.current = "";
        setCurrentModel("");
        if (hasUserMessage)
          setMessages((previous) => [
            ...previous,
            {
              id: uid(),
              role: "system",
              text: `Switched from ${from} to ${label}. ${label} starts a new session and gets this chat's goal, requests, changed files, commands and recent conversation as context${resume ? ", and continues the last request" : ""}.`,
              thinking: "",
              toolCalls: [],
              createdAt: Date.now(),
              isStreaming: false,
            },
          ]);
        onToast(`Starting ${label}…`);
        await handleRestart(resume);
      } finally {
        switchingAgentRef.current = false;
      }
    },
    [
      agentLocked,
      chatId,
      currentHarness,
      handleRestart,
      harnessOptions,
      hasUserMessage,
      onHarnessChange,
      onSessionFile,
      onToast,
      prepareHandoff,
    ],
  );

  // Usage limit (O5): the latest turn ended on a quota / rate-limit error.
  const usageLimitError = useMemo(() => {
    if (agentStatus === "running") return null;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role === "user") return null;
      const at = message.text.lastIndexOf("Agent error:");
      if (at >= 0 && isUsageLimitError(message.text.slice(at)))
        return message.text.slice(at + "Agent error:".length).trim();
    }
    return null;
  }, [messages, agentStatus]);
  const [limitDismissed, setLimitDismissed] = useState<string | null>(null);
  const continueAfterModelRef = useRef(false);
  const FALLBACK_KEY = "kern:fallback-agent";
  const fallbackAgent = (() => {
    try {
      const id = localStorage.getItem(FALLBACK_KEY);
      return id &&
        id !== currentHarness &&
        harnessOptions.some((item) => item.id === id)
        ? id
        : null;
    } catch {
      return null;
    }
  })();
  const continueWithAgent = (id: string) => {
    try {
      localStorage.setItem(FALLBACK_KEY, id);
    } catch {
      /* Remembering the fallback is a convenience. */
    }
    setLimitDismissed(usageLimitError);
    void changeHarness(id, true);
  };
  const continueWithOtherModel = () => {
    // Same agent, other model: the session (full context) stays as it is.
    continueAfterModelRef.current = true;
    setModelPickerOpen(true);
    void sendRaw({ type: "get_available_models" });
  };

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
    const switched = await sendRaw({
      type: "set_model",
      provider: provider || undefined,
      modelId,
    });
    setModelPickerOpen(false);
    if (continueAfterModelRef.current && switched) {
      continueAfterModelRef.current = false;
      setLimitDismissed(usageLimitError);
      void sendPrompt(
        "The previous model stopped before finishing (usage limit). Continue my last request from where it stopped. Check the current state of the files first and do not redo finished work.",
      );
    }
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
  useEffect(() => {
    const open = () => {
      if (isActive) {
        setModelPickerOpen(true);
        void sendRaw({ type: "get_available_models" });
      }
    };
    window.addEventListener("kern-open-model-picker", open);
    return () => window.removeEventListener("kern-open-model-picker", open);
  }, [isActive, sendRaw]);

  const worktreePathRef = useRef<string | null>(null);
  worktreePathRef.current = worktree?.worktree_path ?? null;
  // Type a command into the chat terminal's first pane, opening it if needed.
  // terminal_open is idempotent (returns scrollback for a live session).
  const runInChatTerminal = useCallback(
    async (command: string) => {
      setTerminalMounted(true);
      setShowTerminal(true);
      const key = `${chatId}__0`;
      await invoke("terminal_open", {
        chatId: key,
        cwd: worktreePathRef.current ?? cwdRef.current,
        cols: 120,
        rows: 32,
      });
      await invoke("terminal_write", { chatId: key, data: `${command}\r` });
    },
    [chatId],
  );

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
    ...(globalChat
      ? []
      : [
          {
            name: "dev",
            description: "Start the project dev server",
            source: "client" as const,
          },
        ]),
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
    if (forkHistoryLoadingRef.current) return;
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
      await requestCompaction();
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
    if (text === "/dev" && !globalChat) {
      setInput("");
      if (!devRunner) void handleRunDev();
      else onToast(`Dev server already running at ${devRunner.url}`);
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
    if (
      compactionRef.current?.status === "running" &&
      compactionRef.current.reason === "manual"
    ) {
      onToast(
        "Context compaction is running. Your draft is kept; send it when compaction finishes.",
      );
      return;
    }
    if (agentStatus === "running") {
      if (
        restoringDraft ||
        (!text && images.length === 0 && files.length === 0)
      )
        return;
      let fileContext = "";
      try {
        fileContext = await readAttachments();
      } catch (error) {
        onToast(`File attachment: ${String(error)}`);
        return;
      }
      let delivery;
      try {
        delivery = planImageDelivery(
          `${text}${fileContext}`,
          images,
          imageSupportOf(modelRef.current),
        );
      } catch (error) {
        onToast(String(error));
        return;
      }
      const messageText = delivery.message;
      const type = submitMode === "steer" ? "steer" : "follow_up";
      setMessages((prev) => {
        const message = {
          id: uid(),
          role: "user",
          text: messageText,
          images: images.map(toChatImage),
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
      scrollToBottom("smooth");
      window.setTimeout(() => scrollToBottom("auto"), 60);
      if (
        !(await sendRaw({
          type,
          message: messageText,
          images: delivery.images,
        }))
      ) {
        setInput((current) => current || text);
        setImages((current) => [...images, ...current]);
        setFiles((current) => [...files, ...current]);
        if (type === "follow_up")
          setPendingMessageCount((count) => Math.max(0, count - 1));
        return;
      }
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
  // Edit & resend (O1-07): branch the pi session just before this user
  // message (pi `fork`), put its text back in the composer, and let the user
  // edit and send. Later turns leave the model context but stay in the
  // session tree; worktree files are not rewound.
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const editAndResend = async (m: ChatMessage) => {
    if (agentStatus === "running" || editingMessageId) {
      onToast("Wait until the agent is idle to edit a message.");
      return;
    }
    if (currentHarness !== "pi") {
      onToast(
        "Edit & resend needs session branching, which only pi supports right now.",
      );
      return;
    }
    const users = messages.filter((item) => item.role === "user");
    const index = users.findIndex((item) => item.id === m.id);
    setEditingMessageId(m.id);
    try {
      const tree = await invoke<{
        entries?: Array<Record<string, unknown>>;
        leafId?: string;
      }>("get_session_tree", { sessionId });
      const target = pickEditTarget(
        activeBranchUserEntries(
          (tree.entries ?? []) as Parameters<typeof activeBranchUserEntries>[0],
          tree.leafId,
        ),
        users.map((item) => stripDeliveryEnvelope(item.text)),
        index,
      );
      if (!target) {
        onToast(
          "Couldn't match this message in the session. Pick it in the session tree.",
        );
        setSessionTreeOpen(true);
        return;
      }
      const data = await invoke<{ text?: string; cancelled?: boolean }>(
        "fork_session",
        { sessionId, nodeId: target },
      );
      if (data.cancelled) {
        onToast("Edit cancelled");
        return;
      }
      // The chat shows what the user typed; pi returns what the agent got
      // (plan prefix, attachment and task context). Edit the typed text.
      handleSessionForked(
        stripDeliveryEnvelope(m.text) || stripDeliveryEnvelope(data.text ?? ""),
      );
      onToast(
        "Edit the message and send. Later replies left the model context; worktree files are unchanged.",
      );
    } catch (error) {
      onToast(`Edit & resend: ${String(error)}`);
    } finally {
      setEditingMessageId(null);
    }
  };
  const editAndResendRef = useRef(editAndResend);
  editAndResendRef.current = editAndResend;

  const rowFlags = `${currentHarness}|${editingMessageId}|${chatId}|${copiedMessageId}|${savingMessageId}|${agentStatus}|${messages[messages.length - 1]?.id}|${worktreeDiff?.files.length}|${lastAssistantId}|${isRestarting}|${fixingPiIssueId}|${globalChat}|${terminalApprovalStatus}`;
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
    for (const message of messages) {
      if (
        message.role === "assistant" &&
        !message.text &&
        !message.thinking &&
        message.toolCalls.length === 0 &&
        message.isStreaming
      ) {
        continue;
      }
      items.push({ kind: "message", message, order: message.createdAt ?? 0 });
    }
    if (backgroundWork && agentStatus !== "running")
      items.push({
        kind: "background-work",
        order: Number.MAX_SAFE_INTEGER - 1,
      });
    if (
      agentStatus === "running" ||
      isRestarting ||
      compaction?.status === "running"
    )
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
    compaction?.status,
  ]);

  // Renders one virtualized feed row. Unchanged message rows are served from
  // rowCacheRef so streamed tokens only re-render the active row.
  // Session search (O2-02): scroll to the message that matched and flash it.
  const [revealedMessageId, setRevealedMessageId] = useState<string | null>(
    null,
  );
  const feedItemsRef = useRef(feedItems);
  feedItemsRef.current = feedItems;
  useEffect(() => {
    if (!isActive || isHistoryLoading) return;
    const timers: number[] = [];
    const reveal = (query: string) => {
      const items = feedItemsRef.current;
      const index = findMatchIndex(
        items.map((item) =>
          item.kind === "message"
            ? stripDeliveryEnvelope(item.message.text)
            : null,
        ),
        query,
      );
      const item = items[index];
      if (index < 0 || item?.kind !== "message") {
        onToast(
          "Opened the chat; the matching message is older than the loaded history.",
        );
        return;
      }
      atBottomRef.current = false;
      virtuosoRef.current?.scrollToIndex({
        index,
        align: "center",
        behavior: "auto",
      });
      setRevealedMessageId(item.message.id);
      timers.push(window.setTimeout(() => setRevealedMessageId(null), 2400));
    };
    const queued = takeReveal(chatId);
    // After the activation scroll-to-bottom (0 and 80 ms) has run.
    if (queued) timers.push(window.setTimeout(() => reveal(queued), 160));
    const onReveal = (event: Event) => {
      const detail = (event as CustomEvent<{ chatId: string; query: string }>)
        .detail;
      if (detail?.chatId !== chatId) return;
      const query = takeReveal(chatId);
      if (query) timers.push(window.setTimeout(() => reveal(query), 160));
    };
    window.addEventListener(REVEAL_EVENT, onReveal);
    return () => {
      window.removeEventListener(REVEAL_EVENT, onReveal);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [isActive, isHistoryLoading, chatId, onToast]);

  const renderFeedItemInner = (item: FeedItem): ReactNode => {
    if (item.kind === "session-loading") {
      return (
        <div
          className="session-loading pixel-session-loading"
          role="status"
          aria-live="polite"
        >
          <div className="pixel-agent-avatar-tag" title="Kern (Lead Agent)">
            <Mascot
              identity="kern"
              state="working"
              small
              className="mini"
              name="Kern"
            />
          </div>
          <span
            className="agent-working-mark pixel-agent-working-mark"
            aria-hidden="true"
          >
            <i />
            <i />
            <i />
          </span>
          <div className="session-loading-content">
            <strong>
              STARTING NEW CONTEXT
              <span className="pixel-loading-cursor" aria-hidden="true" />
            </strong>
            <small>KEEPING WORKTREE AND DEV SERVER</small>
          </div>
          <div className="pixel-loading-bar" aria-hidden="true">
            <span className="pixel-loading-bar-fill" />
          </div>
        </div>
      );
    }
    if (item.kind === "history-state") {
      return isHistoryLoading ? (
        <div
          className="session-loading pixel-session-loading"
          role="status"
          aria-live="polite"
        >
          <div className="pixel-agent-avatar-tag" title="Kern (Lead Agent)">
            <Mascot
              identity="kern"
              state="working"
              small
              className="mini"
              name="Kern"
            />
          </div>
          <span
            className="agent-working-mark pixel-agent-working-mark"
            aria-hidden="true"
          >
            <i />
            <i />
            <i />
          </span>
          <div className="session-loading-content">
            <strong>
              LOADING SESSION
              <span className="pixel-loading-cursor" aria-hidden="true" />
            </strong>
            <small>{historyLoadingStage}</small>
          </div>
          <div className="pixel-loading-bar" aria-hidden="true">
            <span className="pixel-loading-bar-fill" />
          </div>
        </div>
      ) : (
        <div className="empty-state opendots-empty-state">
          <Mascot identity="blue" state="idle" name="Dot" />
          <div
            className="display-sm"
            style={{
              color: "var(--text-secondary)",
              marginTop: "8px",
              fontWeight: 600,
            }}
          >
            AGENT IDLE. SEND PROMPT.
          </div>
          <span
            style={{
              fontSize: "13px",
              color: "var(--muted)",
              maxWidth: "340px",
              lineHeight: "1.5",
              textAlign: "center",
            }}
          >
            Ready to build, refactor, search or assist. Type a prompt or command
            below to begin.
          </span>
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
                : `chat-bubble-assistant body-md${m.isStreaming ? " is-streaming" : ""}`
          }
        >
          {m.role === "system" && <small>Agent context</small>}
          {m.role === "assistant" && (
            <div className="assistant-bubble-header">
              <div className="assistant-avatar-badge">
                <Mascot
                  identity="blue"
                  state={m.isStreaming ? "working" : "idle"}
                  small
                  className="mini"
                  name="Kern"
                />
              </div>
              <span className="assistant-author-name">Kern</span>
              {m.isStreaming && (
                <span className="assistant-streaming-indicator pixel-generating">
                  <span className="pixel-pulse-block">▋</span>
                  Typing…
                </span>
              )}
            </div>
          )}
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
                      {tools.length} tool{" "}
                      {tools.length === 1 ? "call" : "calls"}
                    </strong>
                    <span>
                      {tools
                        .map((tool) => tool.name)
                        .filter(
                          (name, index, all) => all.indexOf(name) === index,
                        )
                        .join(" · ")}
                    </span>
                    <small>Details</small>
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
                {copiedMessageId === m.id ? "Copied" : "Copy"}
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
                Try again
              </button>
              {globalChat && (
                <details className="chat-save">
                  <summary>
                    {savingMessageId === m.id ? "Saving…" : "Save as"}
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
          {m.role === "user" &&
            currentHarness === "pi" &&
            agentStatus !== "running" &&
            !globalChat && (
              <button
                className="chat-edit-resend"
                onClick={() => void editAndResendRef.current(m)}
                disabled={editingMessageId !== null}
                title="Edit & resend: branch the chat from this message"
                aria-label="Edit and resend this message"
              >
                {editingMessageId === m.id ? "…" : "EDIT"}
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
              <small>Agent request · terminal command</small>
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

        // Map active agent from the 16-bit RPG Office team
        let assignedAgent = {
          name: "Kern",
          role: "Lead Agent",
          identity: "blue",
          color: "#38bdf8",
        };

        if (isRestarting) {
          phase = "thinking";
          title = "RESTARTING PI";
          detail = "Starting the agent session";
          icon = "meter";
        } else if (compaction?.status === "running") {
          phase = "thinking";
          title = "COMPACTING CONTEXT";
          detail =
            compaction.reason === "overflow"
              ? "Recovering from the context limit before retrying"
              : "Generating a summary of the conversation";
          icon = "meter";
        } else if (activeTool) {
          phase = "executing";
          const rawName = activeTool.name
            .replace(/^functions\./, "")
            .toLowerCase();
          const cmd = String(activeTool.args?.command || "").toLowerCase();
          if (rawName === "bash") {
            if (/(test|vitest|jest|cargo.*test|pytest)/.test(cmd)) {
              assignedAgent = {
                name: "Bob",
                role: "QA Tester",
                identity: "red",
                color: "#ec4899",
              };
            } else if (/(build|compile|tauri.*build|vite.*build)/.test(cmd)) {
              assignedAgent = {
                name: "Grace",
                role: "DevOps & Server",
                identity: "yellow",
                color: "#f59e0b",
              };
            } else if (/^git\s+/.test(cmd)) {
              assignedAgent = {
                name: "Linus",
                role: "Backend Dev",
                identity: "mint",
                color: "#22c55e",
              };
            } else {
              assignedAgent = {
                name: "Grace",
                role: "DevOps & Infra",
                identity: "yellow",
                color: "#f59e0b",
              };
            }
          } else if (
            rawName === "read" ||
            rawName === "view" ||
            rawName === "cat"
          ) {
            assignedAgent = {
              name: "Ada",
              role: "Frontend Dev",
              identity: "purple",
              color: "#a855f7",
            };
          } else if (rawName === "edit" || rawName === "write") {
            assignedAgent = {
              name: "Linus",
              role: "Backend Dev",
              identity: "mint",
              color: "#22c55e",
            };
          } else if (
            rawName.includes("search") ||
            rawName.includes("grep") ||
            rawName.includes("graph")
          ) {
            assignedAgent = {
              name: "Alan",
              role: "AST & Search",
              identity: "orange",
              color: "#06b6d4",
            };
          } else if (rawName.includes("web") || rawName.includes("fetch")) {
            assignedAgent = {
              name: "Alan",
              role: "Research Agent",
              identity: "orange",
              color: "#06b6d4",
            };
          }

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
              title = "Running session";
              detail = "Interactive shell";
              icon = "terminal";
            } else if (kind === "index") {
              title = "Indexing";
              detail = "Building knowledge graph";
              icon = "graph";
            } else if (kind === "loop") {
              title = "Iterating";
              detail = "Autonomous pass";
              icon = "loop";
            } else {
              title = "Executing";
              detail = describeToolActivity(activeTool);
              icon = "meter";
            }
          }
        } else if (streamingText) {
          phase = "writing";
          assignedAgent = {
            name: "Kern",
            role: "Lead Agent",
            identity: "blue",
            color: "#38bdf8",
          };
          const lastLine =
            streamingText.split("\n").filter(Boolean).pop()?.slice(0, 55) || "";
          title = "Responding";
          detail = lastLine
            ? `${lastLine}${lastLine.length >= 55 ? "…" : ""}`
            : "Writing response";
          icon = "meter";
        } else {
          phase = "thinking";
          assignedAgent = {
            name: "Kern",
            role: "Lead Agent",
            identity: "blue",
            color: "#38bdf8",
          };
          const lastLine =
            thinkingText.split("\n").filter(Boolean).pop()?.slice(0, 55) || "";
          if (lastLine) {
            title = "Reasoning";
            detail = `${lastLine}${lastLine.length >= 55 ? "…" : ""}`;
          } else if (lastCompleted) {
            title = "Planning next step";
            detail = describeToolActivity(lastCompleted);
          } else {
            title = "Thinking";
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
        let lastUserIndex = -1;
        for (let i = messages.length - 1; i >= 0; i--)
          if (messages[i].role === "user") {
            lastUserIndex = i;
            break;
          }
        const turnTools = messages
          .slice(lastUserIndex + 1)
          .flatMap((message) => message.toolCalls);
        const runSteps = buildRunSteps(turnTools);
        const idleStep = activeTool
          ? null
          : phase === "writing"
            ? { kind: "write" as const, label: "Writing response" }
            : {
                kind: "think" as const,
                label: title.charAt(0) + title.slice(1).toLowerCase(),
              };
        return (
          <AgentRunCard
            steps={runSteps}
            idleStep={idleStep}
            title={
              activeTool &&
              runSteps.length &&
              (icon === "meter" || icon === "search")
                ? runSteps[runSteps.length - 1].label
                : title.charAt(0) + title.slice(1).toLowerCase()
            }
            detail={detail}
            model={currentModel.split("/").pop() || "Agent"}
            agentLabel={
              assignedAgent.name === "Kern" ? undefined : assignedAgent.name
            }
            color={assignedAgent.color}
            startedAt={taskStartedAtRef.current ?? Date.now()}
            ticking={isActive}
            queued={pendingMessageCount}
            isAborting={isAborting}
            onStop={handleAbort}
          >
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
          </AgentRunCard>
        );
      })();
    }
    return null;
  };

  const renderFeedItem = (index: number, item: FeedItem): ReactNode => (
    <div
      className={
        item.kind === "message" && item.message.id === revealedMessageId
          ? "feed-item-revealed"
          : undefined
      }
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

  const inAppHeader = (node: ReactNode) =>
    headerSlot ? createPortal(node, headerSlot) : node;

  const composerStatus = (
    <>
      <span
        className="composer-branch"
        title={
          worktree?.branch
            ? `Isolated worktree on ${worktree.branch}`
            : isGit || isWorkspace
              ? undefined
              : "Edits apply directly to the project folder"
        }
      >
        ⑂{" "}
        {worktree?.branch ??
          (isWorkspace
            ? `${repositories.length} repositories`
            : isGit
              ? "main"
              : globalChat
                ? "global"
                : "not isolated")}
      </span>
      {pipelineStatus && (
        <button className="pipeline-chat-status" onClick={onOpenPipeline}>
          Pipeline · {pipelineStatus.step} · {pipelineStatus.completed}/
          {pipelineStatus.total}
        </button>
      )}
      {sessionStats && (
        <button
          className="usage-summary"
          onClick={() => setUsageOpen(true)}
          title="Show token usage"
          style={{
            color:
              (sessionStats.contextUsage?.tokens ?? 0) >=
              (compactThresholds[currentHarness] ?? 200000) * 0.9
                ? "var(--warning, #b7791f)"
                : undefined,
          }}
        >
          Context{" "}
          {sessionStats.contextUsage?.tokens == null
            ? "—"
            : sessionStats.contextUsage.tokens.toLocaleString()}{" "}
          / {(compactThresholds[currentHarness] ?? 200000).toLocaleString()}
          {compactCount >= 3 && " · Consider a new chat with a summary"}
        </button>
      )}
    </>
  );

  // Width the right rail (and open panel) takes from the chat area.
  const railOffset = rightSidebarOpen ? rightPanelWidth + 38 : 38;
  const officeFull = officeView === "full";
  const officePip = officeView === "pip";
  const officeShown = officeFull || (officePip && !pipCollapsed);
  return (
    <div
      className={`chat-view${officeFull ? " is-office-full" : ""}${officeFull && !floatingChatOpen ? " is-chat-hidden" : ""}`}
      style={{
        ["--office-rail" as string]: `${railOffset}px`,
        flex: 1,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        position: "relative",
        overflow: "hidden",
        overflowX: "hidden",
        overscrollBehaviorX: "none",
        width: "100%",
        maxWidth: "100%",
        touchAction: "pan-y",
      }}
    >
      {officeView !== "panel" && (
        <div
          className={`chat-office-layer is-${officeView}${officePip && pipCollapsed ? " is-collapsed" : ""}`}
          style={
            officePip
              ? {
                  right: pip.right + railOffset,
                  bottom: pip.bottom,
                  width: pip.width,
                  height: pipCollapsed ? undefined : pip.height,
                }
              : undefined
          }
        >
          {officePip && (
            <div
              className="chat-office-pip-bar"
              onPointerDown={(event) => dragPip(event, "move")}
              title="Drag to move"
            >
              <span
                className="chat-office-pip-grip"
                aria-hidden="true"
                title="Drag to resize"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  dragPip(event, "resize");
                }}
              />
              <strong>Office</strong>
              {officeData.running && <em>working</em>}
              <button
                type="button"
                onClick={() => setPipCollapsed((value) => !value)}
                aria-expanded={!pipCollapsed}
              >
                {pipCollapsed ? "Show" : "Hide"}
              </button>
              <button
                type="button"
                onClick={() => changeOfficeView("panel")}
                title="Back to the side panel"
              >
                ✕
              </button>
            </div>
          )}
          <div
            ref={setOfficeLayerEl}
            className="chat-office-layer-stage"
            hidden={officePip && pipCollapsed}
          />
        </div>
      )}
      {inAppHeader(
        <div
          className={`chat-header ${
            headerSlot
              ? "in-app-header"
              : rightSidebarOpen
                ? "has-code-rail-rail-open"
                : "has-code-rail"
          }`}
          style={
            headerSlot
              ? undefined
              : {
                  paddingRight: rightSidebarOpen ? rightPanelWidth + 48 : 48,
                  boxSizing: "border-box",
                  maxWidth: "100%",
                  overflowX: "hidden",
                }
          }
        >
          <div className="chat-header-left">
            <div className="chat-session-badge">
              <span className="chat-session-dot" />
              <strong className="chat-session-name">
                {globalChat ? "Global chat" : projectName}
              </strong>
              <button
                onClick={handleClose}
                className="chat-session-close"
                title="Close chat"
                aria-label="Close chat"
              >
                ✕
              </button>
            </div>
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
            {!globalChat && graphEnabled && graphStatus && (
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
          </div>

          <div className="chat-header-actions">
            <button
              onClick={openModelPicker}
              className="dev-control dev-control-model"
              title="Change model (Ctrl+L or /model) — works in Global and project chat"
              aria-label="Change model"
            >
              {currentModel
                ? (currentModel.split("/").pop()?.slice(0, 24) ?? "Model")
                : "Model"}
            </button>
            <button
              onClick={handleOpenTerminal}
              className={`dev-control open dev-control-term${showTerminal ? " active" : ""}`}
            >
              Terminal
            </button>
            <button
              onClick={() => {
                if (currentHarness !== "pi") {
                  onToast(
                    "Edit/resend via session branching is currently available for pi only. Worktree files are unchanged.",
                  );
                  return;
                }
                setSessionTreeOpen(true);
              }}
              className="dev-control dev-control-tree"
              title="Session tree — fork a new branch from a past user message"
              aria-label="Open session tree"
            >
              Tree
            </button>
            {!globalChat && devRunner && (
              <>
                <button onClick={handleStopDev} className="dev-control stop">
                  Stop
                </button>
                <button
                  onClick={() => openUrl(devRunner.url)}
                  className="dev-control open"
                >
                  {devRunner.url}
                </button>
              </>
            )}
            {!globalChat && devError && (
              <span className="dev-error" title={devError}>
                Dev server failed: {devError}
              </span>
            )}
            {agentStatus === "running" && (
              <button
                onClick={handleAbort}
                disabled={isAborting}
                className="caption-uppercase"
              >
                {isAborting ? "Stopping…" : "Stop"}
              </button>
            )}
            {agentStatus !== "running" && (
              <button
                onClick={() => handleRestart()}
                className="caption-uppercase"
                disabled={isRestarting}
              >
                {isRestarting
                  ? "Reloading…"
                  : agentStatus === "stopped"
                    ? "Restart"
                    : "Reload agent"}
              </button>
            )}
          </div>
        </div>,
      )}

      {terminalMounted && (
        <Suspense fallback={null}>
          <TerminalPanel
            chatId={chatId}
            cwd={cwd}
            hidden={!showTerminal}
            onClose={() => setShowTerminal(false)}
          />
        </Suspense>
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
          imageSupportOf={imageSupportOf}
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
          rightSidebarOpen
            ? "chat-content has-code-rail-rail-open"
            : "chat-content has-code-rail"
        }
        style={{
          flex: 1,
          height: "100%",
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          paddingRight: rightSidebarOpen ? rightPanelWidth + 38 : 38,
          marginRight: 0,
          overflowX: "hidden",
          overscrollBehaviorX: "none",
          width: "100%",
          maxWidth: "100%",
          minWidth: 0,
          boxSizing: "border-box",
        }}
      >
        {officeFull && (
          <div ref={setOfficeRosterEl} className="chat-office-roster" />
        )}
        <Virtuoso
          ref={virtuosoRef}
          style={{
            flex: 1,
            height: "100%",
            minHeight: 0,
            minWidth: 0,
            overflowX: "hidden",
            overscrollBehaviorX: "none",
            width: "100%",
            maxWidth: "100%",
          }}
          data={feedItems}
          computeItemKey={feedItemKey}
          followOutput={(isAtBottom) => {
            const last = messages[messages.length - 1];
            if (last?.role === "user") return "auto";
            return isAtBottom ? "auto" : false;
          }}
          alignToBottom
          atBottomStateChange={handleAtBottomStateChange}
          itemContent={renderFeedItem}
          components={VIRTUOSO_COMPONENTS}
        />

        {agentStatus !== "running" && planApprovalPending(messages) && (
          <div
            role="status"
            aria-live="polite"
            className="caption-uppercase"
            style={{
              maxWidth: 880,
              margin: "0 auto",
              padding: "8px var(--spacing-md)",
              display: "flex",
              alignItems: "center",
              gap: 12,
              border: "1px solid var(--accent)",
              borderRadius: 8,
              background: "var(--surface-solid)",
            }}
          >
            <span style={{ flex: 1 }}>PLAN READY — APPROVE TO BUILD</span>
            <button
              onClick={() => void approvePlan()}
              className="composer-chip"
              style={{
                borderColor: "#7bc98a",
                color: "#9fe0ab",
                letterSpacing: "0.08em",
              }}
            >
              ✓ APPROVE
            </button>
            <button
              onClick={rejectPlan}
              className="composer-chip"
              style={{
                borderColor: "#ff7069",
                color: "#ff9b96",
                letterSpacing: "0.08em",
              }}
            >
              ✕ REJECT
            </button>
          </div>
        )}
        {(compaction || (sessionStats?.contextUsage?.percent ?? 0) >= 90) && (
          <div
            role="status"
            aria-live="polite"
            className="caption-uppercase"
            style={{
              maxWidth: 880,
              margin: "0 auto",
              padding: "8px var(--spacing-md)",
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 12,
              border: "1px solid var(--accent)",
              borderRadius: 8,
              background: "var(--surface-solid)",
            }}
          >
            <span style={{ flex: 1 }}>
              {compaction?.status === "running" ? (
                <>
                  Compacting context ·{" "}
                  <ElapsedLabel
                    startedAt={compaction.startedAt}
                    ticking={isActive}
                  />{" "}
                  · Generating conversation summary
                </>
              ) : (
                (compaction?.message ??
                `Context nearly full · Auto compaction ${autoCompactionEnabled === false ? "off" : autoCompactionEnabled === true ? "on" : "status unavailable"}`)
              )}
            </span>
            {compaction?.status === "running" ? (
              <button
                className="composer-chip"
                onClick={handleAbort}
                disabled={isAborting}
              >
                Cancel compaction
              </button>
            ) : (
              <>
                <button
                  className="composer-chip"
                  onClick={() => void requestCompaction()}
                  disabled={
                    !chatReady || agentStatus === "running" || isRestarting
                  }
                >
                  {compaction ? "Retry compaction" : "Compact context"}
                </button>
                {compaction && (
                  <button
                    className="composer-chip"
                    onClick={() => void handleRestart(false)}
                    disabled={isRestarting}
                  >
                    Restart agent
                  </button>
                )}
              </>
            )}
          </div>
        )}
        {worktree && (
          <WorktreeSetup
            project={projectPath}
            worktree={worktree.worktree_path}
            onToast={onToast}
            runInTerminal={runInChatTerminal}
          />
        )}
        {usageLimitError && limitDismissed !== usageLimitError && (
          <section
            className="terminal-command-approval usage-limit-banner"
            role="alert"
            aria-label="Usage limit reached"
          >
            <small>
              {harnessLabel(currentHarness)}
              {currentModel ? ` · ${currentModel}` : ""} hit a usage limit
            </small>
            <p>
              Continue this chat with another model. The same agent keeps the
              full session; another agent gets the goal, requests, changed
              files, commands and recent conversation, plus the full transcript
              on file.
            </p>
            <div className="usage-limit-actions">
              {fallbackAgent && (
                <button
                  className="approval-primary"
                  disabled={agentLocked}
                  onClick={() => continueWithAgent(fallbackAgent)}
                >
                  Continue with {harnessLabel(fallbackAgent)}
                </button>
              )}
              <button
                className={fallbackAgent ? undefined : "approval-primary"}
                disabled={agentLocked}
                onClick={continueWithOtherModel}
              >
                Other {harnessLabel(currentHarness)} model…
              </button>
              {harnessOptions
                .filter(
                  (item) =>
                    item.id !== currentHarness && item.id !== fallbackAgent,
                )
                .map((item) => (
                  <button
                    key={item.id}
                    disabled={agentLocked}
                    onClick={() => continueWithAgent(item.id)}
                  >
                    Continue with {item.label}
                  </button>
                ))}
              <button onClick={() => setLimitDismissed(usageLimitError)}>
                Dismiss
              </button>
            </div>
          </section>
        )}
        <ChatComposer
          globalChat={globalChat}
          planMode={planMode}
          onPlanModeChange={setPlanMode}
          driveDetached={driveDetached}
          agentStatus={
            compaction?.status === "running" ? "running" : agentStatus
          }
          isNewSessionLoading={isNewSessionLoading || restoringDraft}
          chatReady={chatReady}
          isAborting={isAborting}
          researchBusy={researchBusy}
          researchUsageError={researchUsageError}
          projectPath={projectPath}
          inputPlaceholder={inputPlaceholder}
          input={input}
          promptHistory={messages
            .filter((message) => message.role === "user")
            .map((message) => stripDeliveryEnvelope(message.text))}
          images={images}
          imageSupport={imageSupportOf(currentModel)}
          dropActive={dropActive}
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
          status={composerStatus}
          agentOptions={harnessOptions}
          agentValue={currentHarness}
          agentLocked={agentLocked}
          onAgentChange={(next) => void changeHarness(next)}
        />
      </div>
      {officeFull && (
        <button
          type="button"
          className="chat-float-toggle"
          onClick={() => setFloatingChatOpen((open) => !open)}
          aria-expanded={floatingChatOpen}
        >
          {floatingChatOpen ? "Hide chat" : "Chat"}
          {!floatingChatOpen && officeData.running && <em>working</em>}
        </button>
      )}
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
      {/* VSCode right sidebar: activity rail + explorer + diff; global chat
          has no project, so it only gets the office and usage panels. */}
      <ChatRightSidebar
        onSendToAgent={(text) => {
          setInput((current) => (current ? `${current}\n\n${text}` : text));
          onToast("CI status added to your draft. Review it before sending.");
        }}
        open={rightSidebarOpen}
        activity={rightActivity}
        panelWidth={rightPanelWidth}
        worktree={worktree}
        isWorkspace={isWorkspace}
        worktreeDiff={worktreeDiff}
        cwd={cwd}
        projectName={projectName}
        repositoryStatuses={repositoryStatuses}
        onOpenChange={handleRightSidebarOpen}
        onActivityChange={handleRightActivity}
        office={officeData}
        onPanelWidthChange={setRightPanelWidth}
        onOpenDiff={setExpandedDiff}
        onWorktreeDiffChange={setWorktreeDiff}
        onToast={onToast}
        active={isActive}
        codePanels={!globalChat}
        officeView={officeView}
        officeLayer={officeLayerEl}
        officeRoster={officeFull ? officeRosterEl : null}
        officeShown={officeShown}
        onOfficeViewChange={changeOfficeView}
      />
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
              aria-valuenow={
                sessionStats.contextUsage?.percent == null
                  ? undefined
                  : Math.max(
                      0,
                      Math.min(100, sessionStats.contextUsage.percent),
                    )
              }
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
              {sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite >
                0 && (
                <>
                  <div>
                    <dt>CACHE READ</dt>
                    <dd>
                      {sessionStats.tokens.cacheRead.toLocaleString()} (
                      {cacheHitPercent(sessionStats.tokens)}% of input)
                    </dd>
                  </div>
                  <div>
                    <dt>CACHE WRITE</dt>
                    <dd>{sessionStats.tokens.cacheWrite.toLocaleString()}</dd>
                  </div>
                </>
              )}
              <div>
                <dt>TOTAL</dt>
                <dd>{sessionStats.tokens.total.toLocaleString()}</dd>
              </div>
              {typeof sessionStats.cost === "number" && (
                <div>
                  <dt>COST</dt>
                  <dd>${sessionStats.cost.toFixed(2)}</dd>
                </div>
              )}
            </dl>
            <p>
              Auto compaction:{" "}
              {autoCompactionEnabled === null
                ? "status unavailable"
                : autoCompactionEnabled
                  ? "on"
                  : "off"}
            </p>
            <button
              className="composer-chip"
              onClick={() => {
                setUsageOpen(false);
                void requestCompaction();
              }}
              disabled={
                !chatReady || compaction?.status === "running" || isRestarting
              }
            >
              Compact context
            </button>
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
      {sessionTreeOpen && (
        <SessionTreePanel
          sessionId={sessionId}
          agentRunning={agentStatus === "running"}
          onToast={onToast}
          onForked={handleSessionForked}
          onClose={() => setSessionTreeOpen(false)}
        />
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
            comments={diffComments}
            onRemoveComment={(id) =>
              setDiffComments((current) =>
                current.filter((comment) => comment.id !== id),
              )
            }
            onComment={(path, line, text) =>
              setDiffComments((current) => [
                ...current,
                { id: uid(), path, line, text },
              ])
            }
            onSendComments={() => {
              if (agentStatus !== "idle") {
                onToast(
                  "Wait until the agent is idle to send review comments.",
                );
                return;
              }
              const batch = diffComments;
              void sendPrompt(formatDiffComments(batch)).then((sent) => {
                if (sent)
                  setDiffComments((current) =>
                    current.filter(
                      (comment) =>
                        !batch.some((item) => item.id === comment.id),
                    ),
                  );
              });
            }}
            onPositionChange={setDiffPos}
            onClose={() => setExpandedDiff(null)}
            worktreePath={worktree?.worktree_path ?? null}
            repositoryRoots={Object.fromEntries(
              repositoryStatuses.map((repository) => [
                repository.name,
                `${cwdRef.current}/${repository.name}`,
              ]),
            )}
            onToast={onToast}
            onDiffInvalidated={refreshDiff}
          />
        )}
      {approval && (
        <ApprovalDialog req={approval} onRespond={handleApprovalResponse} />
      )}
    </div>
  );
}
