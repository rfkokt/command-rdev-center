import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { groupScmFiles } from "./scm-utils";

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
    <div className="scm-panel">
      <header>
        <strong>SOURCE CONTROL</strong>
        <button
          onClick={() => void refresh()}
          title="Refresh source control"
          aria-label="Refresh source control"
        >
          ↻
        </button>
      </header>
      <div className="scm-repositories">
        {roots.map((repo) => {
          const status = statuses[repo.name];
          const { staged, unstaged, untracked } = groupScmFiles(
            status?.files ?? [],
          );
          const changeCount =
            staged.length + unstaged.length + untracked.length;
          const selection = selectedCommit[repo.name];
          return (
            <details
              className="scm-repository"
              key={repo.name}
              open
              onToggle={(event) => {
                if (event.currentTarget.open) void loadGraph(repo);
              }}
            >
              <summary className="scm-repo-summary">
                <div>
                  <b>{repo.name}</b>
                  <small>{status?.branch ?? "Loading…"}</small>
                </div>
                <span>{changeCount}</span>
              </summary>
              <div className="scm-repo-content">
                <div className="scm-primary-row">
                  <textarea
                    value={messages[repo.name] ?? ""}
                    onChange={(event) =>
                      setMessages((old) => ({
                        ...old,
                        [repo.name]: event.target.value,
                      }))
                    }
                    placeholder="Commit message"
                    aria-label={`Commit message for ${repo.name}`}
                  />
                  <button
                    className="scm-commit"
                    disabled={
                      !messages[repo.name]?.trim() ||
                      !staged.length ||
                      busy.startsWith(repo.name)
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
                    Commit {staged.length || ""}
                  </button>
                </div>
                <div className="scm-sync-row">
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
                    <option>{status?.branch ?? "Branch"}</option>
                    {(branches[repo.name] ?? [])
                      .filter((branch) => branch !== status?.branch)
                      .map((branch) => (
                        <option key={branch}>{branch}</option>
                      ))}
                  </select>
                  <button
                    onClick={() =>
                      void act(repo, "sync", () =>
                        invoke("scm_remote", {
                          repositoryPath: repo.worktree,
                          action: "sync",
                        }),
                      )
                    }
                  >
                    Sync{" "}
                    <span>
                      ↑{status?.ahead ?? 0} ↓{status?.behind ?? 0}
                    </span>
                  </button>
                  <details>
                    <summary aria-label="More repository actions">•••</summary>
                    <div>
                      <button
                        onClick={() =>
                          void act(repo, "fetch", () =>
                            invoke("scm_remote", {
                              repositoryPath: repo.worktree,
                              action: "fetch",
                            }),
                          )
                        }
                      >
                        Fetch
                      </button>
                      <button
                        onClick={() =>
                          void act(repo, "pull", () =>
                            invoke("scm_remote", {
                              repositoryPath: repo.worktree,
                              action: "pull",
                            }),
                          )
                        }
                      >
                        Pull
                      </button>
                      <button
                        onClick={() =>
                          void act(repo, "push", () =>
                            invoke("scm_remote", {
                              repositoryPath: repo.worktree,
                              action: "push",
                            }),
                          )
                        }
                      >
                        Push
                      </button>
                      <button
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
                {[
                  ["Staged Changes", staged, "unstage"],
                  ["Changes", unstaged, "stage"],
                  ["Untracked", untracked, "stage"],
                ].map(([label, list, action]) => (
                  <details
                    className="scm-group"
                    key={label as string}
                    open={(list as File[]).length > 0}
                  >
                    <summary>
                      <b>{label as string}</b>
                      <span>{(list as File[]).length}</span>
                      {(list as File[]).length > 0 && (
                        <button
                          onClick={(event) => {
                            event.preventDefault();
                            void act(repo, action as string, () =>
                              invoke("scm_all", {
                                repositoryPath: repo.worktree,
                                action,
                              }),
                            );
                          }}
                        >
                          {action === "stage" ? "Stage all" : "Unstage all"}
                        </button>
                      )}
                    </summary>
                    {(list as File[]).map((file) => (
                      <div className="scm-file" key={`${label}:${file.path}`}>
                        <button
                          className="scm-file-name"
                          onClick={() => onDiff(repo.name, file.path)}
                        >
                          {file.path}
                        </button>
                        <small>
                          {file.indexStatus.trim() || file.worktreeStatus}
                        </small>
                        <button
                          title={action === "stage" ? "Stage" : "Unstage"}
                          onClick={() =>
                            void pathAct(repo, action as string, [file.path])
                          }
                        >
                          {action === "stage" ? "+" : "−"}
                        </button>
                        {label !== "Staged Changes" && (
                          <button
                            title="Discard"
                            onClick={() =>
                              void confirm({
                                title: "Discard changes",
                                message: `Discard changes to ${file.path}? This cannot be undone.`,
                                confirmLabel: "Discard",
                                cancelLabel: "Cancel",
                                danger: true,
                              }).then((ok) => {
                                if (ok)
                                  return pathAct(repo, "discard", [file.path]);
                              })
                            }
                          >
                            ↶
                          </button>
                        )}
                      </div>
                    ))}
                  </details>
                ))}
                <section className="scm-history">
                  <header>
                    <b>History</b>
                    <button onClick={() => void loadGraph(repo)}>↻</button>
                  </header>
                  <div className="scm-history-list">
                    {(graphs[repo.name] ?? []).map((commit) => (
                      <div
                        className={`scm-history-item${selection?.commit.hash === commit.hash ? " selected" : ""}`}
                        key={commit.hash}
                      >
                        <button
                          className="scm-commit-row"
                          onClick={() => void selectCommit(repo, commit)}
                        >
                          <i style={{ marginLeft: commit.lane * 8 }} />
                          <div>
                            <span>{commit.subject}</span>
                            <small>
                              <code>{commit.shortHash}</code>
                              {commit.author} · {commit.relativeTime}
                            </small>
                          </div>
                        </button>
                        {selection?.commit.hash === commit.hash && (
                          <div className="scm-inline-files">
                            {selection.files.map((file) => (
                              <button
                                key={file.path}
                                onClick={() => onCommitDiff(repo.name, file)}
                              >
                                <span>{file.status}</span>
                                <strong>{file.path}</strong>
                                <i>+{file.added}</i>
                                <em>−{file.removed}</em>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}
