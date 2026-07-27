# Each Chat = ephemeral worktree + pi's default session

The global chatbox behaves like a normal pi agent: it can edit from the start (no read-only mode — the agent only calls write tools when the task actually requires it). To protect the main checkout, each Chat on a git repo runs in its own worktree, **centralized** at `/Volumes/ExternalM4/Project/.crc-worktrees/<repo>/<slug>` (outside the repo's working tree, so no `.gitignore` change is needed for worktrees), spawning `pi --mode rpc` with cwd = the worktree. Non-git projects spawn directly in their folder (a "not isolated" badge).

Persistence uses **pi's defaults**: no custom `--session-dir`, pi stores sessions under `~/.pi/agent/sessions/` keyed per-cwd. The worktree is **ephemeral** (auto-removed when a Chat is closed with no changes); the session file is **durable**. On Resume, if the worktree was removed, the app recreates `crc/<slug>` then spawns pi against the old session — history returns via pi's engine, working-dir fresh.

Rejected alternatives: (Y) spawn cwd = project directly with no worktree — simpler but the agent mutates the main checkout; (1) persistent worktrees with manual cleanup — branch pile-up; (3) archived read-only chats after worktree removal — extra state; per-repo worktrees (`<repo>/.crc-worktrees/`) — rejected in favor of one uniform centralized location. Ephemeral + rebuild + centralized was chosen as most consistent with "worktrees are cheap, the pi session is the source of truth".

Consequence: the earlier "read-only then promote to worktree" idea is cancelled. No tool-call intercept/replay. The Slug is deterministic, so the app needs no mapping file to reconstruct the identical cwd on Resume.
