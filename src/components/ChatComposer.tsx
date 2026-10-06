import type { Dispatch, RefObject, SetStateAction } from "react";
import FilePicker, { type FilePickerHandle } from "./FilePicker";
import type { ChatImage } from "../lib/rpc";
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
  pendingMessageCount: number;
  projectPath: string;
  inputPlaceholder?: string;
  input: string;
  images: ChatImage[];
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
  setImages: Dispatch<SetStateAction<ChatImage[]>>;
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
  /** Cursor-style Plan/Build mode. Plan mode prefixes the pi-bound message. */
  planMode: boolean;
  onPlanModeChange: (value: boolean) => void;
};

export default function ChatComposer({
  globalChat,
  driveDetached,
  agentStatus,
  isNewSessionLoading,
  chatReady,
  isAborting,
  researchBusy,
  researchUsageError,
  pendingMessageCount,
  projectPath,
  inputPlaceholder,
  input,
  images,
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
  planMode,
  onPlanModeChange,
}: ChatComposerProps) {
  return (
    <div className="chat-composer-dock">
      <div
        className="chat-composer"
        style={{
          maxWidth: 880,
          margin: "0 auto",
          padding: "var(--spacing-md)",
          position: "relative",
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--spacing-md)",
          alignItems: "flex-end",
        }}
      >
        <div
          className="composer-chips"
          role="toolbar"
          aria-label="Quick prompts"
        >
          {[
            {
              label: "\uD83D\uDCA1 Brainstorm",
              insert: "Brainstorm ideas for: ",
            },
            { label: "\uD83C\uDF10 Web search", insert: "/research " },
            { label: "</> Code", insert: "Review this code: " },
            { label: "\uFF0B Skill", insert: "/skill:" },
          ].map((chip) => (
            <button
              key={chip.label}
              className="composer-chip"
              onClick={() => {
                setInput(
                  (current) => (current ? `${current} ` : "") + chip.insert,
                );
                inputRef.current?.focus();
              }}
              disabled={
                driveDetached ||
                agentStatus === "stopped" ||
                isNewSessionLoading
              }
            >
              {chip.label}
            </button>
          ))}
          <CustomSelect
            className="thinking-effort"
            value={currentThinking || "medium"}
            onChange={(level) => void onSetThinking(level)}
            disabled={
              driveDetached ||
              agentStatus === "stopped" ||
              isNewSessionLoading
            }
            ariaLabel="Thinking effort"
            placement="top"
            options={[
              {
                value: "off",
                label: "No thinking",
                description: "Direct response without reasoning",
              },
              {
                value: "minimal",
                label: "Minimal",
                description: "Quick shallow checks",
              },
              {
                value: "low",
                label: "Low",
                description: "Light reasoning",
              },
              {
                value: "medium",
                label: "Medium",
                description: "Balanced reasoning effort",
              },
              {
                value: "high",
                label: "High",
                description: "Deep analysis and planning",
              },
              {
                value: "xhigh",
                label: "Extra high",
                description: "Maximum reasoning effort",
              },
            ]}
          />
        </div>
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
        {images.length > 0 && (
          <div className="image-previews">
            {images.map((image, index) => (
              <div key={index}>
                <button
                  onClick={() => setPreviewImage(image)}
                  title="Preview image"
                >
                  <img
                    src={`data:${image.mimeType};base64,${image.data}`}
                    alt="Pasted attachment preview"
                  />
                </button>
                <button
                  className="image-remove"
                  onClick={() =>
                    setImages((prev) => prev.filter((_, i) => i !== index))
                  }
                  title="Remove image"
                  aria-label="Remove image"
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
        {agentStatus === "running" && (
          <div
            className={`queue-status pixel-queue-status${pendingMessageCount ? " has-queue" : ""}`}
            role="status"
          >
            <div className="pixel-queue-label">
              <span className="pixel-blink-dot" />
              <strong>
                {pendingMessageCount
                  ? `${pendingMessageCount} MESSAGE${pendingMessageCount === 1 ? "" : "S"} QUEUED`
                  : "AI AGENT OFFICE AT WORK"}
              </strong>
            </div>
            <span>
              Enter queues next turn · Option/Alt + Enter steers current turn
            </span>
          </div>
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
                  ? "Write a follow-up…"
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
          className="text-input body-md"
          style={{
            flex: 1,
            maxHeight: 180,
            overflowY: "auto",
            padding: "var(--spacing-sm) 0",
            resize: "none",
          }}
        />
        <button
          onClick={() => void onAttachFiles()}
          disabled={
            driveDetached || agentStatus === "stopped" || isNewSessionLoading
          }
          className="small-icon-button"
          title="Attach files"
          aria-label="Attach files"
        >
          📎
        </button>
        <div
          role="group"
          aria-label="Plan or build mode"
          title={
            planMode
              ? "Plan mode: the agent writes a plan, no code or edits"
              : "Build mode: the agent implements directly"
          }
          style={{ display: "flex", gap: 4 }}
        >
          {(
            [
              { value: false, label: "BUILD" },
              { value: true, label: "PLAN" },
            ] as const
          ).map((option) => {
            const active = planMode === option.value;
            return (
              <button
                key={option.label}
                onClick={() => onPlanModeChange(option.value)}
                disabled={
                  driveDetached ||
                  agentStatus === "stopped" ||
                  isNewSessionLoading
                }
                className="composer-chip"
                aria-pressed={active}
                style={{
                  minHeight: 30,
                  fontSize: 11,
                  letterSpacing: "0.08em",
                  borderColor: active ? "var(--accent)" : undefined,
                  color: active ? "var(--accent)" : undefined,
                  background: active ? "var(--surface-selected)" : undefined,
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <button
          onClick={() => onSubmit()}
          disabled={
            !chatReady ||
            driveDetached ||
            agentStatus === "stopped" ||
            isNewSessionLoading ||
            isAborting ||
            researchBusy ||
            (!input.trim() && images.length === 0 && files.length === 0)
          }
          className="button-primary chat-action"
        >
          {!chatReady
            ? "CONNECTING…"
            : researchBusy
              ? "STARTING…"
              : isNewSessionLoading
                ? "LOADING…"
                : agentStatus === "running"
                  ? "QUEUE"
                  : "SEND"}
        </button>
      </div>
    </div>
  );
}
