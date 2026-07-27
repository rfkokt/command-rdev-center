import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ChatMessage, ToolCall, ApprovalRequest } from "../lib/rpc";
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

const MAX_HISTORY = 600;

function uid() {
  return Math.random().toString(36).slice(2, 10);
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
  onSessionFile,
  onRuntimeSettings,
  onClose,
  onToast,
}: {
  projectPath: string;
  projectName: string;
  isGit: boolean;
  chatId: string;
  sessionFile?: string;
  initialModel?: string;
  initialThinking?: string;
  onSessionFile: (chatId: string, sessionFile: string) => void;
  onRuntimeSettings: (chatId: string, model: string, thinking: string) => void;
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [worktree, setWorktree] = useState<WorktreeInfo | null>(null);
  const [cwd, setCwd] = useState(projectPath);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [agentStatus, setAgentStatus] = useState<"idle" | "running" | "stopped">("idle");
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const sessionFileRef = useRef(sessionFile);
  const modelRef = useRef(initialModel ?? "");
  const thinkingRef = useRef(initialThinking ?? "");

  const sessionId = useRef(`chat-${chatId}`).current;
  const slug = useRef(chatId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").slice(0, 32)).current;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    setFilePickerQuery(deriveAtQuery(input));
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
            copy[i] = { ...copy[i], text: usedTool ? "" : content.text || copy[i].text, thinking: content.thinking || copy[i].thinking };
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
            const hist = data.messages as Array<Record<string, unknown>> | undefined;
            if (hist && hist.length > 0) {
              const mapped: ChatMessage[] = hist
                .map((mm) => {
                  const role = (mm.role as string) ?? "assistant";
                  if (role === "toolResult" || role === "bashExecution" || (role === "custom" && mm.display === false)) return null;
                  let text = "";
                  if (typeof mm.content === "string") text = mm.content;
                  else if (Array.isArray(mm.content)) {
                    text = (mm.content as Array<{ type: string; text?: string }>)
                      .filter((c) => c.type === "text")
                      .map((c) => c.text ?? "")
                      .join("\n");
                  }
                  if (!text && typeof mm.text === "string") text = mm.text as string;
                  if (!text) return null;
                  return {
                    id: (mm.id as string) ?? uid(),
                    role: role === "user" ? "user" : role === "assistant" ? "assistant" : "system",
                    text: text.slice(0, 200_000),
                    thinking: "",
                    toolCalls: [],
                    isStreaming: false,
                  } as ChatMessage;
                })
                .filter(Boolean) as ChatMessage[];
              if (mapped.length > 0) setMessages((prev) => (prev.length === 0 ? mapped : prev));
            }
          }
          return;
        }

        if (t === "agent_start") {
          setAgentStatus("running");
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
          setIsStreaming(false);
          setMessages((prev) => prev.map((x) => (x.isStreaming ? { ...x, isStreaming: false } : x)));
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
            if (callId && name) upsertToolCall(callId, {
              name,
              args: tc?.arguments ?? (delta.args as Record<string, unknown>) ?? {},
              phase: "start",
              callId,
            });
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
  }, [projectPath, projectName, isGit, slug, chatId, sessionId, sendRaw, onToast, onSessionFile, appendTextDelta, appendThinkingDelta, upsertToolCall]);

  async function handleSend() {
    const text = input.trim();
    if (!text || driveDetached || agentStatus === "stopped") return;
    setMessages((prev) => {
      const next = [...prev, { id: uid(), role: "user", text, thinking: "", toolCalls: [] } as ChatMessage];
      return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
    });
    setInput("");
    await sendRaw({ type: "prompt", message: text });
  }

  async function handleApprovalResponse(payload: Record<string, unknown>) {
    setApproval(null);
    await sendRaw(payload);
  }

  async function handleRestart() {
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
      });
      onToast("Agent restarted");
      setTimeout(() => sendRaw({ type: "get_state" }), 300);
    } catch (e) {
      onToast(String(e));
      if (String(e).includes("detached")) setDriveDetached(true);
    }
  }

  async function handleClose() {
    if (isStreaming) {
      onToast("Still streaming — abort first.");
      return;
    }
    try {
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
      if (event.key === "Escape" && agentStatus === "running") {
        event.preventDefault();
        sendRaw({ type: "abort" });
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
  }, [agentStatus, sendRaw, models, currentModel]);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", gap: "var(--spacing-xs)", alignItems: "center", padding: "var(--spacing-sm) var(--spacing-md)", borderBottom: "1px solid var(--colors-hairline)", flexWrap: "wrap" }}>
        <strong className="title-md" style={{ color: "var(--colors-on-dark)", letterSpacing: "1px" }}>{projectName}</strong>
        <button onClick={handleClose} className="caption-uppercase" title="Close chat">✕</button>
        {!isGit && <span className="category-tag">NOT ISOLATED</span>}
        {driveDetached && <span className="category-tag" style={{ color: "var(--colors-muted-soft)" }}>DRIVE DETACHED</span>}
        {agentStatus === "stopped" && <span className="category-tag" style={{ color: "var(--colors-muted-soft)" }}>AGENT STOPPED</span>}
        
        <div style={{ marginLeft: "auto", display: "flex", gap: "var(--spacing-md)", alignItems: "center" }}>
          {agentStatus === "running" && <button onClick={() => sendRaw({ type: "abort" })} className="caption-uppercase">ABORT</button>}
          {agentStatus === "stopped" && <button onClick={handleRestart} className="caption-uppercase">RESTART</button>}
        </div>
      </div>

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
          <button onClick={handleRestart} className="button-primary" style={{ padding: "var(--spacing-xxs) var(--spacing-sm)" }}>RECONNECT</button>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column" }}>
          <div style={{ maxWidth: 880, width: "100%", margin: "0 auto", padding: "var(--spacing-xl) var(--spacing-md)", display: "flex", flexDirection: "column", gap: "var(--spacing-xl)" }}>
        {messages.length === 0 && (
          <div className="display-sm" style={{ color: "var(--colors-muted)", marginTop: "var(--spacing-xl)" }}>
            AGENT IDLE. SEND PROMPT.
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={m.role === "user" ? "chat-bubble-user body-md" : m.role === "system" ? "chat-notice body-sm" : "chat-bubble-assistant body-md"}
          >
            {m.role === "system" && <small>PI CONTEXT</small>}
            {m.thinking && <ThinkingBlock>{m.thinking}</ThinkingBlock>}
            {m.text && <MarkdownMessage>{m.text}</MarkdownMessage>}
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
            <button onClick={() => sendRaw({ type: "abort" })}>ABORT</button>
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
        <textarea
          ref={inputRef}
          value={input}
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
          placeholder={driveDetached ? "DRIVE DETACHED" : "TYPE MESSAGE… SHIFT+ENTER NEWLINE. @ FILE PICKER."}
          aria-disabled={driveDetached || agentStatus === "stopped"}
          rows={1}
          className="text-input body-md"
          style={{ flex: 1, padding: "var(--spacing-sm) 0", resize: "none" }}
        />
        {agentStatus === "running" ? (
           <button onClick={() => sendRaw({ type: "abort" })} className="button-primary">ABORT</button>
        ) : (
           <button onClick={() => submitInput()} disabled={driveDetached || agentStatus === "stopped" || !input.trim()} className="button-primary">SEND</button>
        )}
      </div>
      </div>
      </div>
      {atHint && <div className="caption-uppercase" style={{ maxWidth: 880, margin: "0 auto", padding: "0 var(--spacing-md) var(--spacing-md)" }}>{atHint.toUpperCase()}</div>}
      {worktree && <DiffPanel
        worktreePath={worktree.worktree_path}
        parentRef={worktree.parent_ref}
        editingFile={editingFile}
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
      {approval && <ApprovalDialog req={approval} onRespond={handleApprovalResponse} />}
    </div>
  );
}
