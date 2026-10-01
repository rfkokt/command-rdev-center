import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { splitPatch } from "./chat-diff-utils";
import {
  buildHunkPatch,
  flattenHunks,
  parseDiffSections,
  type DiffHunk,
} from "./diff-hunks";
import type { WorktreeDiff } from "./ChatView";

import CheckpointTimeline from "./CheckpointTimeline";

export type ExpandedDiffPanelProps = {
  diffKey: string;
  worktreeDiff: WorktreeDiff;
  position: { x: number; y: number };
  dialogRef: Ref<HTMLDivElement>;
  onPositionChange: (position: { x: number; y: number }) => void;
  onClose: () => void;
  /** Repo root for single-worktree mode; null when unknown. */
  worktreePath: string | null;
  /** Workspace mode: repository name -> repo root path. */
  repositoryRoots?: Record<string, string>;
  onToast: (message: string) => void;
  /** Called after a checkpoint restore so the host can refresh its diff. */
  onDiffInvalidated?: () => void;
};

const buttonStyle = (
  tone: "accept" | "reject" | "undo",
  disabled: boolean,
): CSSProperties => ({
  padding: "4px 10px",
  fontSize: 10,
  letterSpacing: "0.08em",
  borderRadius: 4,
  cursor: disabled ? "default" : "pointer",
  background: "transparent",
  opacity: disabled ? 0.45 : 1,
  border:
    tone === "reject"
      ? "1px solid #ff7069"
      : tone === "undo"
        ? "1px solid var(--accent)"
        : "1px solid #7bc98a",
  color:
    tone === "reject"
      ? "#ff9b96"
      : tone === "undo"
        ? "var(--accent)"
        : "#9fe0ab",
});

export default function ExpandedDiffPanel({
  diffKey,
  worktreeDiff,
  position,
  dialogRef,
  onPositionChange,
  onClose,
  worktreePath,
  repositoryRoots,
  onToast,
  onDiffInvalidated,
}: ExpandedDiffPanelProps) {
  const dragRef = useRef<{
    startX: number;
    startY: number;
    initX: number;
    initY: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  } | null>(null);

  const file = worktreeDiff.files.find(
    (f) =>
      `${f.repository ? `${f.repository}:` : ""}${f.path}` === diffKey ||
      f.path === diffKey,
  );
  const sections = useMemo(
    () => parseDiffSections(file?.patch ?? ""),
    [file?.patch],
  );
  const hunks = useMemo(() => flattenHunks(sections), [sections]);

  // Hunk ids explicitly accepted / rejected in this review session.
  // Accept is the default state: the change is already in the worktree.
  const [accepted, setAccepted] = useState<string[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const [busy, setBusy] = useState<string[]>([]);
  // Checkpoint timeline section (top, collapsible).
  const [checkpointsOpen, setCheckpointsOpen] = useState(false);
  // A fresh diff means a fresh review.
  useEffect(() => {
    setAccepted([]);
    setRejected([]);
    setBusy([]);
  }, [diffKey, file?.patch]);

  const repoRoot =
    (file?.repository ? repositoryRoots?.[file.repository] : undefined) ??
    worktreePath;

  const runHunkCommand = async (
    id: string,
    command: "reject_hunks" | "apply_hunks",
    entry: { fileHeader: string[]; hunk: DiffHunk },
    onSuccess: () => void,
    verb: string,
  ) => {
    if (!repoRoot) {
      onToast("Hunk review: no worktree path for this diff");
      return;
    }
    setBusy((prev) => [...prev, id]);
    try {
      await invoke(command, {
        worktreePath: repoRoot,
        hunksPatch: buildHunkPatch(entry.fileHeader, entry.hunk),
      });
      onSuccess();
    } catch (error) {
      onToast(`${verb} failed: ${String(error)}`);
    } finally {
      setBusy((prev) => prev.filter((busyId) => busyId !== id));
    }
  };

  const handleAccept = (id: string) =>
    setAccepted((prev) => (prev.includes(id) ? prev : [...prev, id]));

  const handleReject = (entry: { fileHeader: string[]; hunk: DiffHunk }) =>
    runHunkCommand(
      entry.hunk.id,
      "reject_hunks",
      entry,
      () => {
        setRejected((prev) => [...prev, entry.hunk.id]);
        setAccepted((prev) =>
          prev.filter((acceptedId) => acceptedId !== entry.hunk.id),
        );
      },
      "Reject hunk",
    );

  const handleUndo = (entry: { fileHeader: string[]; hunk: DiffHunk }) =>
    runHunkCommand(
      entry.hunk.id,
      "apply_hunks",
      entry,
      () =>
        setRejected((prev) =>
          prev.filter((rejectedId) => rejectedId !== entry.hunk.id),
        ),
      "Undo reject",
    );

  const rejectedSet = new Set(rejected);
  const pending = hunks.filter((entry) => !rejectedSet.has(entry.hunk.id));
  const rejectedEntries = hunks.filter((entry) =>
    rejectedSet.has(entry.hunk.id),
  );
  const hunkPatch = (entry: { hunk: { header: string; lines: string[] } }) =>
    `${entry.hunk.header}\n${entry.hunk.lines.join("\n")}`;

  return (
    <div
      onPointerDown={onClose}
      style={{
        position: "fixed",
        top: 62,
        left: 0,
        bottom: 0,
        right: 432,
        zIndex: 80,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "auto",
        padding: 20,
      }}
    >
      <div
        onPointerDown={(e) => e.stopPropagation()}
        ref={dialogRef}
        className="diff-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Hunk review for ${diffKey}`}
        tabIndex={-1}
        style={{
          maxWidth: "calc(100vw - 480px)",
          maxHeight: "85vh",
          pointerEvents: "auto",
          boxShadow: "0 24px 60px #000c",
          border: "1px solid var(--accent)",
          transform: `translate(${position.x}px, ${position.y}px)`,
          transition: dragRef.current
            ? "none"
            : "transform 160ms var(--ease-out)",
          resize: "both",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "12px 20px",
            borderBottom: "1px solid var(--colors-hairline)",
            background: "#1a1b18",
            cursor: "grab",
            userSelect: "none",
            flexShrink: 0,
          }}
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest("button")) return;
            e.preventDefault();
            const rect = (
              e.currentTarget as HTMLElement
            ).parentElement!.getBoundingClientRect();
            dragRef.current = {
              startX: e.clientX,
              startY: e.clientY,
              initX: position.x,
              initY: position.y,
              minX: -rect.left + 24,
              maxX: window.innerWidth - rect.right - 24,
              minY: -rect.top + 62,
              maxY: window.innerHeight - rect.bottom - 24,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
            e.currentTarget.style.cursor = "grabbing";
          }}
          onPointerMove={(e) => {
            if (!dragRef.current) return;
            const { startX, startY, initX, initY, minX, maxX, minY, maxY } =
              dragRef.current;
            onPositionChange({
              x: Math.max(minX, Math.min(maxX, initX + e.clientX - startX)),
              y: Math.max(minY, Math.min(maxY, initY + e.clientY - startY)),
            });
          }}
          onPointerUp={(e) => {
            dragRef.current = null;
            e.currentTarget.releasePointerCapture(e.pointerId);
            e.currentTarget.style.cursor = "grab";
          }}
          onPointerCancel={(e) => {
            dragRef.current = null;
            e.currentTarget.releasePointerCapture(e.pointerId);
            e.currentTarget.style.cursor = "grab";
          }}
        >
          <div style={{ display: "grid", gap: 4 }}>
            <small
              style={{
                color: "var(--accent)",
                fontSize: 10,
                letterSpacing: "0.1em",
              }}
            >
              HUNK REVIEW — {pending.length} ACCEPTED · {rejected.length}{" "}
              REJECTED
            </small>
            <strong style={{ fontSize: 14 }}>{diffKey}</strong>
          </div>
          <button
            onClick={onClose}
            title="Close preview"
            style={{
              padding: "6px 12px",
              border: "1px solid #ff7069",
              color: "#ff9b96",
              fontSize: 10,
              letterSpacing: "0.1em",
              borderRadius: 4,
              cursor: "pointer",
              background: "transparent",
            }}
          >
            ✕ CLOSE
          </button>
        </div>

        <div style={{ flex: 1, overflow: "auto", background: "#0e0f0c" }}>
          <div
            style={{
              borderBottom: "1px solid var(--colors-hairline)",
              padding: "8px 20px",
              flexShrink: 0,
            }}
          >
            <button
              onClick={() => setCheckpointsOpen((open) => !open)}
              className="composer-chip"
              style={{ minHeight: 26, fontSize: 11 }}
              aria-expanded={checkpointsOpen}
            >
              {checkpointsOpen ? "▾" : "▸"} CHECKPOINTS
            </button>
            {checkpointsOpen && (
              <div style={{ marginTop: 8 }}>
                <CheckpointTimeline
                  worktreePath={repoRoot ?? null}
                  onToast={onToast}
                  onRestored={onDiffInvalidated}
                />
              </div>
            )}
          </div>
          {!file || !file.patch ? (
            <p className="code-empty" style={{ padding: 20 }}>
              Binary or untracked — no textual diff.
            </p>
          ) : (
            <div
              className="split-diff vscode-split"
              style={{ maxHeight: "none" }}
            >
              <header>
                <span>BEFORE</span>
                <span>AFTER</span>
              </header>
              {pending.map((entry) => {
                const id = entry.hunk.id;
                const isBusy = busy.includes(id);
                const isAccepted = accepted.includes(id);
                return (
                  <div key={id} style={{ marginBottom: 8 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        padding: "6px 12px",
                        background: isAccepted ? "#14201a" : "#141310",
                        borderTop: "1px solid var(--colors-hairline)",
                        borderBottom: "1px solid var(--colors-hairline)",
                      }}
                    >
                      <code
                        style={{
                          fontSize: 11,
                          color: "var(--accent)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={entry.hunk.header}
                      >
                        {entry.hunk.header}
                      </code>
                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          flexShrink: 0,
                          alignItems: "center",
                        }}
                      >
                        {isAccepted && (
                          <span style={{ fontSize: 10, color: "#9fe0ab" }}>
                            ✓ accepted
                          </span>
                        )}
                        <button
                          style={buttonStyle("accept", isBusy || isAccepted)}
                          disabled={isBusy || isAccepted}
                          title="Keep this change (already in the worktree)"
                          onClick={() => handleAccept(id)}
                        >
                          ✓ ACCEPT
                        </button>
                        <button
                          style={buttonStyle("reject", isBusy)}
                          disabled={isBusy}
                          title="Discard this hunk from the worktree"
                          onClick={() => handleReject(entry)}
                        >
                          {isBusy ? "…" : "✕ REJECT"}
                        </button>
                      </div>
                    </div>
                    {splitPatch(hunkPatch(entry))}
                  </div>
                );
              })}
              {rejectedEntries.length > 0 && (
                <div
                  style={{
                    margin: "12px 0",
                    borderTop: "2px solid #ff7069",
                  }}
                >
                  <div
                    style={{
                      padding: "8px 12px",
                      fontSize: 10,
                      letterSpacing: "0.1em",
                      color: "#ff9b96",
                      background: "#1d1210",
                    }}
                  >
                    REJECTED — DISCARDED FROM WORKTREE ({rejectedEntries.length}
                    )
                  </div>
                  {rejectedEntries.map((entry) => {
                    const id = entry.hunk.id;
                    const isBusy = busy.includes(id);
                    return (
                      <div
                        key={id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 12,
                          padding: "6px 12px",
                          borderBottom: "1px solid var(--colors-hairline)",
                          opacity: 0.75,
                        }}
                      >
                        <code
                          style={{
                            fontSize: 11,
                            color: "#ff9b96",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={entry.hunk.header}
                        >
                          {entry.hunk.header}
                        </code>
                        <button
                          style={buttonStyle("undo", isBusy)}
                          disabled={isBusy}
                          title="Restore this hunk into the worktree"
                          onClick={() => handleUndo(entry)}
                        >
                          {isBusy ? "…" : "↩ UNDO"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
