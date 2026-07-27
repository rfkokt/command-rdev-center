# Diff baseline is computed merge-base, not stored HEAD

The Phase 2 diff baseline is computed as `git merge-base crc/<slug> <parent>` and rendered three-dot (`git diff <merge-base>...HEAD` plus uncommitted `git diff` / `--staged`), rather than a HEAD SHA recorded at task start (as PRD §7 originally proposed).

## Why

Worktrees are ephemeral and Chats can Resume onto a `crc/<slug>` branch that already has commits. A stored `git rev-parse HEAD` baseline breaks on Resume: once the agent's edits are committed to the branch, `git diff HEAD` is empty and the review view loses all agent work. The merge-base is recomputed from git itself, so no app-owned state is stored (consistent with the "git is the source of truth, no mapping file" architecture). Three-dot (not two-dot) is used so that if the parent branch advances after the worktree branched, those unrelated parent commits do not pollute the diff.

## Consequences

The parent branch is recorded git-natively at worktree creation (`git worktree add -b crc/<slug> <path> <parent>`, default = repo's `origin/HEAD`, fallback `main`); it is never persisted separately. One baseline logic handles both a fresh worktree (no commits yet) and a resumed worktree (branch has commits).
