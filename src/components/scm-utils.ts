export type ScmFile = {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
};
export function groupScmFiles(files: ScmFile[]) {
  return {
    staged: files.filter(
      (file) => file.indexStatus !== " " && file.indexStatus !== "?",
    ),
    unstaged: files.filter(
      (file) => file.worktreeStatus !== " " && file.worktreeStatus !== "?",
    ),
    untracked: files.filter((file) => file.worktreeStatus === "?"),
  };
}
