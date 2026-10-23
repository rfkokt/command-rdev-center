import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { groupScmFiles } from "./scm-utils";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BranchIcon,
  ChevronRightIcon,
  MinusIcon,
  MoreIcon,
  PlusIcon,
  RefreshIcon,
  UndoIcon,
} from "./ui-icons";

/** Git porcelain code → label and tone for the status letter. */
function statusTone(file: File) {
  const code = (file.indexStatus.trim() ||
    file.worktreeStatus.trim() ||
    "?")[0];
  const tone =
    code === "A" || code === "?"
      ? "added"
      : code === "D"
        ? "deleted"
        : code === "R"
          ? "renamed"
          : "modified";
  return { code: code === "?" ? "U" : code, tone };
}

function splitPath(path: string) {
  const index = path.lastIndexOf("/");
  return index < 0
    ? { name: path, dir: "" }
    : { name: path.slice(index + 1), dir: path.slice(0, index) };
}

type Repo = {
  name: string;
  path: string;
  base_branch?: string;
  worktree?: string;
};
type File = { path: string; indexStatus: string; worktreeStatus: string };
type Status = {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: File[];
};
type Commit = {
  hash: string;
  shortHash: string;
  lane: number;
  subject: string;
  author: string;
  relativeTime: string;
  refs: string[];
};
type CommitFile = {
  path: string;
  status: string;
  added: number;
  removed: number;
  patch: string;
};
type Confirm = (options: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
}) => Promise<boolean>;

type Props = {
  cwd: string;
  repositories: Repo[];
  onDiff: (repository: string, path: string) => void;
  onCommitDiff: (repository: string, file: CommitFile) => void;
  confirm: Confirm;
  toast: (message: string) => void;
};

export default function SourceControlPanel({
  cwd,
  repositories,
  onDiff,
  onCommitDiff,
  confirm,
  toast,
}: Props) {
  const roots: Repo[] = repositories.length
    ? repositories.map((repo) => ({ ...repo, worktree: `${cwd}/${repo.name}` }))
    : [
        {
          name: cwd.split("/").pop() ?? "repository",
          path: cwd,
          worktree: cwd,
        },
      ];
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [graphs, setGraphs] = useState<Record<string, Commit[]>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [branches, setBranches] = useState<Record<string, string[]>>({});
  const [selectedCommit, setSelectedCommit] = useState<
    Record<string, { commit: Commit; files: CommitFile[] } | null>
  >({});
  const [busy, setBusy] = useState("");

  const refresh = useCallback(async () => {
    const entries = await Promise.all(
      roots.map(
        async (repo) =>
          [
            repo.name,
            await invoke<Status>("scm_status", {
              repositoryPath: repo.worktree,
            }),
          ] as const,
      ),
    );
    setStatuses(Object.fromEntries(entries));
  }, [cwd, repositories]);

  useEffect(() => {
    void refresh().catch((error) => toast(String(error)));
  }, [refresh, toast]);

  const act = async (repo: Repo, key: string, fn: () => Promise<unknown>) => {
    setBusy(`${repo.name}:${key}`);
    try {
      await fn();
      await refresh();
    } catch (error) {
      toast(String(error));
    } finally {
      setBusy("");
    }
  };
  const pathAct = (repo: Repo, action: string, paths: string[]) =>
    act(repo, action, () =>
      invoke("scm_paths", { repositoryPath: repo.worktree, action, paths }),
    );
  const loadGraph = async (repo: Repo) => {
    if (graphs[repo.name]) return;
    try {
      const graph = await invoke<Commit[]>("scm_graph", {
        repositoryPath: repo.worktree,
        limit: 40,
      });
      setGraphs((old) => ({ ...old, [repo.name]: graph }));
    } catch (error) {
      toast(String(error));
    }
  };
  const selectCommit = async (repo: Repo, commit: Commit) => {
    if (selectedCommit[repo.name]?.commit.hash === commit.hash) {
      setSelectedCommit((old) => ({ ...old, [repo.name]: null }));
      return;
    }
    try {
      setBusy(`${repo.name}:commit-files`);
      const files = await invoke<CommitFile[]>("scm_commit_files", {
        repositoryPath: repo.worktree,
        hash: commit.hash,
      });
      setSelectedCommit((old) => ({ ...old, [repo.name]: { commit, files } }));
    } catch (error) {
      toast(String(error));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="scm-panel kscm">
      {roots.map((repo) => {
        const status = statuses[repo.name];
        const { staged, unstaged, untracked } = groupScmFiles(
          status?.files ?? [],
        );
        const changeCount = staged.length + unstaged.length + untracked.length;
        const selection = selectedCommit[repo.name];
        const repoBusy = busy.startsWith(repo.name);
        return (
          <details
            className="kscm-repo"
            key={repo.name}
            open
            onToggle={(event) => {
              if (event.currentTarget.open) void loadGraph(repo);
            }}
          >
            {/* A summary is always rendered so the browser does not add its
                own "Details" label; it is hidden for a single repository. */}
            <summary className="kscm-repo-head" hidden={roots.length === 1}>
              <ChevronRightIcon size={12} className="kscm-chevron" />
              <b>{repo.name}</b>
              <span className="kscm-count">{changeCount || ""}</span>
            </summary>
            <div className="kscm-commit">
              <textarea
                value={messages[repo.name] ?? ""}
                onChange={(event) =>
                  setMessages((old) => ({
                    ...old,
                    [repo.name]: event.target.value,
                  }))
                }
                placeholder={
                  staged.length
                    ? `Message for ${staged.length} staged file${staged.length === 1 ? "" : "s"}`
                    : "Stage files, then write a commit message"
                }
                aria-label={`Commit message for ${repo.name}`}
                rows={2}
              />
              <button
                type="button"
                className="kscm-commit-button"
                disabled={
                  !messages[repo.name]?.trim() || !staged.length || repoBusy
                }
                onClick={() =>
                  void act(repo, "commit", async () => {
                    await invoke("scm_commit", {
                      repositoryPath: repo.worktree,
                      message: messages[repo.name],
                    });
                    setMessages((old) => ({ ...old, [repo.name]: "" }));
                  })
                }
              >
                Commit{staged.length ? ` ${staged.length}` : ""}
              </button>
            </div>
            <div className="kscm-sync">
              <label className="kscm-branch" title="Switch branch">
                <BranchIcon size={13} />
                <select
                  aria-label={`Branch for ${repo.name}`}
                  value={status?.branch ?? ""}
                  onFocus={() =>
                    void invoke<string[]>("scm_branches", {
                      repositoryPath: repo.worktree,
                    }).then((value) =>
                      setBranches((old) => ({ ...old, [repo.name]: value })),
                    )
                  }
                  onChange={(event) =>
                    void act(repo, "checkout", () =>
                      invoke("scm_checkout", {
                        repositoryPath: repo.worktree,
                        branch: event.target.value,
                        create: false,
                      }),
                    )
                  }
                >
                  <option>{status?.branch ?? "Loading…"}</option>
                  {(branches[repo.name] ?? [])
                    .filter((branch) => branch !== status?.branch)
                    .map((branch) => (
                      <option key={branch}>{branch}</option>
                    ))}
                </select>
              </label>
              <button
                type="button"
                className="kscm-sync-button"
                title="Sync with remote"
                disabled={repoBusy}
                onClick={() =>
                  void act(repo, "sync", () =>
                    invoke("scm_remote", {
                      repositoryPath: repo.worktree,
                      action: "sync",
                    }),
                  )
                }
              >
                <ArrowUpIcon size={12} />
                {status?.ahead ?? 0}
                <ArrowDownIcon size={12} />
                {status?.behind ?? 0}
              </button>
              <button
                type="button"
                className="kscm-icon"
                onClick={() => void refresh()}
                title="Refresh"
                aria-label="Refresh source control"
              >
                <RefreshIcon size={14} />
              </button>
              <details className="kscm-more">
                <summary
                  className="kscm-icon"
                  aria-label="More repository actions"
                  title="More"
                >
                  <MoreIcon size={14} />
                </summary>
                <div className="kscm-menu">
                  {(["fetch", "pull", "push"] as const).map((action) => (
                    <button
                      type="button"
                      key={action}
                      onClick={() =>
                        void act(repo, action, () =>
                          invoke("scm_remote", {
                            repositoryPath: repo.worktree,
                            action,
                          }),
                        )
                      }
                    >
                      {action[0].toUpperCase() + action.slice(1)}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      const branch = window.prompt("New branch name");
                      if (branch)
                        void act(repo, "branch", () =>
                          invoke("scm_checkout", {
                            repositoryPath: repo.worktree,
                            branch,
                            create: true,
                          }),
                        );
                    }}
                  >
                    Create branch…
                  </button>
                </div>
              </details>
            </div>

            {changeCount === 0 && status && (
              <p className="kscm-empty">
                No changes. The working tree is clean.
              </p>
            )}

            {(
              [
                ["Staged", staged, "unstage"],
                ["Changes", unstaged, "stage"],
                ["Untracked", untracked, "stage"],
              ] as const
            )
              .filter(([, list]) => list.length > 0)
              .map(([label, list, action]) => (
                <details className="kscm-group" key={label} open>
                  <summary>
                    <ChevronRightIcon size={12} className="kscm-chevron" />
                    <b>{label}</b>
                    <span className="kscm-count">{list.length}</span>
                    <button
                      type="button"
                      className="kscm-icon kscm-group-action"
                      title={action === "stage" ? "Stage all" : "Unstage all"}
                      aria-label={
                        action === "stage" ? "Stage all" : "Unstage all"
                      }
                      onClick={(event) => {
                        event.preventDefault();
                        void act(repo, action, () =>
                          invoke("scm_all", {
                            repositoryPath: repo.worktree,
                            action,
                          }),
                        );
                      }}
                    >
                      {action === "stage" ? (
                        <PlusIcon size={14} />
                      ) : (
                        <MinusIcon size={14} />
                      )}
                    </button>
                  </summary>
                  {list.map((file) => {
                    const { name, dir } = splitPath(file.path);
                    const { code, tone } = statusTone(file);
                    return (
                      <div className="kscm-file" key={`${label}:${file.path}`}>
                        <button
                          type="button"
                          className="kscm-file-name"
                          onClick={() => onDiff(repo.name, file.path)}
                          title={file.path}
                        >
                          <span className="kscm-file-base">{name}</span>
                          {dir && <span className="kscm-file-dir">{dir}</span>}
                        </button>
                        <span className="kscm-file-actions">
                          {label !== "Staged" && (
                            <button
                              type="button"
                              className="kscm-icon"
                              title="Discard changes"
                              aria-label={`Discard ${file.path}`}
                              onClick={() =>
                                void confirm({
                                  title: "Discard changes",
                                  message: `Discard changes to ${file.path}? This cannot be undone.`,
                                  confirmLabel: "Discard",
                                  cancelLabel: "Cancel",
                                  danger: true,
                                }).then((ok) => {
                                  if (ok)
                                    return pathAct(repo, "discard", [
                                      file.path,
                                    ]);
                                })
                              }
                            >
                              <UndoIcon size={14} />
                            </button>
                          )}
                          <button
                            type="button"
                            className="kscm-icon"
                            title={action === "stage" ? "Stage" : "Unstage"}
                            aria-label={`${action === "stage" ? "Stage" : "Unstage"} ${file.path}`}
                            onClick={() =>
                              void pathAct(repo, action, [file.path])
                            }
                          >
                            {action === "stage" ? (
                              <PlusIcon size={14} />
                            ) : (
                              <MinusIcon size={14} />
                            )}
                          </button>
                        </span>
                        <span
                          className={`kscm-status ${tone}`}
                          title={tone}
                          aria-label={tone}
                        >
                          {code}
                        </span>
                      </div>
                    );
                  })}
                </details>
              ))}

            <details
              className="kscm-group kscm-history"
              onToggle={(event) => {
                if (event.currentTarget.open) void loadGraph(repo);
              }}
            >
              <summary>
                <ChevronRightIcon size={12} className="kscm-chevron" />
                <b>History</b>
              </summary>
              {(graphs[repo.name] ?? []).map((commit) => {
                const selected = selection?.commit.hash === commit.hash;
                return (
                  <div
                    className={`kscm-commit-item${selected ? " selected" : ""}`}
                    key={commit.hash}
                  >
                    <button
                      type="button"
                      className="kscm-commit-row"
                      onClick={() => void selectCommit(repo, commit)}
                      title={`${commit.subject}\n${commit.shortHash} · ${commit.author}`}
                    >
                      <span className="kscm-commit-subject">
                        {commit.subject}
                      </span>
                      <span className="kscm-commit-meta">
                        {commit.author} · {commit.relativeTime}
                      </span>
                    </button>
                    {selected && (
                      <div className="kscm-commit-files">
                        {selection.files.map((file) => (
                          <button
                            type="button"
                            key={file.path}
                            onClick={() => onCommitDiff(repo.name, file)}
                            title={file.path}
                          >
                            <span className="kscm-file-base">
                              {splitPath(file.path).name}
                            </span>
                            <span className="kscm-diffstat">
                              <i>+{file.added}</i> <em>−{file.removed}</em>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </details>
          </details>
        );
      })}
    </div>
  );
}
