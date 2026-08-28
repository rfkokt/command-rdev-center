# Multi-repository workspaces

A registered workspace is a directory that may contain one or more independent Git repositories. It is **not** a Git repository merely because it contains `AGENTS.md` or child source directories.

## Repository map

On import, Kern verifies each candidate with its own `.git` file or directory and `git -C <candidate> rev-parse --show-toplevel`. The canonical result is the repository identity. A candidate such as `workspace/app` that only inherits the parent repository is excluded because it has no `.git` entry of its own.

The workspace parent is a container when it is not a verified repository. Mutating Git operations must select one displayed repository and run only through that repository's canonical root (or an owned worktree). The UI exposes branch, tracking branch, remote URL, ahead/behind count, and dirty-file count per repository.

## Recovery when a mapping is wrong

1. Close chats using the affected workspace; do not run reset, clean, pull, push, or worktree removal.
2. Remove the workspace registration from **Project settings**. This removes configuration only, never files.
3. Confirm every intended child has its own `.git` entry (`.git` can be a file for a worktree).
4. Re-import the workspace and select the correct child repository for new chats.
5. Inspect each repository independently with `git -C <repository> status` and recover commits only inside the repository whose canonical root owns them.

Never repair a cross-repository incident by creating a parent Git repository or by cherry-picking based only on a matching commit object.
