import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ChatImage, ChatMessage, ToolCall, ApprovalRequest } from "../lib/rpc";
import { parseApprovalRequest } from "../lib/rpc";
import ToolCallView from "./ToolCall";
import MarkdownMessage from "./MarkdownMessage";
import ThinkingBlock from "./ThinkingBlock";
import ApprovalDialog from "./ApprovalDialog";
import FilePicker from "./FilePicker";
import DiffPanel from "./DiffPanel";

type PiEventPayload = { session_id: string; raw: string };
type WorktreeInfo = { worktree_path: string; branch: string; repo_name: string; slug: string; parent_ref: string };
type SlashCommand = { name: string; description?: string; source: string };
type GraphStatus = { state: "none" | "fresh" | "stale-code" | "stale-docs"; code_stale: boolean; docs_stale: boolean; report_path?: string; tracked_warning?: string };
type WorktreeDiff = { merge_base: string; files: Array<{ path: string; status: string; added: number; removed: number; patch: string }> };
type DevRunnerInfo = { command: string; url: string; running: boolean };

const MAX_HISTORY = 600;

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

async function notifyAgentFinished(projectName: string) {
  const granted = await isPermissionGranted() || await requestPermission() === "granted";
  if (granted) sendNotification({ title: "Agent selesai", body: `${projectName} siap ditinjau.`, sound: "Glass" });
}

function tsvToMarkdown(text: string): string | null {
  const norm = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/, "");
  if (!norm.includes("\t")) return null;
  const rows: string[][] = [[]];
  let cell = "";
  let quoted = false;
  for (let i = 0; i <= norm.length; i++) {
    const char = norm[i] ?? "\n";
    if (char === '"' && quoted && norm[i + 1] === '"') { cell += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === "\t" && !quoted) { rows[rows.length - 1].push(cell); cell = ""; }
    else if (char === "\n" && !quoted) { rows[rows.length - 1].push(cell); cell = ""; if (i < norm.length) rows.push([]); }
    else cell += char;
  }
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c.trim() === "")) rows.pop();
  if (rows.length === 0) return null;
  const colCount = Math.max(...rows.map((r) => r.length));
  if (colCount <= 1) return null;
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ↵ ").trim();
  const padded = rows.map((r) => {
    const c = r.slice();
    while (c.length < colCount) c.push("");
    return c.map(esc);
  });
  const header = padded[0];
  const sep = Array(colCount).fill("---");
  let md = `| ${header.join(" | ")} |\n| ${sep.join(" | ")} |`;
  for (let i = 1; i < padded.length; i++) md += `\n| ${padded[i].join(" | ")} |`;
  return md;
}

function extractMarkdownTables(text: string): { header: string[]; rows: string[][] }[] {
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
    const parseRow = (s: string) => s.replace(/^\|/, "").replace(/\|$/, "").split("|").map((x) => x.trim().replace(/\\\|/g, "|"));
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
  const q = tokenEnd === -1 ? after : after.slice(0, tokenEnd);
  if (q.length > 80) return null;
  return q;
}

export default function ChatView({
  projectPath,
  projectName,
  isGit,
  chatId,
  sessionFile,
  initialModel,
  initialThinking,
  initialInterrupted,
  onSessionFile,
  onFirstMessage,
  onRuntimeSettings,
  onAgentRunning,
  onClose,
  onToast,
  isActive,
}: {
  projectPath: string;
  projectName: string;
  isGit: boolean;
  chatId: string;
  sessionFile?: string;
  initialModel?: string;
  initialThinking?: string;
  initialInterrupted?: boolean;
  onSessionFile: (chatId: string, sessionFile: string) => void;
  onFirstMessage: (chatId: string, message: string) => void;
  onRuntimeSettings: (chatId: string, model: string, thinking: string) => void;
  onAgentRunning: (chatId: string, running: boolean) => void;
  onClose: () => void;
  onToast: (m: string) => void;
  isActive: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isHistoryLoading, setIsHistoryLoading] = useState(Boolean(sessionFile));
  const [input, setInput] = useState("");
  const [images, setImages] = useState<ChatImage[]>([]);
  const [previewImage, setPreviewImage] = useState<ChatImage | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [worktree, setWorktree] = useState<WorktreeInfo | null>(null);
  const [cwd, setCwd] = useState(projectPath);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [agentStatus, setAgentStatus] = useState<"idle" | "running" | "stopped">(initialInterrupted ? "stopped" : "idle");
  const [driveDetached, setDriveDetached] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [currentModel, setCurrentModel] = useState(initialModel ?? "");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [modelIndex, setModelIndex] = useState(0);
  const [currentThinking, setCurrentThinking] = useState(initialThinking ?? "");
  const [filePickerQuery, setFilePickerQuery] = useState<string | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [commandIndex, setCommandIndex] = useState(0);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [worktreeDiff, setWorktreeDiff] = useState<WorktreeDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [graphStatus, setGraphStatus] = useState<GraphStatus | null>(null);
  const [graphBusy, setGraphBusy] = useState(false);
  const [devRunner, setDevRunner] = useState<DevRunnerInfo | null>(null);
  const [pendingDevCommand, setPendingDevCommand] = useState<string | null>(null);
  const graphReportRef = useRef<string | undefined>(undefined);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const sessionFileRef = useRef(sessionFile);
  const modelRef = useRef(initialModel ?? "");
  const thinkingRef = useRef(initialThinking ?? "");
  const pendingTaskPromptRef = useRef("");
  const trackedTaskRef = useRef(false);

  const sessionId = useRef(`chat-${chatId}`).current;
  const slug = useRef(chatId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").slice(0, 32)).current;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    setFilePickerQuery(deriveAtQuery(input));
    const textarea = inputRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
    }
  }, [input]);

  const upsertToolCall = useCallback((callId: string, patch: Partial<ToolCall> & { name?: string; args?: Record<string, unknown> }) => {
    setMessages((prev) => {
      const copy = [...prev];
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
  }, []);

  const appendTextDelta = useCallback((textDelta: string) => {
    setMessages((prev) => {
      const copy = [...prev];
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].role === "assistant" && copy[i].isStreaming) {
          copy[i] = { ...copy[i], text: copy[i].text + textDelta };
          if (copy[i].text.length > 200_000) copy[i] = { ...copy[i], text: copy[i].text.slice(-200_000) };
          break;
        }
      }
      return copy;
    });
  }, []);

  const appendThinkingDelta = useCallback((delta: string) => {
    setMessages((prev) => {
      const copy = [...prev];
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].role === "assistant" && copy[i].isStreaming) {
          copy[i] = { ...copy[i], thinking: (copy[i].thinking ?? "") + delta };
          break;
        }
      }
      return copy;
    });
  }, []);

  const refreshGraph = useCallback(async (full: boolean) => {
    setGraphBusy(true);
    try {
      const next = await invoke<GraphStatus>("build_graph", { projectPath, full });
      graphReportRef.current = next.report_path;
      setGraphStatus(next);
      if (next.tracked_warning) onToast(next.tracked_warning);
      onToast(full ? "Graph built" : "Graph updated");
      if (full && window.confirm("Add Graphify exclusions to ~/.gitignore_global as a safety net?")) {
        const path = await invoke<string>("enable_global_graphignore");
        onToast(`Global Graphify ignore enabled: ${path}`);
      }
      return next;
    } catch (e) {
      onToast(`Graphify: ${String(e)}`);
      return null;
    } finally {
      setGraphBusy(false);
    }
  }, [projectPath, onToast]);

  const syncKanbanTask = useCallback(async (status: "In Progress" | "Review", prompt?: string) => {
    try {
      const updated = await invoke<string | null>("sync_chat_task", { input: { project: projectName, session_id: sessionId, prompt, status } });
      if (updated) onToast(`Kanban: ${projectName} → ${updated}`);
    } catch (error) {
      onToast(`Kanban sync: ${String(error)}`);
    }
  }, [projectName, sessionId, onToast]);

  const updateGraphIfCodeStale = useCallback(async () => {
    try {
      const next = await invoke<GraphStatus>("get_graph_status", { projectPath });
      setGraphStatus(next);
      graphReportRef.current = next.report_path;
      if (next.code_stale) await refreshGraph(false);
    } catch (e) {
      onToast(`Graphify status: ${String(e)}`);
    }
  }, [projectPath, refreshGraph, onToast]);

  useEffect(() => {
    if (!isGit) return;
    let fingerprint: string | null | undefined;
    const check = async () => {
      try {
        const next = await invoke<string | null>("get_git_fingerprint", { projectPath });
        if (fingerprint !== undefined && next !== fingerprint) await refreshGraph(false);
        fingerprint = next;
      } catch (e) {
        onToast(`Git watcher: ${String(e)}`);
      }
    };
    void check();
    const id = window.setInterval(check, 5000);
    return () => window.clearInterval(id);
  }, [isGit, projectPath, refreshGraph, onToast]);

  const refreshDiff = useCallback(async () => {
    if (!worktree) return;
    setDiffLoading(true);
    try { setWorktreeDiff(await invoke<WorktreeDiff>("get_worktree_diff", { worktreePath: worktree.worktree_path, parentRef: worktree.parent_ref })); }
    catch (error) { onToast(String(error)); }
    finally { setDiffLoading(false); }
  }, [worktree, onToast]);

  useEffect(() => { if (agentStatus === "idle") void refreshDiff(); }, [agentStatus, refreshDiff]);

  const sendRaw = useCallback(
    async (obj: Record<string, unknown>) => {
      const line = JSON.stringify(obj);
      try {
        await invoke("send_pi_command", { sessionId, jsonLine: line });
      } catch (e) {
        const msg = String(e);
        if (msg.includes("crashed") || msg.includes("closed") || msg.includes("unknown session")) setAgentStatus("stopped");
        onToast(msg);
      }
    },
    [sessionId, onToast]
  );

  // LISTENERS + SPAWN in one effect to avoid race: get_available_models lost if spawn before listen
  useEffect(() => {
    let mounted = true;
    const unlisteners: Array<() => void> = [];
    const retryIds: number[] = [];

    function messageContent(message: Record<string, unknown> | undefined) {
      if (!message) return { text: "", thinking: "" };
      if (typeof message.content === "string") return { text: message.content, thinking: "" };
      if (!Array.isArray(message.content)) return { text: typeof message.text === "string" ? message.text : "", thinking: "" };
      const blocks = message.content as Array<{ type?: string; text?: string; thinking?: string }>;
      return {
        text: blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n"),
        thinking: blocks.filter((block) => block.type === "thinking").map((block) => block.thinking ?? block.text ?? "").join("\n"),
      };
    }

    function finalizeAssistant(message: Record<string, unknown> | undefined) {
      if (message?.role !== "assistant") return;
      const content = messageContent(message);
      const blocks = Array.isArray(message.content) ? message.content as Array<{ type?: string }> : [];
      const usedTool = message.stopReason === "toolUse" || blocks.some((block) => block.type === "toolCall");
      if (!content.text && !content.thinking && !usedTool) return;
      setMessages((prev) => {
        const copy = [...prev];
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i].role === "assistant" && copy[i].isStreaming) {
            copy[i] = { ...copy[i], text: content.text || copy[i].text, thinking: content.thinking || copy[i].thinking };
            return copy;
          }
        }
        return [...copy, { id: uid(), role: "assistant", text: usedTool ? "" : content.text, thinking: content.thinking, toolCalls: [], isStreaming: false }];
      });
    }

    function handleRaw(raw: string) {
      if (!mounted) return;
      try {
        const ev = JSON.parse(raw) as Record<string, unknown>;
        const t = ev.type as string | undefined;
        if (!t) return;

        if (t === "extension_ui_request") {
          const req = parseApprovalRequest(sessionId, raw);
          if (req) {
            setApproval(req);
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
          const data = ev.data as Record<string, unknown> | undefined;
          if (!data) return;
          if (cmd === "get_commands") {
            setCommands((data.commands as SlashCommand[]) ?? []);
          } else if (cmd === "get_available_models") {
            const arr = (data.models as Array<{ id: string; provider?: string }>) ?? [];
            if (arr.length > 0) {
              setModels(arr.map((x) => `${x.provider ?? ""}/${x.id}`.replace(/^\//, "")));
            }
          } else if (cmd === "cycle_model") {
            const model = data.model as { id: string; provider?: string } | undefined;
            if (model) {
              const value = `${model.provider ?? ""}/${model.id}`.replace(/^\//, "");
              modelRef.current = value;
              setCurrentModel(value);
            }
            if (data.thinkingLevel) {
              thinkingRef.current = String(data.thinkingLevel);
              setCurrentThinking(thinkingRef.current);
            }
          } else if (cmd === "cycle_thinking_level") {
            if (data.level) setCurrentThinking(String(data.level));
          } else if (cmd === "get_state") {
            if (typeof data.sessionFile === "string") {
              sessionFileRef.current = data.sessionFile;
              onSessionFile(chatId, data.sessionFile);
            }
            if (data.model) {
              const m = data.model as { id: string; provider?: string };
              modelRef.current = `${m.provider ?? ""}/${m.id}`.replace(/^\//, "");
              setCurrentModel(modelRef.current);
            }
            if (data.thinkingLevel) {
              thinkingRef.current = String(data.thinkingLevel);
              setCurrentThinking(thinkingRef.current);
            }
            onRuntimeSettings(chatId, modelRef.current, thinkingRef.current);
          } else if (cmd === "get_messages") {
            setIsHistoryLoading(false);
            const hist = data.messages as Array<Record<string, unknown>> | undefined;
            if (hist && hist.length > 0) {
              const mapped: ChatMessage[] = hist
                .map((mm) => {
                  const role = (mm.role as string) ?? "assistant";
                  if (role === "toolResult" || role === "bashExecution" || (role === "custom" && mm.display === false)) return null;
                  let text = "";
                  let historyImages: ChatImage[] = [];
                  if (typeof mm.content === "string") text = mm.content;
                  else if (Array.isArray(mm.content)) {
                    const content = mm.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
                    text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
                    historyImages = content
                      .filter((c): c is ChatImage => c.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string")
                      .map(({ type, data, mimeType }) => ({ type, data, mimeType }));
                  }
                  if (!text && typeof mm.text === "string") text = mm.text as string;
                  if (!text && historyImages.length === 0) return null;
                  return {
                    id: (mm.id as string) ?? uid(),
                    role: role === "user" ? "user" : role === "assistant" ? "assistant" : "system",
                    text: text.slice(0, 200_000),
                    images: historyImages,
                    thinking: "",
                    toolCalls: [],
                    isStreaming: false,
                  } as ChatMessage;
                })
                .filter(Boolean) as ChatMessage[];
              if (mapped.length > 0) {
                setMessages((prev) => (prev.length === 0 ? mapped : prev));
                if (mapped[mapped.length - 1].role === "user") setAgentStatus("stopped");
              }
            }
          }
          return;
        }

        if (t === "agent_start") {
          setAgentStatus("running");
          onAgentRunning(chatId, true);
          setIsStreaming(true);
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant" && last.isStreaming) return prev;
            const next = [...prev, { id: uid(), role: "assistant", text: "", thinking: "", toolCalls: [], isStreaming: true } as ChatMessage];
            return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
          });
          return;
        }
        if (t === "message_end" || t === "turn_end") {
          finalizeAssistant(ev.message as Record<string, unknown> | undefined);
          return;
        }
        if (t === "agent_end") {
          const generated = ev.messages as Array<Record<string, unknown>> | undefined;
          const assistants = generated?.filter((message) => message.role === "assistant") ?? [];
          finalizeAssistant(assistants[assistants.length - 1]);
          return;
        }
        if (t === "agent_settled") {
          setAgentStatus("idle");
          onAgentRunning(chatId, false);
          setIsStreaming(false);
          setMessages((prev) => prev.map((x) => (x.isStreaming ? { ...x, isStreaming: false } : x)));
          void notifyAgentFinished(projectName).catch((error) => onToast(`Notification: ${String(error)}`));
          void updateGraphIfCodeStale();
          if (trackedTaskRef.current) void syncKanbanTask("Review");
          return;
        }

        if (t === "message_update") {
          const delta = ev.assistantMessageEvent as Record<string, unknown> | undefined;
          if (!delta) return;
          const dtype = delta.type as string;
          if (dtype === "text_delta") appendTextDelta(String(delta.delta ?? ""));
          else if (dtype === "thinking_delta") appendThinkingDelta(String(delta.delta ?? ""));
          else if (dtype === "toolcall_start") {
            const tc = delta.toolCall as { id?: string; name?: string; arguments?: Record<string, unknown> } | undefined;
            const callId = tc?.id ?? (delta.toolCallId as string | undefined);
            const name = tc?.name ?? (delta.toolName as string | undefined);
            const args = tc?.arguments ?? (delta.args as Record<string, unknown>) ?? {};
            if (callId && name) upsertToolCall(callId, { name, args, phase: "start", callId });
            if (name === "track_kanban_task") {
              const status = args.status === "Done" ? "Done" : "In Progress";
              const description = typeof args.description === "string" ? args.description : pendingTaskPromptRef.current;
              trackedTaskRef.current = status !== "Done";
              void invoke<string | null>("sync_chat_task", { input: { project: projectName, session_id: sessionId, prompt: description, status } })
                .then((updated) => updated && onToast(`Kanban: ${projectName} → ${updated}`))
                .catch((error) => onToast(`Kanban sync: ${String(error)}`));
            }
          } else if (dtype === "toolcall_delta") {
            const callId = delta.toolCallId as string | undefined;
            if (callId) upsertToolCall(callId, { args: (delta.args as Record<string, unknown>) ?? {}, phase: "delta", callId });
          } else if (dtype === "toolcall_end") {
            const tc = delta.toolCall as { id?: string; name?: string; arguments?: Record<string, unknown> } | undefined;
            const callId = tc?.id ?? (delta.toolCallId as string | undefined);
            const name = tc?.name ?? (delta.toolName as string) ?? "tool";
            const args = tc?.arguments ?? (delta.args as Record<string, unknown>) ?? {};
            if (callId) upsertToolCall(callId, { name, args, phase: "end", callId });
            if (name === "edit" || name === "write") {
              const path = args.path;
              if (typeof path === "string") setEditingFile(path);
            }
          }
          return;
        }

        if (t === "tool_execution_start") {
          const callId = String(ev.toolCallId ?? uid());
          const name = String(ev.toolName ?? "tool");
          upsertToolCall(callId, { name, args: (ev.args as Record<string, unknown>) ?? {}, phase: "start", callId });
          return;
        }
        if (t === "tool_execution_update") {
          if (ev.toolCallId) {
            const callId = String(ev.toolCallId);
            upsertToolCall(callId, { phase: "delta", callId, result: ev.partialResult as unknown });
          }
          return;
        }
        if (t === "tool_execution_end") {
          if (!ev.toolCallId) return;
          const callId = String(ev.toolCallId);
          upsertToolCall(callId, {
            phase: "end",
            callId,
            result: ev.result as unknown,
            isError: Boolean(ev.isError),
          });
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
      const u2 = await listen<{ session_id: string; cwd_exists: boolean }>("pi-rpc-ended", (e) => {
        if (e.payload.session_id !== sessionId) return;
        setAgentStatus("stopped");
        setIsStreaming(false);
        setDriveDetached(!e.payload.cwd_exists);
        onToast(e.payload.cwd_exists ? "Agent stopped — use Restart." : "Drive detached — reconnect drive, then retry.");
      });
      unlisteners.push(u2);
      const u3 = await listen<{ session_id: string; error: string }>("pi-rpc-error", (e) => {
        if (e.payload.session_id !== sessionId) return;
        onToast(e.payload.error);
      });
      unlisteners.push(u3);
      const u4 = await listen<{ session_id: string; line: string }>("pi-rpc-stderr", (e) => {
        if (e.payload.session_id !== sessionId) return;
        if (e.payload.line.trim()) onToast(`pi stderr: ${e.payload.line.slice(0, 180)}`);
      });
      unlisteners.push(u4);

      try {
        let graph = await invoke<GraphStatus>("get_graph_status", { projectPath });
        if (!mounted) return;
        setGraphStatus(graph);
        graphReportRef.current = graph.report_path;
        if (graph.tracked_warning) onToast(graph.tracked_warning);
        if (graph.state === "none" && window.confirm(`Build Graphify knowledge graph for ${projectName}? This full build may use an LLM for docs.`)) {
          graph = await refreshGraph(true) ?? graph;
        } else if (graph.code_stale) {
          graph = await refreshGraph(false) ?? graph;
        }
        graphReportRef.current = graph.report_path;

        if (!isGit) {
          setCwd(projectPath);
          const [provider, ...modelParts] = modelRef.current.split("/");
          await invoke("spawn_pi_rpc", {
            sessionId,
            cwd: projectPath,
            sessionFile: sessionFileRef.current,
            provider: modelParts.length ? provider : undefined,
            model: modelParts.length ? modelParts.join("/") : modelRef.current || undefined,
            thinking: thinkingRef.current || undefined,
            graphReportPath: graphReportRef.current,
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
          const [provider, ...modelParts] = modelRef.current.split("/");
          await invoke("spawn_pi_rpc", {
            sessionId,
            cwd: wt.worktree_path,
            sessionFile: sessionFileRef.current,
            provider: modelParts.length ? provider : undefined,
            model: modelParts.length ? modelParts.join("/") : modelRef.current || undefined,
            thinking: thinkingRef.current || undefined,
            graphReportPath: graphReportRef.current,
          });
        }

        const initial = () => {
          sendRaw({ type: "get_available_models" });
          sendRaw({ type: "get_commands" });
          sendRaw({ type: "get_state" });
          sendRaw({ type: "get_messages" });
        };
        initial();
        // pi boot takes time for extensions, retry models
        retryIds.push(window.setTimeout(() => mounted && sendRaw({ type: "get_available_models" }), 2000));
        retryIds.push(window.setTimeout(() => mounted && sendRaw({ type: "get_available_models" }), 5000));
        retryIds.push(window.setTimeout(() => mounted && sendRaw({ type: "get_available_models" }), 9000));
      } catch (e) {
        const msg = String(e);
        setIsHistoryLoading(false);
        if (msg.includes("detached") || msg.includes("not found") || msg.includes("does not exist")) setDriveDetached(true);
        onToast(msg);
      }
    }

    run();
    return () => {
      mounted = false;
      retryIds.forEach(clearTimeout);
      unlisteners.forEach((u) => u());
    };
  }, [projectPath, projectName, isGit, slug, chatId, sessionId, sendRaw, onToast, onSessionFile, onAgentRunning, appendTextDelta, appendThinkingDelta, upsertToolCall, refreshGraph, updateGraphIfCodeStale, syncKanbanTask]);

  async function handleSend() {
    const text = input.trim();
    if ((!text && images.length === 0) || driveDetached || agentStatus === "stopped") return;
    if (text) onFirstMessage(chatId, text.replace(/\s+/g, " ").slice(0, 60));
    setMessages((prev) => {
      const next = [...prev, { id: uid(), role: "user", text, images, thinking: "", toolCalls: [] } as ChatMessage];
      return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
    });
    setInput("");
    setImages([]);
    pendingTaskPromptRef.current = text;
    await sendRaw({ type: "prompt", message: text, images });
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (files.length > 0) {
      event.preventDefault();
      files.forEach((file) => {
        const reader = new FileReader();
        reader.onload = () => {
          const data = String(reader.result).split(",", 2)[1];
          if (data) setImages((prev) => [...prev, { type: "image", data, mimeType: file.type }]);
        };
        reader.onerror = () => onToast(`Couldn't paste ${file.name || "image"}`);
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
          newValue = mdTable + (after ? "\n\n" + after.replace(/^\n+/, "") : "\n");
        } else {
          const b = before.endsWith("\n\n") ? before : before.endsWith("\n") ? before + "\n" : before + "\n\n";
          const a = after.startsWith("\n\n") ? after : after.startsWith("\n") ? "\n" + after : after ? "\n\n" + after : "\n";
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

  async function handleApprovalResponse(payload: Record<string, unknown>) {
    setApproval(null);
    await sendRaw(payload);
  }

  async function handleAbort() {
    await sendRaw({ type: "abort" });
    setAgentStatus("idle");
    setIsStreaming(false);
    setMessages((prev) => prev.map((message) => message.isStreaming ? { ...message, isStreaming: false } : message));
    onAgentRunning(chatId, false);
    onToast("Agent aborted");
  }

  async function handleRestart(retry = false) {
    setAgentStatus("idle");
    setDriveDetached(false);
    try {
      const [provider, ...modelParts] = modelRef.current.split("/");
      await invoke("spawn_pi_rpc", {
        sessionId,
        cwd,
        sessionFile: sessionFileRef.current,
        provider: modelParts.length ? provider : undefined,
        model: modelParts.length ? modelParts.join("/") : modelRef.current || undefined,
        thinking: thinkingRef.current || undefined,
        graphReportPath: graphReportRef.current,
      });
      onToast(retry ? "Agent retrying" : "Agent restarted");
      setTimeout(() => {
        sendRaw({ type: "get_state" });
        if (retry) sendRaw({ type: "prompt", message: "Continue the interrupted task from where you left off. Check the current state first and do not repeat completed work." });
      }, 300);
    } catch (e) {
      onToast(String(e));
      if (String(e).includes("detached")) setDriveDetached(true);
    }
  }

  async function handleRunDev() {
    if (!worktree) return;
    try {
      const key = `crc-dev-command:${projectPath}`;
      const saved = localStorage.getItem(key);
      const command = saved ?? await invoke<string>("detect_dev_command", { cwd: worktree.worktree_path });
      if (!saved) return setPendingDevCommand(command);
      setDevRunner(await invoke<DevRunnerInfo>("start_dev_server", { chatId, cwd: worktree.worktree_path, command }));
      onToast(`Dev server started: ${command}`);
    } catch (error) { onToast(String(error)); }
  }

  async function confirmRunDev() {
    if (!worktree || !pendingDevCommand) return;
    try {
      localStorage.setItem(`crc-dev-command:${projectPath}`, pendingDevCommand);
      setDevRunner(await invoke<DevRunnerInfo>("start_dev_server", { chatId, cwd: worktree.worktree_path, command: pendingDevCommand }));
      setPendingDevCommand(null);
    } catch (error) { onToast(String(error)); }
  }

  async function handleStopDev() {
    await invoke("stop_dev_server", { chatId }).catch((error) => onToast(String(error)));
    setDevRunner(null);
  }

  async function handleClose() {
    if (isStreaming) {
      onToast("Still streaming — abort first.");
      return;
    }
    try {
      await invoke("stop_dev_server", { chatId }).catch(() => {});
      await invoke("kill_pi_session", { sessionId }).catch(() => {});
      if (worktree && isGit) {
        const removed = await invoke<boolean>("remove_worktree", {
          repoPath: projectPath,
          worktreePath: worktree.worktree_path,
          parentRef: worktree.parent_ref,
        }).catch(() => false);
        if (removed) onToast(`Worktree removed: ${worktree.worktree_path}`);
      }
    } finally {
      onClose();
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
    await sendRaw({ type: "set_model", provider: provider || undefined, modelId });
    setModelPickerOpen(false);
    setModelQuery("");
    setModelIndex(0);
  }

  async function handleSetThinking(lvl: string) {
    thinkingRef.current = lvl;
    setCurrentThinking(lvl);
    onRuntimeSettings(chatId, modelRef.current, lvl);
    await sendRaw({ type: "set_thinking_level", level: lvl });
  }

  const tablePreviews = useMemo(() => extractMarkdownTables(input), [input]);

  const atHint = filePickerQuery !== null ? `Searching: ${filePickerQuery || "(all)"} — click to insert.` : "";
  const filteredModels = models.filter((model) => model.toLowerCase().includes(modelQuery.trim().toLowerCase()));

  function openModelPicker() {
    setModelPickerOpen(true);
    setModelQuery("");
    setModelIndex(Math.max(0, models.indexOf(currentModel)));
    requestAnimationFrame(() => modelSearchRef.current?.focus());
  }
  const slashQuery = input.startsWith("/") && !input.includes(" ") ? input.slice(1).toLowerCase() : null;
  const clientCommands: SlashCommand[] = [
    { name: "model", description: "Choose the active model", source: "client" },
    { name: "thinking", description: "Set reasoning level", source: "client" },
    { name: "compact", description: "Compact session context", source: "client" },
  ];
  const slashCommands = slashQuery === null ? [] : [...clientCommands, ...commands]
    .filter((command, index, all) => command.name.toLowerCase().includes(slashQuery) && all.findIndex((item) => item.name === command.name) === index)
    .slice(0, 12);

  function chooseCommand(command: SlashCommand) {
    if (command.name === "model") {
      setInput("");
      openModelPicker();
    } else if (command.name === "thinking") setInput(`/${command.name} `);
    else setInput(`/${command.name}`);
    setCommandIndex(0);
  }

  async function submitInput(mode: "prompt" | "follow_up" = "prompt") {
    const text = input.trim();
    if (text === "/compact") {
      setInput("");
      await sendRaw({ type: "compact" });
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
    if (mode === "follow_up") {
      if (!text) return;
      setInput("");
      await sendRaw({ type: "follow_up", message: text });
      return;
    }
    await handleSend();
  }

  useEffect(() => {
    function applySavedSettings(event: Event) {
      const settings = (event as CustomEvent<Record<string, unknown>>).detail;
      if (typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string") {
        sendRaw({ type: "set_model", provider: settings.defaultProvider, modelId: settings.defaultModel });
      }
      if (typeof settings.defaultThinkingLevel === "string") sendRaw({ type: "set_thinking_level", level: settings.defaultThinkingLevel });
      const compaction = settings.compaction as Record<string, unknown> | undefined;
      if (typeof compaction?.enabled === "boolean") sendRaw({ type: "set_auto_compaction", enabled: compaction.enabled });
      const retry = settings.retry as Record<string, unknown> | undefined;
      if (typeof retry?.enabled === "boolean") sendRaw({ type: "set_auto_retry", enabled: retry.enabled });
      if (settings.steeringMode === "all" || settings.steeringMode === "one-at-a-time") sendRaw({ type: "set_steering_mode", mode: settings.steeringMode });
      if (settings.followUpMode === "all" || settings.followUpMode === "one-at-a-time") sendRaw({ type: "set_follow_up_mode", mode: settings.followUpMode });
      setTimeout(() => sendRaw({ type: "get_state" }), 100);
    }
    window.addEventListener("pi-settings-saved", applySavedSettings);
    return () => window.removeEventListener("pi-settings-saved", applySavedSettings);
  }, [sendRaw]);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (!isActive) return;
      if (event.key === "Escape" && agentStatus === "running") {
        event.preventDefault();
        void handleAbort();
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

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", gap: "var(--spacing-xs)", alignItems: "center", padding: "var(--spacing-sm) var(--spacing-md)", borderBottom: "1px solid var(--colors-hairline)", flexWrap: "wrap" }}>
        <strong className="title-md" style={{ color: "var(--colors-on-dark)", letterSpacing: "1px" }}>{projectName}</strong>
        <button onClick={handleClose} className="small-icon-button" title="Close chat" aria-label="Close chat">✕</button>
        {!isGit && <span className="category-tag">NOT ISOLATED</span>}
        {driveDetached && <span className="category-tag" style={{ color: "var(--colors-muted-soft)" }}>DRIVE DETACHED</span>}
        {agentStatus === "stopped" && <span className="category-tag" style={{ color: "var(--colors-muted-soft)" }}>AGENT STOPPED</span>}
        {graphStatus && <button
          className="category-tag graph-status"
          disabled={graphBusy}
          title={graphStatus.tracked_warning ?? "Graphify status — click to rebuild"}
          onClick={() => graphStatus.state !== "fresh" && refreshGraph(graphStatus.state === "none" || graphStatus.docs_stale)}
        >{graphBusy && <span className="graph-spinner" aria-hidden="true" />}GRAPH {graphBusy ? "UPDATING…" : graphStatus.state}</button>}
        
        <div style={{ marginLeft: "auto", display: "flex", gap: "var(--spacing-md)", alignItems: "center" }}>
          {worktree && !devRunner && <button onClick={handleRunDev} className="dev-control run">▶ RUN DEV</button>}
          {devRunner && <><button onClick={handleStopDev} className="dev-control stop">■ STOP</button><button onClick={() => openUrl(devRunner.url)} className="dev-control open">↗ OPEN APP</button></>}
          {agentStatus === "running" && <button onClick={handleAbort} className="caption-uppercase">ABORT</button>}
          {agentStatus === "stopped" && <button onClick={() => handleRestart()} className="caption-uppercase">RESTART</button>}
        </div>
      </div>

      {pendingDevCommand && <div className="project-branch-backdrop" role="presentation">
        <div className="project-branch-picker dev-command-dialog" role="dialog" aria-modal="true" aria-labelledby="dev-command-title">
          <small>DEV SERVER / {worktree?.branch}</small>
          <strong id="dev-command-title">Run detected command?</strong>
          <code>{pendingDevCommand}</code>
          <p>Runs only in this chat worktree. This command is remembered for {projectName}.</p>
          <div className="project-dialog-actions"><button className="project-save-branch" onClick={confirmRunDev}>RUN DEV</button><button className="project-dialog-cancel" onClick={() => setPendingDevCommand(null)}>CANCEL</button></div>
        </div>
      </div>}

      {modelPickerOpen && (
        <div className="model-picker-backdrop" onMouseDown={() => setModelPickerOpen(false)}>
          <section className="model-picker" role="dialog" aria-modal="true" aria-label="Select model" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <span>MODEL CATALOG</span>
              <button onClick={() => setModelPickerOpen(false)} aria-label="Close model picker">ESC</button>
            </header>
            <div className="model-search"><span>›</span><input
              ref={modelSearchRef}
              value={modelQuery}
              onChange={(event) => { setModelQuery(event.target.value); setModelIndex(0); }}
              onKeyDown={(event) => {
                if (event.key === "Escape") setModelPickerOpen(false);
                else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setModelIndex((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + filteredModels.length) % filteredModels.length);
                } else if (event.key === "Enter" && filteredModels[modelIndex]) {
                  event.preventDefault();
                  handleSetModel(filteredModels[modelIndex]);
                }
              }}
              placeholder="FILTER PROVIDER OR MODEL…"
            /></div>
            <div className="model-list" role="listbox">
              {filteredModels.map((model, index) => {
                const slash = model.indexOf("/");
                const provider = slash === -1 ? "default" : model.slice(0, slash);
                const name = slash === -1 ? model : model.slice(slash + 1);
                return <button
                  key={model}
                  className={index === modelIndex ? "active" : ""}
                  onMouseEnter={() => setModelIndex(index)}
                  onClick={() => handleSetModel(model)}
                  role="option"
                  aria-selected={model === currentModel}
                >
                  <span className="model-arrow">{index === modelIndex ? "→" : ""}</span>
                  <strong>{name}</strong>
                  <small>[{provider}]</small>
                  <b>{model === currentModel ? "✓" : ""}</b>
                </button>;
              })}
              {filteredModels.length === 0 && <div className="model-empty">NO MATCHING MODELS</div>}
            </div>
            <footer><span>{filteredModels.length ? `${modelIndex + 1}/${filteredModels.length}` : "0/0"}</span><span>↑↓ NAVIGATE · ENTER SELECT</span></footer>
          </section>
        </div>
      )}

      {driveDetached && (
        <div className="surface-card" style={{ padding: "var(--spacing-sm) var(--spacing-md)", borderBottom: "1px solid var(--colors-hairline)", display: "flex", justifyContent: "space-between" }}>
          <span className="caption-uppercase">DRIVE DETACHED — RECONNECT</span>
          <button onClick={() => handleRestart()} className="button-primary" style={{ padding: "var(--spacing-xxs) var(--spacing-sm)" }}>RECONNECT</button>
        </div>
      )}

      <div className={worktree ? "chat-content has-activity-rail" : "chat-content"}>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column" }}>
          <div style={{ maxWidth: 880, width: "100%", margin: "0 auto", padding: "var(--spacing-xl) var(--spacing-md)", display: "flex", flexDirection: "column", gap: "var(--spacing-xl)" }}>
        {messages.length === 0 && (isHistoryLoading ? (
          <div className="session-loading" role="status" aria-live="polite">
            <span className="agent-working-mark" aria-hidden="true"><i /><i /><i /></span>
            <div><strong>LOADING SESSION</strong><small>RESTORING CHAT HISTORY</small></div>
          </div>
        ) : (
          <div className="display-sm" style={{ color: "var(--colors-muted)", marginTop: "var(--spacing-xl)" }}>
            AGENT IDLE. SEND PROMPT.
          </div>
        ))}
        {messages.map((m) => (
          <div
            key={m.id}
            className={m.role === "user" ? "chat-bubble-user body-md" : m.role === "system" ? "chat-notice body-sm" : "chat-bubble-assistant body-md"}
          >
            {m.role === "system" && <small>PI CONTEXT</small>}
            {m.thinking && <ThinkingBlock>{m.thinking}</ThinkingBlock>}
            {m.images && m.images.length > 0 && <div className="chat-images">{m.images.map((image, index) => <button key={index} onClick={() => setPreviewImage(image)}><img src={`data:${image.mimeType};base64,${image.data}`} alt="Pasted attachment" /></button>)}</div>}
            {m.text && <MarkdownMessage>{m.text}</MarkdownMessage>}
            {agentStatus === "stopped" && m.role === "user" && m.id === messages[messages.length - 1]?.id && (
              <button onClick={() => handleRestart(true)} className="chat-retry" title="Retry interrupted task" aria-label="Retry interrupted task">↻</button>
            )}
            {m.toolCalls.length > 0 && (
              <details className="tool-stack">
                <summary>
                  <span className="tool-stack-icon">{m.toolCalls.some((tool) => tool.phase !== "end") ? "◌" : "✓"}</span>
                  <strong>{m.toolCalls.length} TOOL {m.toolCalls.length === 1 ? "CALL" : "CALLS"}</strong>
                  <span>{m.toolCalls.map((tool) => tool.name).filter((name, index, all) => all.indexOf(name) === index).join(" · ")}</span>
                  <small>DETAILS</small>
                </summary>
                <div className="tool-stack-items">{m.toolCalls.map((tc) => <ToolCallView key={tc.callId} tc={tc} />)}</div>
              </details>
            )}
          </div>
        ))}
        {agentStatus === "running" && (
          <div className="agent-working" role="status" aria-live="polite">
            <span className="agent-working-mark"><i /><i /><i /></span>
            <div><strong>AGENT WORKING</strong><small>{messages.some((message) => message.toolCalls.some((tool) => tool.phase !== "end")) ? "RUNNING TOOLS" : "THINKING"}</small></div>
            <span className="agent-working-line" />
            <button onClick={handleAbort}>ABORT</button>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      </div>

      <div style={{ borderTop: "1px solid var(--colors-hairline)" }}>
        <div style={{ maxWidth: 880, margin: "0 auto", padding: "var(--spacing-md)", position: "relative", display: "flex", gap: "var(--spacing-md)", alignItems: "flex-end" }}>
        {slashCommands.length > 0 && (
          <div className="slash-menu" role="listbox">
            {slashCommands.map((command, index) => (
              <button
                key={`${command.source}-${command.name}`}
                className={index === commandIndex ? "active" : ""}
                onMouseDown={(event) => { event.preventDefault(); chooseCommand(command); }}
                role="option"
                aria-selected={index === commandIndex}
              >
                <strong>/{command.name}</strong>
                <span>{command.description || command.source}</span>
                <small>{command.source}</small>
              </button>
            ))}
          </div>
        )}
        {filePickerQuery !== null && (
          <FilePicker
            projectPath={projectPath}
            query={filePickerQuery}
            onPick={(f) => {
              const atIdx = input.lastIndexOf("@");
              if (atIdx === -1) return;
              const before = input.slice(0, atIdx);
              const after = input.slice(atIdx + 1);
              const tokenEnd = after.search(/[\s\n]/);
              const rest = tokenEnd === -1 ? "" : after.slice(tokenEnd);
              setInput(`${before}@${f.relative} ${rest}`.trimStart() + " ");
              setFilePickerQuery(null);
            }}
            onClose={() => setFilePickerQuery(null)}
          />
        )}
        {tablePreviews.length > 0 && (
          <div className="table-preview">
            <div className="table-preview-head">
              <span>TABLE PREVIEW · {tablePreviews[0].header.length} cols · {tablePreviews[0].rows.length} rows</span>
              <button onClick={() => {
                // remove table block from input
                const lines = input.split("\n");
                const cleaned = [] as string[];
                let skipping = false;
                for (const l of lines) {
                  const t = l.trim();
                  if (!skipping && t.startsWith("|") && /\|/.test(t)) {
                    // naive: skip all consecutive | lines that include separator
                    if (/^\|\s*:?-{2,}/.test(t) || (cleaned.length > 0 && cleaned[cleaned.length - 1]?.trim().startsWith("|"))) {
                      skipping = true;
                    }
                  }
                  if (skipping) {
                    if (!t.startsWith("|") && t !== "") { skipping = false; cleaned.push(l); }
                    continue;
                  }
                  cleaned.push(l);
                }
                setInput(cleaned.join("\n").trim());
              }} title="Remove table">✕</button>
            </div>
            <div className="md-table-wrapper">
              <table>
                <thead><tr>{tablePreviews[0].header.map((c, i) => <th key={i}>{c || `COL ${i + 1}`}</th>)}</tr></thead>
                <tbody>{tablePreviews[0].rows.slice(0, 30).map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci} title={c}>{c}</td>)}</tr>)}</tbody>
              </table>
            </div>
            {tablePreviews[0].rows.length > 30 && <small className="table-preview-more">+{tablePreviews[0].rows.length - 30} more rows hidden — will still send full table</small>}
          </div>
        )}
        {images.length > 0 && <div className="image-previews">{images.map((image, index) => <div key={index}><button onClick={() => setPreviewImage(image)} title="Preview image"><img src={`data:${image.mimeType};base64,${image.data}`} alt="Pasted attachment preview" /></button><button className="image-remove" onClick={() => setImages((prev) => prev.filter((_, i) => i !== index))} title="Remove image" aria-label="Remove image">×</button></div>)}</div>}
        <textarea
          ref={inputRef}
          value={input}
          onPaste={handlePaste}
          onChange={(e) => { setInput(e.target.value); setCommandIndex(0); }}
          onKeyDown={(e) => {
            if (e.altKey && e.key === "Enter") {
              e.preventDefault();
              submitInput("follow_up");
              return;
            }
            if (e.ctrlKey && e.key.toLowerCase() === "j") {
              e.preventDefault();
              setInput((current) => `${current}\n`);
              return;
            }
            if (slashCommands.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setCommandIndex((current) => (current + (e.key === "ArrowDown" ? 1 : -1) + slashCommands.length) % slashCommands.length);
              return;
            }
            if (slashCommands.length > 0 && (e.key === "Tab" || e.key === "Enter")) {
              e.preventDefault();
              chooseCommand(slashCommands[commandIndex]);
              return;
            }
            if (filePickerQuery !== null && e.key === "Escape") {
              e.preventDefault();
              setFilePickerQuery(null);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              if (filePickerQuery !== null) {
                e.preventDefault();
                return;
              }
              e.preventDefault();
              submitInput();
            }
          }}
          placeholder={driveDetached ? "DRIVE DETACHED" : "TYPE MESSAGE… PASTE IMAGE. SHIFT+ENTER NEWLINE. @ FILE PICKER."}
          aria-disabled={driveDetached || agentStatus === "stopped"}
          rows={1}
          className="text-input body-md"
          style={{ flex: 1, maxHeight: 180, overflowY: "auto", padding: "var(--spacing-sm) 0", resize: "none" }}
        />
        {agentStatus === "running" ? (
           <button onClick={handleAbort} className="button-primary chat-action chat-action-abort">ABORT</button>
        ) : (
           <button onClick={() => submitInput()} disabled={driveDetached || agentStatus === "stopped" || (!input.trim() && images.length === 0)} className="button-primary chat-action">SEND</button>
        )}
      </div>
      </div>
      </div>
      {atHint && <div className="caption-uppercase" style={{ maxWidth: 880, margin: "0 auto", padding: "0 var(--spacing-md) var(--spacing-md)" }}>{atHint.toUpperCase()}</div>}
      {worktree && <div className="activity-rail">
        <button className={rightSidebarOpen ? "active" : ""} onClick={() => setRightSidebarOpen((open) => !open)} title="Changes" aria-label={`Changes${worktreeDiff?.files.length ? ` (${worktreeDiff.files.length} files)` : ""}`} aria-expanded={rightSidebarOpen}>⇄{Boolean(worktreeDiff?.files.length) && <span className="activity-badge">{worktreeDiff?.files.length}</span>}</button>
      </div>}
      {worktree && rightSidebarOpen && <DiffPanel
        worktreePath={worktree.worktree_path}
        parentRef={worktree.parent_ref}
        editingFile={editingFile}
        open={rightSidebarOpen}
        diff={worktreeDiff}
        loading={diffLoading}
        onRefresh={refreshDiff}
        onClose={() => setRightSidebarOpen(false)}
        onToast={onToast}
        onHandoff={() => {
          const message = "Use the git-push-workflow skill to review, commit, push, and ship the current worktree changes.";
          setMessages((prev) => [...prev, { id: uid(), role: "user", text: message, thinking: "", toolCalls: [] } as ChatMessage]);
          sendRaw({ type: "prompt", message });
        }}
      />}
      <footer className="chat-status">
        <span>⑂ {worktree?.branch ?? (isGit ? "main" : "not isolated")}</span>
        <span>{currentModel ? currentModel.replace("/", " | ") : "model loading…"}{currentThinking ? ` | ${currentThinking}` : ""}</span>
      </footer>
      {previewImage && <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="Image preview" onClick={() => setPreviewImage(null)}><button aria-label="Close image preview">×</button><img src={`data:${previewImage.mimeType};base64,${previewImage.data}`} alt="Attachment preview" onClick={(event) => event.stopPropagation()} /></div>}
      {approval && <ApprovalDialog req={approval} onRespond={handleApprovalResponse} />}
    </div>
  );
}
