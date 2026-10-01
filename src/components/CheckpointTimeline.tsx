import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "./ConfirmDialog";

export type Checkpoint = {
  sha: string;
  timestamp: number;
  message: string;
};

export type CheckpointResult = {
  status: "committed" | "clean";
  sha: string | null;
};

export type CheckpointTimelineProps = {
  /** Repo root for the checkpoint history; null hides the section. */
  worktreePath: string | null;
  onToast: (message: string) => void;
  /** Called after a successful restore so the host can refresh its diff. */
  onRestored?: () => void;
};

/** Minimal checkpoint timeline: time, message, Restore button. */
export default function CheckpointTimeline({
  worktreePath,
  onToast,
  onRestored,
}: CheckpointTimelineProps) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!worktreePath) return;
    setLoading(true);
    try {
      setCheckpoints(
        await invoke<Checkpoint[]>("list_checkpoints", { worktreePath }),
      );
    } catch (error) {
      onToast(`Checkpoints: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [worktreePath, onToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleRestore = async (checkpoint: Checkpoint) => {
    const ok = await confirm({
      title: "Restore checkpoint",
      message: `Restore tracked files to "${checkpoint.message || checkpoint.sha.slice(0, 7)}"? Uncommitted changes will be overwritten. Untracked files are left alone.`,
      confirmLabel: "Restore",
      danger: true,
    });
    if (!ok || !worktreePath) return;
    setRestoring(checkpoint.sha);
    try {
      await invoke("restore_checkpoint", {
        worktreePath,
        sha: checkpoint.sha,
      });
      onToast(`Restored checkpoint ${checkpoint.sha.slice(0, 7)}`);
      onRestored?.();
    } catch (error) {
      onToast(`Restore failed: ${String(error)}`);
    } finally {
      setRestoring(null);
    }
  };

  if (!worktreePath) return null;

  return (
    <div style={{ display: "grid", gap: 6 }}>
      {loading && checkpoints.length === 0 ? (
        <small style={{ color: "var(--text-secondary)" }}>
          Loading checkpoints…
        </small>
      ) : checkpoints.length === 0 ? (
        <small style={{ color: "var(--text-secondary)" }}>
          No checkpoints yet — one is saved automatically before each of your
          messages.
        </small>
      ) : (
        checkpoints.map((checkpoint) => (
          <div
            key={checkpoint.sha}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 8px",
              border: "1px solid var(--colors-hairline)",
              borderRadius: 6,
              background: "var(--surface-solid)",
            }}
          >
            <span
              style={{
                fontSize: 11,
                color: "var(--text-secondary)",
                whiteSpace: "nowrap",
              }}
              title={checkpoint.sha}
            >
              {checkpoint.timestamp > 0
                ? new Date(checkpoint.timestamp * 1000).toLocaleString()
                : checkpoint.sha.slice(0, 7)}
            </span>
            <span
              style={{
                flex: 1,
                fontSize: 12,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={checkpoint.message || checkpoint.sha}
            >
              {checkpoint.message || "(no message)"}
            </span>
            <button
              onClick={() => void handleRestore(checkpoint)}
              disabled={restoring !== null}
              className="composer-chip"
              style={{ minHeight: 24, fontSize: 11 }}
              title={`Restore tracked files to ${checkpoint.sha.slice(0, 7)}`}
            >
              {restoring === checkpoint.sha ? "RESTORING…" : "RESTORE"}
            </button>
          </div>
        ))
      )}
    </div>
  );
}
