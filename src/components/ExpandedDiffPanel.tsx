import { useRef, type Ref } from "react";
import { splitPatch } from "./chat-diff-utils";
import type { WorktreeDiff } from "./ChatView";

export type ExpandedDiffPanelProps = {
  diffKey: string;
  worktreeDiff: WorktreeDiff;
  position: { x: number; y: number };
  dialogRef: Ref<HTMLDivElement>;
  onPositionChange: (position: { x: number; y: number }) => void;
  onClose: () => void;
};

export default function ExpandedDiffPanel({
  diffKey,
  worktreeDiff,
  position,
  dialogRef,
  onPositionChange,
  onClose,
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
        aria-label={`Diff preview for ${diffKey}`}
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
              DIFF PREVIEW (READONLY)
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
          {(() => {
            const file = worktreeDiff.files.find(
              (f) =>
                `${f.repository ? `${f.repository}:` : ""}${f.path}` ===
                  diffKey || f.path === diffKey,
            );
            if (!file || !file.patch)
              return (
                <p className="code-empty" style={{ padding: 20 }}>
                  Binary or untracked — no textual diff.
                </p>
              );
            return (
              <div
                className="split-diff vscode-split"
                style={{ maxHeight: "none" }}
              >
                <header>
                  <span>BEFORE</span>
                  <span>AFTER</span>
                </header>
                {splitPatch(file.patch)}
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
