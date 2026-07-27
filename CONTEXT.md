# command-rdev-center

Local-first macOS desktop app to run the `pi` coding agent on local projects through an in-app chatbox, review changes via git diff, isolate each unit of work in a git worktree, give per-project context via Graphify, and track tasks + pushes. Single user.

## Language

**Chat**:
A conversation in the global chatbox, exactly like a normal AI assistant. It IS a normal pi agent — it can edit from the start (no read-only mode; the agent only calls write tools when the task actually requires it). Each Chat runs in its own worktree (on a git repo). *The everyday entry point.*
_Avoid_: read-only chat (concept dropped), prompt

**Session**:
The technical embodiment of one Chat: one worktree + one `pi --mode rpc` process + one pi session file (stored in pi's default location `~/.pi/agent/sessions/`, keyed per-cwd). *What you run.* The worktree is **ephemeral**; the pi session file is **durable**.
_Avoid_: task (for a worktree unit), job

**Task**:
A planned, tracked unit of work — one row in the Kanban JSON (`{no, url, deskripsi, pic, status, notes}`). *What you plan.* Created manually and optional. Example: KAI ticket `#870`.
_Avoid_: ticket, item, backlog entry (as a mixed term)

**Run**:
One push-pipeline execution logged to `_pipeline-runs.jsonl`. *What you ship.*
_Avoid_: task, push (as a noun for the record)

**Slug**:
A deterministic per-Chat identifier (e.g. `crc-<timestamp>` or 6-char, minted once). Used as the worktree name **and** as part of the cwd pi uses to key its session. Because it is deterministic, the app needs **no mapping file**: active worktrees = the `.crc-worktrees/<repo>/` folder; old Chats = pi's default sessions for that repo.

**Model selection**:
Model list fetched via `get_available_models` RPC (always fresh from pi process). Global default from seeded JSON config (branch C). Per-Chat override: user picks from dropdown in Chat header → `set_model` RPC. Persisted in `~/.pi/agent/sessions/<slug>.crc.json` (`{model:{provider,modelId}, thinkingLevel}`) so Resume restores the last-used model. Path derivable from slug — no separate mapping file.

**pi process**:
The OS process `pi --mode rpc` running a Chat. **Ephemeral**: spawned when the Chat is active (typing/focused), killed when idle to save RAM/rate-limit. The agent answering is **always** pi — only the OS process is ephemeral, not the conversation (the pi session is durable). Guard: a process is killed **only** when truly idle (not streaming, not running bash, empty queue); a Chat working in the background must not be killed even if its tab is unfocused. When the external drive unmounts mid-Session (cwd gone): mark the Chat "drive detached", **freeze** it (no forced kill / retry loop), offer "reconnect" when the drive returns → respawn + resume.

**Resume**:
Reopening an old Chat. Because worktrees are ephemeral, if the worktree was removed the app **recreates** `crc/<slug>` then spawns pi against the old session file — history returns via pi's own engine, working-dir fresh. The app stores no history of its own; the pi session file is the source of truth.

**Promote to worktree** (dropped):
An earlier idea (read-only Chat that becomes a writing Session on first edit). Dropped — every Chat is full pi in a worktree from the start.

## Relationships

- A **Chat** is ad-hoc (normal-AI style) and does **not** require a **Task** — this is the everyday path.
- Each **Chat** on a **git repo** = one **Session** (one worktree + one pi session file) from the moment it opens. Worktrees are **centralized** at `/Volumes/ExternalM4/Project/.crc-worktrees/<repo>/<slug>` (outside the repo's working tree, so no `.gitignore` change is needed for worktrees). Limit: only safe for projects on the same drive as this root; a project on another drive would be cross-device (all current projects live on ExternalM4).
- **Non-git projects** (only `package.json`/`Cargo.toml`/`pom.xml`): no worktree possible — the Chat spawns pi with cwd = the project folder directly, agent edits in place. UI shows a "not isolated" badge; a one-time `git init` option is offered (never forced).
- A **Task** (optional, created manually) can spawn many **Sessions**.
- Worktrees are **ephemeral**: auto-removed when a Chat is closed with no changes; recreated on **Resume** when needed.
- The pi session file is **durable** (pi's default location), independent of worktree lifetime.
- No app-owned storage/mapping: source of truth = the `.crc-worktrees/` folder (active worktrees) + pi's default sessions (history & the list of old Chats).
- A **Session** can end in a **Run**.

## Capability parity (pi via RPC)

The chatbox is the same pi agent — the engine is literally a `pi --mode rpc` process (models, tools, skills, extensions, sessions, compaction, retry, fork, steering all via RPC). Only the presentation (TUI → React chat UI) differs. Three pi features are TUI-only / absent from RPC and are handled as follows (see ADR-0002):

- **`@` file-reference** (fuzzy file search + inject path) — **built** in the app (only gap we implement).
- **`/login` `/logout`** — no RPC command; credentials configured via env **before** spawning pi.
- **`/llama`, `/share`, `/import`, `/trust`, built-in `/settings`/`/hotkeys`** — **skipped** for now (`/settings`/keybindings are intentionally replaced by the app's own UI).

## Example dialogue

> **Dev:** "If I close a **Chat** that made no edits, what happens to its **Session**?"
> **Owner:** "The worktree auto-removes — it's ephemeral. The pi session file stays. If I reopen it, that's a **Resume**: the app recreates the worktree from the **Slug** and pi replays my history."
> **Dev:** "And a **Chat** on a folder with only `package.json`, no `.git`?"
> **Owner:** "No worktree — pi runs in the folder directly with a 'not isolated' badge. That Chat is not a **Session** in the worktree sense."

## Flagged ambiguities

- "task" originally meant three concepts (worktree unit, Kanban item, pipeline run) — resolved: **Session** (worktree), **Task** (Kanban), **Run** (pipeline).
- "task has its own chat" — resolved: an ad-hoc **Chat** is the main path, independent of **Task**; a **Task** is only created manually when you want tracking.
- "read-only then promote" — dropped: the agent only edits when the task asks it to, so every Chat is full-mode in a worktree from the start.

## Resolved branches (grill session)

Chat-core for Phase 1 is settled. The six open branches are now resolved:

- **A. `@` file-reference** — RESOLVED: picker reads the **pi process cwd** (worktree for git Chats, project folder for non-git), gitignore-filtered, skipping `.crc-worktrees/`, `graphify-out/`, `node_modules/`, `.git/`. Rust `list_project_files(session_id)` walks that cwd. Reason: injected paths must resolve in the agent's own cwd. Skipped: live re-index / ripgrep — add when plain walk lags.
- **B. Tool-approval dialog** — RESOLVED: app never auto-resolves. If the request carries `timeout`, show a countdown but let the **agent** auto-resolve on expiry (`undefined`/`false` = safe = Block/cancel); app just closes the stale dialog when the turn advances. If no `timeout`, block until the user answers — no app-invented timer. Safe default for dangerous commands = Block, achieved by the agent's own auto-resolve. Reason: the app must never silently Allow.
- **C. Settings screen** — RESOLVED: split. Phase 1 ships a **seeded JSON config** (pi path, project root, default model/thinking) with verified defaults — app runs out-of-the-box, no UI. Runtime model/thinking via `set_model`/`set_thinking_level`. The **visual Settings screen is deferred** (edit the file manually until a default is wrong). YAGNI: single user, paths known. ⚠️ Changes PRD §2/§6.4 which requested a Phase 1 Settings screen.
- **D. Phase 2 diff baseline** — RESOLVED: baseline = `git merge-base crc/<slug> <parent>`, diff view = `git diff <merge-base>...HEAD` (three-dot, immune to parent advancing) **plus** uncommitted (`git diff` + `--staged`). Parent branch recorded git-natively at `worktree add -b crc/<slug> <path> <parent>` (default = repo's `origin/HEAD`, fallback `main`); recomputed, never stored. Handles both fresh worktree (no commits) and Resume (branch has commits) with one logic. ⚠️ Changes PRD §7 (stored `rev-parse HEAD` → computed merge-base).
- **E. Phase 3 graphify + ephemeral worktree** — RESOLVED: graph lives **in-repo at the main checkout** `<repo>/graphify-out/` (NOT the ephemeral worktree, NOT a central cache). Worktrees read-only via absolute path; `--update` runs against main. Chosen over central `~/.graphify/<repo>/` because in-repo is graphify's native default (no `--graph` flag needed anywhere, matches AGENTS.md contract, manual terminal queries just work) and central would force a repo→dir mapping = the app-owned state this architecture rejects. Push risk covered by §9.4 two-layer gitignore. Graph is slightly stale for uncommitted worktree edits — accepted (it's an orientation map, updated after commit/branch-switch per §9.3).
- **F. Phase 4 pipeline logging** — RESOLVED: add the logging section to `git-push-workflow/SKILL.md` **now** (independent of app code, so runs accumulate before the Phase 4 UI exists). Split storage: `_pipeline-runs.jsonl` is append-only (one final record per run, easy board read) + `_pipeline-current.json` patched per stage transition for the live "which step" indicator — no mid-file JSONL rewrites. Schema (superset of PRD §10.2): `{run_id, project, project_type, date, status:"running|done", commits, stages:[{name, ms, status:"pass|fail|skip|running|pending"}]}`. UI = Jenkins Stage View grid (stage columns, run rows, colour per status, avg-per-stage header), top row shows the `running` stage. ⚠️ Extends PRD §10.2 schema with run-level status + `running`/`pending` stage states.
