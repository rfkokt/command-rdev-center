import { ChangesIcon, ExplorerIcon } from "./Icons";
import ProjectFilesSidebar from "./ProjectFilesSidebar";
import SourceControlPanel from "./SourceControlPanel";
import { confirm } from "./ConfirmDialog";
import type { ChatRepository, WorktreeDiff, WorktreeInfo } from "./ChatView";

export type ChatRightSidebarProps = {
  open: boolean;
  activity: "explorer" | "scm";
  panelWidth: number;
  worktree: WorktreeInfo | null;
  isWorkspace: boolean;
  worktreeDiff: WorktreeDiff | null;
  cwd: string;
  projectName: string;
  repositoryStatuses: ChatRepository[];
  onOpenChange: (open: boolean) => void;
  onActivityChange: (activity: "explorer" | "scm") => void;
  onPanelWidthChange: (width: number) => void;
  onOpenDiff: (key: string) => void;
  onWorktreeDiffChange: (diff: WorktreeDiff) => void;
  onToast: (message: string) => void;
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
}: ChatRightSidebarProps) {
  return (
    <div className={`code-sidebar-rail${open ? " open" : ""}`}>
      <div className="activity-rail vscode-rail">
        <button
          className={open && activity === "explorer" ? "active" : ""}
          onClick={() => {
            if (open && activity === "explorer") onOpenChange(false);
            else {
              onOpenChange(true);
              onActivityChange("explorer");
            }
          }}
          title={
            open && activity === "explorer"
              ? "Hide Explorer"
              : "Explorer · Project files"
          }
          aria-label="Explorer"
          aria-expanded={open && activity === "explorer"}
        >
          <ExplorerIcon />
        </button>
        {(worktree || isWorkspace) && (
          <button
            className={open && activity === "scm" ? "active" : ""}
            onClick={() => {
              if (open && activity === "scm") onOpenChange(false);
              else {
                onOpenChange(true);
                onActivityChange("scm");
              }
            }}
            title={
              open && activity === "scm"
                ? "Hide Changes"
                : "Source Control · Changes"
            }
            aria-label={`Changes${worktreeDiff?.files.length ? ` (${worktreeDiff.files.length})` : ""}`}
            aria-expanded={open && activity === "scm"}
          >
            <ChangesIcon />
            {Boolean(worktreeDiff?.files.length) && (
              <span className="activity-badge">
                {worktreeDiff?.files.length}
              </span>
            )}
          </button>
        )}
      </div>
      <div
        className="code-sidebar-panel"
        hidden={!open}
        style={{
          width: open ? panelWidth : 0,
          position: "relative",
        }}
      >
        <div
          className="code-sidebar-resize-handle"
          role="separator"
          aria-label="Resize code sidebar"
          aria-orientation="vertical"
          aria-valuemin={240}
          aria-valuemax={480}
          aria-valuenow={panelWidth}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft")
              onPanelWidthChange(Math.min(480, panelWidth + 10));
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
                  Math.min(480, startWidth + (startX - ev.clientX)),
                ),
              );
            target.onpointerup = () => {
              target.onpointermove = null;
              target.onpointerup = null;
              target.releasePointerCapture(e.pointerId);
            };
          }}
        />
        {activity === "explorer" ? (
          <section className="code-sidebar-section">
            <div className="code-section-toggle">
              <small>Explorer</small>
              <strong>{projectName}</strong>
            </div>
            <div className="code-section-body">
              <ProjectFilesSidebar
                projectPath={cwd}
                projectName={projectName}
                refreshKey={worktreeDiff?.files.length ?? 0}
                onOpenAt={onOpenDiff}
              />
            </div>
          </section>
        ) : (
          <section className="code-sidebar-section">
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
          </section>
        )}
      </div>
    </div>
  );
}
