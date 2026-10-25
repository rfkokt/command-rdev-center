import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import FilePicker, { type FilePickerHandle } from "./FilePicker";
import type { ChatImage } from "../lib/rpc";
import { estimatedImageTokens, type ComposerImage } from "../lib/attachments";
import type { ImageSupport } from "../lib/model-capabilities";
import type { ChatFile, SlashCommand } from "./ChatView";
import { shouldSubmitCommand } from "./chat-utils";
import CustomSelect from "./CustomSelect";

export type ChatSubmitMode = "prompt" | "follow_up" | "steer";

export type ChatComposerProps = {
  globalChat: boolean;
  driveDetached: boolean;
  agentStatus: "idle" | "running" | "stopped";
  isNewSessionLoading: boolean;
  chatReady: boolean;
  isAborting: boolean;
  researchBusy: boolean;
  researchUsageError: boolean;
  projectPath: string;
  inputPlaceholder?: string;
  input: string;
  promptHistory?: string[];
  images: ComposerImage[];
  /** Files are being dragged over the composer. */
  dropActive?: boolean;
  /** Whether the current model reads images (null: unknown). */
  imageSupport?: ImageSupport;
  files: ChatFile[];
  currentThinking: string;
  slashCommands: SlashCommand[];
  commandIndex: number;
  filePickerQuery: string | null;
  atHint: string;
  tablePreviews: { header: string[]; rows: string[][] }[];
  inputRef: RefObject<HTMLTextAreaElement | null>;
  filePickerRef: RefObject<FilePickerHandle | null>;
  setInput: Dispatch<SetStateAction<string>>;
  setImages: Dispatch<SetStateAction<ComposerImage[]>>;
  setFiles: Dispatch<SetStateAction<ChatFile[]>>;
  setPreviewImage: (image: ChatImage | null) => void;
  setFilePickerQuery: (query: string | null) => void;
  setResearchUsageError: (value: boolean) => void;
  setCommandIndex: Dispatch<SetStateAction<number>>;
  onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onAttachFiles: () => void | Promise<void>;
  onSubmit: (mode?: ChatSubmitMode) => Promise<void>;
  onChooseCommand: (command: SlashCommand) => void;
  onFilePick: (file: { name: string; path: string; relative: string }) => void;
  onRemoveTable: () => void;
  onSetThinking: (level: string) => Promise<void>;
  /** Session status (branch, pipeline, context) shown in the action row. */
  status?: ReactNode;
  /** Cursor-style Plan/Build mode. Plan mode prefixes the pi-bound message. */
  planMode: boolean;
  onPlanModeChange: (value: boolean) => void;
  /** Installed agent harnesses; switchable between turns (locked while the agent works). */
  agentOptions?: Array<{ id: string; label: string; protocol: string }>;
  agentValue?: string;
  agentLocked?: boolean;
  onAgentChange?: (id: string) => void;
};

const QUICK_PROMPTS = [
  {
    label: "Brainstorm",
    detail: "Explore ideas",
    insert: "Brainstorm ideas for: ",
  },
  { label: "Web search", detail: "/research", insert: "/research " },
  { label: "Review code", detail: "Find issues", insert: "Review this code: " },
  { label: "Use a skill", detail: "/skill:", insert: "/skill:" },
];

const THINKING_OPTIONS = [
  { value: "off", label: "No thinking", description: "Answer directly" },
  { value: "minimal", label: "Minimal", description: "Quick shallow checks" },
  { value: "low", label: "Low", description: "Light reasoning" },
  { value: "medium", label: "Medium", description: "Balanced effort" },
  { value: "high", label: "High", description: "Deep analysis and planning" },
  { value: "xhigh", label: "Extra high", description: "Maximum effort" },
];

/** "+" menu: attach files and insert a quick prompt. */
function AddMenu({
  disabled,
  onAttach,
  onInsert,
}: {
  disabled: boolean;
  onAttach: () => void;
  onInsert: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div className="kc-add" ref={rootRef}>
      <button
        type="button"
        className="kc-icon"
        aria-label="Add files or a quick prompt"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Attach files or insert a quick prompt"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M7 2v10M2 7h10" />
        </svg>
      </button>
      {open && (
        <div className="kc-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onAttach();
            }}
          >
            <span>Attach files</span>
            <small>Images, text, PDFs</small>
          </button>
          <div className="kc-menu-sep" role="separator" />
          {QUICK_PROMPTS.map((prompt) => (
            <button
              type="button"
              role="menuitem"
              key={prompt.label}
              onClick={() => {
                setOpen(false);
                onInsert(prompt.insert);
              }}
            >
              <span>{prompt.label}</span>
              <small>{prompt.detail}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ChatComposer({
  globalChat,
  driveDetached,
  agentStatus,
  isNewSessionLoading,
  chatReady,
  isAborting,
  researchBusy,
  researchUsageError,
  projectPath,
  inputPlaceholder,
  input,
  promptHistory = [],
  images,
  dropActive = false,
  imageSupport = null,
  files,
  currentThinking,
  slashCommands,
  commandIndex,
  filePickerQuery,
  atHint,
  tablePreviews,
  inputRef,
  filePickerRef,
  setInput,
  setImages,
  setFiles,
  setPreviewImage,
  setFilePickerQuery,
  setResearchUsageError,
  setCommandIndex,
  onPaste,
  onAttachFiles,
  onSubmit,
  onChooseCommand,
  onFilePick,
  onRemoveTable,
  onSetThinking,
  status,
  planMode,
  onPlanModeChange,
  agentOptions = [],
  agentValue,
  agentLocked = true,
  onAgentChange,
}: ChatComposerProps) {
  const historyRef = useRef<{
    prompts: string[];
    index: number;
    draft: string;
    recalled: string;
  } | null>(null);
  const historyCaretRef = useRef(false);
  useEffect(() => {
    if (historyRef.current && input !== historyRef.current.recalled)
      historyRef.current = null;
    if (historyCaretRef.current) {
      inputRef.current?.setSelectionRange(input.length, input.length);
      historyCaretRef.current = false;
    }
  }, [input, inputRef]);
  const inputDisabled =
    driveDetached || agentStatus === "stopped" || isNewSessionLoading;
  const sendLabel = !chatReady
    ? "Connecting…"
    : researchBusy
      ? "Starting…"
      : isNewSessionLoading
        ? "Loading…"
        : agentStatus === "running"
          ? "Queue"
          : "Send";
  return (
    <div className="chat-composer-dock">
      <div className={`chat-composer kc${dropActive ? " is-drop-target" : ""}`}>
        {dropActive && (
          <div className="kc-drop-hint" aria-hidden="true">
            Drop to attach
          </div>
        )}
        {slashCommands.length > 0 && (
          <div className="slash-menu" role="listbox">
            {slashCommands.map((command, index) => (
              <button
                key={`${command.source}-${command.name}`}
                className={index === commandIndex ? "active" : ""}
                onMouseDown={(event) => {
                  event.preventDefault();
                  if (shouldSubmitCommand(input, command)) void onSubmit();
                  else onChooseCommand(command);
                }}
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
        {!globalChat && filePickerQuery !== null && (
          <FilePicker
            projectPath={projectPath}
            query={filePickerQuery}
            pickerRef={filePickerRef}
            onPick={onFilePick}
            onClose={() => setFilePickerQuery(null)}
          />
        )}
        {tablePreviews.length > 0 && (
          <div className="table-preview">
            <div className="table-preview-head">
              <span>
                TABLE PREVIEW · {tablePreviews[0].header.length} cols ·{" "}
                {tablePreviews[0].rows.length} rows
              </span>
              <button onClick={onRemoveTable} title="Remove table">
                ✕
              </button>
            </div>
            <div className="md-table-wrapper">
              <table>
                <thead>
                  <tr>
                    {tablePreviews[0].header.map((c, i) => (
                      <th key={i}>{c || `COL ${i + 1}`}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tablePreviews[0].rows.slice(0, 30).map((r, ri) => (
                    <tr key={ri}>
                      {r.map((c, ci) => (
                        <td key={ci} title={c}>
                          {c}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {tablePreviews[0].rows.length > 30 && (
              <small className="table-preview-more">
                +{tablePreviews[0].rows.length - 30} more rows hidden — will
                still send full table
              </small>
            )}
          </div>
        )}
        {images.length > 0 && imageSupport === false && (
          <p className="kc-image-note" role="note">
            This model can't see images. They go to the agent as file paths.
          </p>
        )}
        {images.length > 0 && (
          <div className="image-previews">
            {images.map((image) => (
              <div key={image.id}>
                <button
                  onClick={() => setPreviewImage(image)}
                  title={image.name ? `Preview ${image.name}` : "Preview image"}
                >
                  <img
                    src={`data:${image.mimeType};base64,${image.data}`}
                    alt={image.name ?? "Attached image preview"}
                  />
                </button>
                {image.width && image.height && (
                  <small
                    title={`${image.width}×${image.height} inline. Claude estimate: pixels ÷ 750; actual provider usage varies. Original file is unchanged.`}
                  >
                    {imageSupport === false
                      ? "Path only"
                      : `~${estimatedImageTokens(image.width, image.height).toLocaleString("en-US")} tokens (Claude est.)`}
                  </small>
                )}
                <button
                  className="image-remove"
                  onClick={() =>
                    setImages((prev) =>
                      prev.filter((item) => item.id !== image.id),
                    )
                  }
                  title="Remove image"
                  aria-label={`Remove ${image.name ?? "image"}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="image-previews" aria-label="File attachments">
            {files.map((file) => (
              <div key={file.path} className="file-attachment">
                <span title={file.path}>📎 {file.name}</span>
                <button
                  className="image-remove"
                  onClick={() =>
                    setFiles((current) =>
                      current.filter((item) => item.path !== file.path),
                    )
                  }
                  title="Remove file"
                  aria-label={`Remove ${file.name}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {researchUsageError && (
          <p className="research-run-error" role="alert">
            Add a question after <code>/research</code>, for example:{" "}
            <code>/research compare Tauri and Electron</code>.
          </p>
        )}
        <textarea
          ref={inputRef}
          value={input}
          onPaste={onPaste}
          onChange={(e) => {
            setInput(e.target.value);
            setResearchUsageError(false);
            setCommandIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.altKey && e.key === "Enter") {
              e.preventDefault();
              onSubmit("steer");
              return;
            }
            if (e.ctrlKey && e.key.toLowerCase() === "j") {
              e.preventDefault();
              setInput((current) => `${current}\n`);
              return;
            }
            if (
              slashCommands.length > 0 &&
              (e.key === "ArrowDown" || e.key === "ArrowUp")
            ) {
              e.preventDefault();
              setCommandIndex(
                (current) =>
                  (current +
                    (e.key === "ArrowDown" ? 1 : -1) +
                    slashCommands.length) %
                  slashCommands.length,
              );
              return;
            }
            if (
              slashCommands.length > 0 &&
              (e.key === "Tab" || e.key === "Enter")
            ) {
              e.preventDefault();
              const command = slashCommands[commandIndex];
              if (e.key === "Enter" && shouldSubmitCommand(input, command))
                void onSubmit();
              else onChooseCommand(command);
              return;
            }
            if (
              filePickerQuery !== null &&
              filePickerRef.current?.onKeyDown(e.key)
            ) {
              e.preventDefault();
              return;
            }
            if (
              filePickerQuery === null &&
              !e.altKey &&
              !e.ctrlKey &&
              !e.metaKey &&
              !e.shiftKey &&
              (e.key === "ArrowUp" || e.key === "ArrowDown") &&
              e.currentTarget.selectionStart === e.currentTarget.selectionEnd
            ) {
              let history = historyRef.current;
              const cursor = e.currentTarget.selectionStart;
              const atFirstLine = !input.slice(0, cursor).includes("\n");
              const atLastLine = !input.slice(cursor).includes("\n");
              if (e.key === "ArrowUp" && atFirstLine) {
                if (!history) {
                  const prompts = promptHistory
                    .filter((text) => text.trim())
                    .slice()
                    .reverse();
                  if (!prompts.length) return;
                  history = {
                    prompts,
                    index: -1,
                    draft: input,
                    recalled: input,
                  };
                  historyRef.current = history;
                }
                history.index = Math.min(
                  history.index + 1,
                  history.prompts.length - 1,
                );
              } else if (e.key === "ArrowDown" && history && atLastLine) {
                history.index--;
              } else return;
              e.preventDefault();
              const next =
                history.index < 0
                  ? history.draft
                  : history.prompts[history.index];
              history.recalled = next;
              if (history.index < 0) historyRef.current = null;
              historyCaretRef.current = true;
              setInput(next);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={
            driveDetached
              ? "Reconnect the drive to continue"
              : agentStatus === "stopped"
                ? "Restart the session to continue"
                : agentStatus === "running"
                  ? "Follow-up: Enter queues it · Option/Alt + Enter steers now"
                  : inputPlaceholder || "Message the agent…"
          }
          disabled={
            driveDetached || agentStatus === "stopped" || isNewSessionLoading
          }
          aria-describedby={
            !globalChat &&
            !atHint &&
            !driveDetached &&
            agentStatus !== "stopped"
              ? "chat-composer-help"
              : undefined
          }
          rows={1}
          className="kc-input"
        />
        <div className="kc-bar">
          <div className="kc-left">
            <AddMenu
              disabled={inputDisabled}
              onAttach={() => void onAttachFiles()}
              onInsert={(text) => {
                setInput((current) => (current ? `${current} ` : "") + text);
                inputRef.current?.focus();
              }}
            />
            {onAgentChange && agentOptions.length > 1 && (
              <CustomSelect
                className="kc-select"
                value={agentValue ?? ""}
                onChange={onAgentChange}
                // Locked while the current agent is working.
                disabled={inputDisabled || agentLocked}
                ariaLabel="Agent"
                placement="top"
                options={agentOptions.map((option) => ({
                  value: option.id,
                  label: option.label,
                  description:
                    option.protocol === "native"
                      ? "Every Kern feature"
                      : "Connected over ACP",
                }))}
              />
            )}
            <CustomSelect
              className="kc-select thinking-effort"
              value={currentThinking || "medium"}
              onChange={(level) => void onSetThinking(level)}
              disabled={inputDisabled}
              ariaLabel="Thinking effort"
              placement="top"
              options={THINKING_OPTIONS}
            />
            <div
              className="kc-mode"
              role="group"
              aria-label="Plan or build mode"
              title={
                planMode
                  ? "Plan: the agent writes a plan, no edits"
                  : "Build: the agent implements directly"
              }
            >
              {(
                [
                  { value: false, label: "Build" },
                  { value: true, label: "Plan" },
                ] as const
              ).map((option) => (
                <button
                  type="button"
                  key={option.label}
                  onClick={() => onPlanModeChange(option.value)}
                  disabled={inputDisabled}
                  aria-pressed={planMode === option.value}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="kc-right">
            {status && <div className="kc-status">{status}</div>}
            <button
              type="button"
              onClick={() => onSubmit()}
              disabled={
                !chatReady ||
                inputDisabled ||
                isAborting ||
                researchBusy ||
                (!input.trim() && images.length === 0 && files.length === 0)
              }
              className="kc-send"
              aria-label={sendLabel}
              title={sendLabel}
            >
              {sendLabel === "Send" || sendLabel === "Queue" ? (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M7 12V2M2.5 6.5 7 2l4.5 4.5" />
                </svg>
              ) : (
                <span className="kc-send-busy" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
