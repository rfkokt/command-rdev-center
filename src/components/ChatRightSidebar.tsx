import { lazy, Suspense, useState } from "react";
import {
  BranchIcon,
  CloseIcon,
  CrewIcon,
  FilesIcon,
  GaugeIcon,
} from "./ui-icons";
import ProjectFilesSidebar from "./ProjectFilesSidebar";
import SourceControlPanel from "./SourceControlPanel";
import QuotaPanel from "./QuotaPanel";
import { confirm } from "./ConfirmDialog";
import type { ChatRepository, WorktreeDiff, WorktreeInfo } from "./ChatView";
import type { ToolCall } from "../lib/rpc";

// Three.js and the voxel models only load once the office is first opened.
const OfficePanel = lazy(() => import("./OfficePanel"));

export type RightActivity = "office" | "explorer" | "scm" | "usage";

export type ChatRightSidebarProps = {
  open: boolean;
  activity: RightActivity;
  panelWidth: number;
  worktree: WorktreeInfo | null;
  isWorkspace: boolean;
  worktreeDiff: WorktreeDiff | null;
  cwd: string;
  projectName: string;
  repositoryStatuses: ChatRepository[];
  onOpenChange: (open: boolean) => void;
  onActivityChange: (activity: RightActivity) => void;
  onPanelWidthChange: (width: number) => void;
  onOpenDiff: (key: string) => void;
  onWorktreeDiffChange: (diff: WorktreeDiff) => void;
  onToast: (message: string) => void;
  office: { tools: readonly ToolCall[]; running: boolean; writing: boolean };
};

const TITLES: Record<RightActivity, string> = {
  office: "Office",
  explorer: "Files",
  scm: "Changes",
  usage: "Usage",
};

export default function ChatRightSidebar({
  open,
  activity,
  panelWidth,
  worktree,
  isWorkspace,
  worktreeDiff,
  cwd,
  projectName,
  repositoryStatuses,
  onOpenChange,
  onActivityChange,
  onPanelWidthChange,
  onOpenDiff,
  onWorktreeDiffChange,
  onToast,
  office,
}: ChatRightSidebarProps) {
  const showOffice = open && activity === "office";
  const [officeMounted, setOfficeMounted] = useState(showOffice);
  if (showOffice && !officeMounted) setOfficeMounted(true);
  // The office reads better wider than the file/diff panels.
  const maxWidth = activity === "office" ? 720 : 480;
  const changeCount = worktreeDiff?.files.length ?? 0;
  const canShowChanges = Boolean(worktree || isWorkspace);
  const toggle = (next: RightActivity) => {
    if (open && activity === next) onOpenChange(false);
    else {
      onOpenChange(true);
      onActivityChange(next);
    }
  };
  const branch = isWorkspace
    ? `${repositoryStatuses.length} repositories`
    : (worktree?.branch ?? "");

  return (
    <div className={`krs${open ? " open" : ""}`}>
      <div
        className="krs-panel"
        hidden={!open}
        style={{ width: open ? panelWidth : 0 }}
      >
        <div
          className="krs-resize"
          role="separator"
          aria-label="Resize code sidebar"
          aria-orientation="vertical"
          aria-valuemin={240}
          aria-valuemax={maxWidth}
          aria-valuenow={panelWidth}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft")
              onPanelWidthChange(Math.min(maxWidth, panelWidth + 10));
            if (e.key === "ArrowRight")
              onPanelWidthChange(Math.max(240, panelWidth - 10));
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            const startX = e.clientX;
            const startWidth = panelWidth;
            const target = e.currentTarget;
            target.onpointermove = (ev) =>
              onPanelWidthChange(
                Math.max(
                  240,
                  Math.min(maxWidth, startWidth + (startX - ev.clientX)),
                ),
              );
            target.onpointerup = () => {
              target.onpointermove = null;
              target.onpointerup = null;
              target.releasePointerCapture(e.pointerId);
            };
          }}
        />
        <header className="krs-head">
          <div className="krs-head-text">
            <strong>{TITLES[activity]}</strong>
            <small title={activity === "scm" ? branch : projectName}>
              {activity === "office"
                ? office.running
                  ? "Agents at work"
                  : "Your agent crew"
                : activity === "usage"
                  ? "Subscription quota"
                  : activity === "explorer"
                    ? projectName
                    : branch || projectName}
            </small>
          </div>
          <button
            type="button"
            className="krs-icon"
            onClick={() => onOpenChange(false)}
            title="Hide panel"
            aria-label="Hide panel"
          >
            <CloseIcon size={14} />
          </button>
        </header>
        <div className="krs-body">
          {officeMounted && (
            <div hidden={!showOffice} className="krs-office">
              <Suspense fallback={null}>
                <OfficePanel
                  tools={office.tools}
                  running={office.running}
                  writing={office.writing}
                  visible={showOffice}
                />
              </Suspense>
            </div>
          )}
          {activity === "office" ? null : activity === "usage" ? (
            <QuotaPanel onToast={onToast} />
          ) : activity === "explorer" ? (
            <ProjectFilesSidebar
              projectPath={cwd}
              projectName={projectName}
              refreshKey={changeCount}
              onOpenAt={onOpenDiff}
            />
          ) : (
            <SourceControlPanel
              cwd={isWorkspace ? cwd : (worktree?.worktree_path ?? cwd)}
              repositories={isWorkspace ? repositoryStatuses : []}
              onDiff={(repository, path) =>
                onOpenDiff(isWorkspace ? `${repository}:${path}` : path)
              }
              onCommitDiff={(repository, file) => {
                const key = isWorkspace
                  ? `${repository}:${file.path}`
                  : file.path;
                onWorktreeDiffChange({
                  merge_base: "",
                  files: [{ ...file, repository }],
                });
                onOpenDiff(key);
              }}
              confirm={confirm}
              toast={onToast}
            />
          )}
        </div>
      </div>
      <nav className="krs-rail" aria-label="Code panels">
        <button
          type="button"
          className={`${open && activity === "office" ? "active" : ""}${office.running ? " is-live" : ""}`}
          onClick={() => toggle("office")}
          title={open && activity === "office" ? "Hide office" : "Office"}
          aria-label={`Office${office.running ? " (agents working)" : ""}`}
          aria-expanded={open && activity === "office"}
        >
          <CrewIcon size={18} />
        </button>
        <button
          type="button"
          className={open && activity === "explorer" ? "active" : ""}
          onClick={() => toggle("explorer")}
          title={open && activity === "explorer" ? "Hide files" : "Files"}
          aria-label="Explorer"
          aria-expanded={open && activity === "explorer"}
        >
          <FilesIcon size={18} />
        </button>
        {canShowChanges && (
          <button
            type="button"
            className={open && activity === "scm" ? "active" : ""}
            onClick={() => toggle("scm")}
            title={open && activity === "scm" ? "Hide changes" : "Changes"}
            aria-label={`Changes${changeCount ? ` (${changeCount})` : ""}`}
            aria-expanded={open && activity === "scm"}
          >
            <BranchIcon size={18} />
            {changeCount > 0 && (
              <span className="krs-badge">
                {changeCount > 99 ? "99+" : changeCount}
              </span>
            )}
          </button>
        )}
        <button
          type="button"
          className={open && activity === "usage" ? "active" : ""}
          onClick={() => toggle("usage")}
          title={open && activity === "usage" ? "Hide usage" : "Usage"}
          aria-label="Usage"
          aria-expanded={open && activity === "usage"}
        >
          <GaugeIcon size={18} />
        </button>
      </nav>
    </div>
  );
}
