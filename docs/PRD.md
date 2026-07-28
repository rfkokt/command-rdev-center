# PRD — command-rdev-center

**One sentence:** A native macOS desktop app to run the `pi` coding agent on my local projects through an in-app chatbox, review what the agent changed via git diff, isolate each task in its own git worktree, give the agent instant per-project context via a Graphify knowledge graph, and track my tasks + push-pipeline runs — all local-first, one user (me).

**Owner:** garcia · **Status:** Draft v1 · **Date:** 2026-07-27
**Location:** `/Volumes/ExternalM4/Project/command-rdev-center/`

---

## 1. Problem & background

I keep 40+ folders in `/Volumes/ExternalM4/Project`, ~21 of them real code projects. Today, working on any of them means: open a terminal, `cd` into the path, run `pi`, and manually keep track of what changed, which task I'm on, and whether my last push passed its gates. There is no single place that ties together: launching the agent, seeing its edits, isolating parallel tasks, giving the agent project context without re-reading every file, and tracking my own tasks + pushes.

Existing tools solve isolated pieces — Kanri (local Kanban), claude-launcher (GUI to launch an agent), Shellporter (terminal-in-project), Graphify (code knowledge graph) — but none combine **agent chatbox + diff review + worktree isolation + per-project knowledge graph + my Kanban + my push pipeline** for my own projects. This app is that combination: local-first, no server, no cloud, no telemetry, built for exactly one user.

## 2. Goals & success metrics

**Product goal:** one window where I pick a project, chat with `pi` (full native capability), watch/review its changes safely, and never lose track of tasks or pushes.

**Phase 1 goal (the only thing built first):** pick a project → type in a chatbox → `pi` runs as the engine behind it, streaming replies, with full pi capability (models, tools, skills, sessions). Each git Chat runs in its own ephemeral worktree from day 1 — worktree is load-bearing safety, not Phase 2. Everything else (diff viewer UI, graph, kanban, pipeline) is scoped in later phases but the architecture is designed for them now.

**Success metrics (Phase 1):**
- I can see my ~21 real projects, searchable, and open one into a chat.
- Sending a message runs `pi` behind the scenes and streams the reply token-by-token, indistinguishable in capability from native pi.
- Tool calls (read/bash/edit/write) show live; tool-approval prompts appear as in-app dialogs.
- I can switch model / thinking level from the UI without restarting.
- If the external drive is unmounted or `pi` crashes, the app shows a clear state and never hard-crashes.

**Non-goals (Phase 1):** diff viewer UI, graph, kanban, pipeline (later phases), Windows/Linux, multi-user, cloud sync. Worktree IS in Phase 1 (ADR-0001).

## 3. Target user

Exactly one: me. macOS 14+ (Darwin 24.x), Apple Silicon, zsh. Verified environment: `pi` at `/Users/rifkioktapratama/.local/bin/pi`, node 22, pnpm 10, cargo/rustc 1.94, Python 3.14.6, `graphify` at `/Users/rifkioktapratama/.local/bin/graphify`, git 2.50. Projects on external drive `/Volumes/ExternalM4/Project`. No auth, no telemetry.

---

## 4. The five pillars

1. **Project launcher + pi chatbox (RPC engine) + worktree isolation** — list projects, open one into an in-app chat backed by a **headless** `pi --mode rpc` background process (no terminal window, ever). Each git Chat spawns its own worktree at `/.crc-worktrees/<repo>/<slug>` → `pi` cwd = worktree. **Phase 1 (worktree is safety, not later).**
2. **Diff / review viewer** — after the agent works, see exactly what changed, git-based (git diff/status), rendered per-file in-app before commit. **Phase 2 (diff UI only — git diff itself already available via tool).**
3. **Worktree lifecycle polish** — auto-cleanup of empty worktrees, cross-device guard, Resume baseline disambiguation (Phase 1 created it, Phase 2 hardens it). **Phase 2.**
4. **Graphify per-project knowledge graph** — each project gets a queryable knowledge graph so the agent has instant context without re-reading files. Auto-updated cheaply on code changes, gitignored so it never gets pushed. **Phase 3.**
5. **Kanban + push-pipeline dashboard** — my own task board (from `Task All Project/*.json`) and a Jenkins-style stage-view of `git-push-workflow` runs. **Phase 4.**

## 5. User stories (MoSCoW)

**Phase 1 — launcher + chatbox**
- **Must** — I see a searchable list of my real projects (folders with `.git`/`package.json`/`Cargo.toml`/`pom.xml`), sorted by most-recently-modified, with stack badges.
- **Must** — I open a project into a chatbox and send a message; `pi` runs behind it and streams the reply.
- **Must** — Tool calls (read/bash/edit/write) render live; a dangerous-command approval shows as an in-app dialog I can Allow/Block.
- **Must** — If the drive is unmounted or `pi` exits unexpectedly, I get a clear state, not a crash.
- **Should** — I switch model and thinking level from the UI mid-session.
- **Should** — Sessions persist per project; I can resume the last session.
- **Could** — Multiple project chats open at once (tabs).

**Phase 1 included — worktree-per-Chat**
- **Must** — Each Chat on a git repo spawns its own worktree+branch (`crc/<slug>`) at `/.crc-worktrees/<repo>/`; two Chats on same repo don't collide.
- **Must** — pi process cwd = the worktree, never main checkout (main is safe).
- **Must** — On close with no changes, worktree auto-removed; Resume recreates it.

**Phase 2 — diff viewer**
- **Must** — After the agent edits, I see a per-file diff (added/removed) of what it changed (git source of truth).
- **Should** — Live "currently editing X" indicator from tool events while the agent works.
- **Should** — From the diff view I can hand off to the `git-push-workflow` skill to commit/push.

**Phase 3 — graphify**
- **Must** — Each project can build a Graphify graph; the agent is given its `GRAPH_REPORT.md` as context on session start.
- **Must** — `graphify-out/` and graphify trace files are gitignored so they never get pushed.
- **Should** — Graph auto-updates (code-only, no LLM) after the agent finishes a task or on commit/branch switch.
- **Should** — UI shows graph status per project: none / fresh / stale, with a "rebuild" action for the expensive (docs/LLM) path.

**Phase 4 — kanban + pipeline**
- **Should** — Kanban board reads `Task All Project/*.json`, columns by status, edit writes back atomically.
- **Should** — Pipeline stage-view renders `git-push-workflow` runs, dynamic columns per project type, avg per stage.

- **Won't (any phase)** — cloud sync, multi-user, Windows/Linux, telemetry.

---

## 6. Architecture & best-practice decisions

Grounded in Tauri v2 official docs, pi's own `rpc.md`/`sdk.md`, and Graphify source read directly (`safi-shamsi/graphify`).

### 6.1 Stack
- **Tauri v2** (Rust core + system webview UI). Chosen over Electron: ~3–10 MB vs ~100+ MB bundle, native filesystem access (no CORS), ~0.1s cold start. All toolchain verified present.
- **Frontend:** React + Vite + **TypeScript** (per `best-practices` skill: typed at boundaries, no `any` without reason, semantic HTML, handle loading/error/empty/success states).
- **State:** minimal local React state for Phase 1. Introduce a store (Zustand) only when multi-view/multi-tab justifies it — YAGNI.

### 6.2 pi as engine — RPC subprocess (decided: Option A)
The chatbox is **not** a terminal, and the app **never opens Terminal.app, iTerm2, Ghostty, or any terminal emulator**. pi runs as a **headless background subprocess** (no window, no TTY) in RPC mode; the Rust core owns the process and pipes JSONL to/from it; the webview renders a custom chat UI. There is no terminal application involved anywhere in this app — the earlier terminal-launch idea was dropped when the chatbox approach was chosen.

- Spawn: `pi --mode rpc [flags]` with **cwd = the project (or worktree) directory**, using the absolute pi path (`/Users/rifkioktapratama/.local/bin/pi`) so PATH can never break it.
- Protocol (from `rpc.md`): **JSONL over stdin/stdout**, LF-delimited. Commands → stdin (`{"id","type":"prompt","message":...}`). Events → stdout.
  - **Critical framing rule:** split on `\n` only; strip trailing `\r`. Do **not** use Node `readline` — it also splits on U+2028/U+2029 which are valid inside JSON strings. The Rust reader must be a strict LF line splitter.
- Streaming events consumed → forwarded to webview via Tauri events:
  - `message_update` (text/thinking deltas) → stream into the chat bubble
  - `toolcall_start` / `toolcall_delta` / `toolcall_end` → render tool calls live
  - `agent_start` / `agent_end` / `turn_start` → chat turn lifecycle
  - `bash_execution_update` → live bash output
- Commands the UI issues: `prompt`, `steer`, `follow_up`, `abort`, `set_model`, `set_thinking_level`, `get_available_models`, `get_available_thinking_levels`, `compact`, `switch_session`, `fork`, `get_state`, `get_messages`.
- **Tool approval:** RPC emits `extension_ui_request` (`select`/`confirm`/`input`) and blocks until the client replies with `extension_ui_response` (matching `id`). The app renders these as in-app dialogs (e.g. "Allow dangerous command? [Allow/Block]"), giving native-equivalent approval UX. Honor the optional `timeout` field (agent auto-resolves if we don't answer).

**Why RPC not SDK:** keeps the small native bundle Tauri gives us; process isolation means a pi crash never takes the app down; it's the same layer pi's own interactive/print modes use. The SDK (in-process) would force Electron or a Node sidecar, re-introducing the weight we chose Tauri to avoid.

### 6.3 "Same as native pi?" — capability parity
Engine is identical native pi: same models, tools, skills, extensions, sessions, compaction, retry. Only the **presentation** is ours (chat bubbles, streaming, tool-call rendering) instead of pi's TUI. RPC exposes everything needed to match native UX. Purely TUI-only features (terminal themes, keybindings) are irrelevant — our UI is different by design.

### 6.4 pi settings surfaced in the app
- **Startup flags:** `--provider`, `--model`, `--thinking`, `--tools`/`--exclude-tools`/`--no-tools`, `--skill`, `--extension`, `--append-system-prompt`, `--session-dir`, `--name`, `--no-session`.
- **Runtime commands (no restart):** `set_model`, `set_thinking_level`, `set_steering_mode`, `set_auto_compaction`, `set_auto_retry`, `compact`, `switch_session`, `fork`.
- **Populate UI controls:** `get_available_models`, `get_available_thinking_levels` fill dropdowns.
- Phase 1 ships a seeded JSON config (pi path, project root, default model, default thinking level, preferred provider) with verified defaults — no visual editor; edit the file manually until a default is wrong (ADR-worthy decision, see CONTEXT.md branch C). The visual Settings screen is deferred past Phase 1. Runtime model/thinking switch via RPC. (No terminal setting exists — the chatbox has no terminal.)

### 6.5 Project structure (Tauri v2 convention)
```
command-rdev-center/
├── package.json
├── index.html
├── src/                    # React UI
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/         # ProjectList, ChatView, MessageBubble, ToolCall, ApprovalDialog, Settings
│   └── lib/                # rpc event types, tauri invoke wrappers
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   └── src/
│       ├── lib.rs          # command registration
│       ├── projects.rs     # scan/list projects
│       ├── pi_rpc.rs       # spawn pi --mode rpc, JSONL read/write, event bridge
│       ├── diff.rs         # (Phase 2) git diff/status
│       ├── worktree.rs     # (Phase 2) git worktree add/remove
│       └── graph.rs        # (Phase 3) graphify build/update, gitignore, context inject
└── docs/PRD.md
```

### 6.6 Security / capabilities (Tauri v2)
- pi is spawned by our own Rust command via `std::process::Command`, **not** the shell plugin — smallest surface, no open shell scope exposed to the webview.
- Webview only reaches named Rust commands (`list_projects`, `start_pi_session`, `send_prompt`, …). Any `path` argument is validated server-side to be a child of the configured project root (anti path-traversal).
- No network permission in the Tauri layer. No fs plugin write scope; file reads/writes done in Rust with validation.

---

## 7. Diff / review viewer (Phase 2)

Goal: after the agent works, I see exactly what changed before committing. Source of truth = **git**, not RPC events (git is accurate; RPC events are for live hints only).

- On task start: baseline is **computed**, not stored — `git merge-base crc/<slug> <parent>` (parent recorded git-natively at worktree creation, default `origin/HEAD`, fallback `main`). See docs/adr/0004.
- While agent works: use `toolcall_end` for `edit`/`write` to show a live "touched files" list (hint only).
- On task end: `git status --porcelain` + `git diff <merge-base>...HEAD` (three-dot, immune to parent advancing) plus uncommitted `git diff` / `git diff --staged` → render per-file, added/removed lines, collapsible. Three-dot from merge-base handles both a fresh worktree and a resumed worktree whose branch already has commits.
- From the diff panel: hand off to the `git-push-workflow` skill to commit/push (the app does not reimplement push logic; it delegates to the existing skill).

## 8. Worktree-per-task isolation (Phase 2)

Goal: parallel tasks never collide; each task is isolated.

- Start task → `git worktree add <root>/.crc-worktrees/<repo>/<task-slug> -b task/<task-slug>`.
- Spawn `pi --mode rpc` with **cwd = that worktree**, not the main checkout.
- Diff/review scoped to the worktree.
- On finish → hand off to `git-push-workflow`; then `git worktree remove` + optional branch delete.
- Worktrees live under a single `.crc-worktrees/` dir; that dir is gitignored (see §9). If the repo is on the external drive, worktrees are colocated on the same drive to avoid cross-device issues.
- Guardrail: one active pi writer per worktree (never two agents writing the same cwd).

## 9. Graphify per-project knowledge graph (Phase 3)

Read directly from Graphify source — the key finding drives the update strategy.

### 9.1 Two rebuild classes (cost asymmetry)
| Change | Mechanism | Cost | LLM? |
|---|---|---|---|
| Code files (.py/.ts/.js/.go/.rs/…) | AST via Tree-sitter (`_rebuild_code`) | seconds | No |
| Docs / PDF / images (.md/.pdf/.png) | LLM extraction (subagents) | slow + token cost | Yes |

SHA256 per-file cache (`graphify-out/cache/`) → `--update` only reprocesses changed files.

### 9.2 How the agent uses it (no MCP — decided)
Level 2 integration: context file + CLI via pi's `bash` tool.
- **Passive orientation:** inject `graphify-out/GRAPH_REPORT.md` into pi context on session start (via `--append-system-prompt` pointing at the report, and/or an `AGENTS.md` note). The agent reads the map (god nodes, communities, surprising links) before grepping files.
- **Active navigation:** the app writes an `AGENTS.md` note telling pi: "a knowledge graph exists — when you need specifics, run `graphify query "..."`, `graphify path A B`, `graphify explain X` via bash instead of reading files one by one." pi already has the `bash` tool and `graphify` CLI is installed — no MCP layer needed.

### 9.3 When the app updates the graph
| Trigger | Action | Why |
|---|---|---|
| After pi finishes a task with code diffs | `graphify <path> --update` (code-only) auto | cheap, no LLM; keeps graph in sync for the next task |
| After commit / branch switch / new worktree | `graphify <path> --update` | matches Graphify's own git-hook design |
| Docs/PDF/image changed | **Do not auto** — show "graph stale (docs), rebuild?" badge | expensive (LLM); user decides when to pay |
| First open, no `graphify-out/` | prompt "build graph?" (one-time full build) | full build is expensive; ask first |

UI shows per-project graph status: **none / fresh / stale-code / stale-docs**.

### 9.4 Gitignore (must — user requirement: never pushed)
Two layers:
1. **Per-project (automatic):** before/after any graph build, the app ensures the project `.gitignore` contains (idempotent append, only if missing):
   ```
   # graphify (local knowledge graph — do not push)
   graphify-out/
   .graphify_python
   .graphify_detect.json
   ```
2. **Global safety net (opt-in, asks first):** add the same to `~/.gitignore_global` (`core.excludesfile`) so even projects the app never touched are covered.

**Honest caveat:** if `graphify-out/` was already tracked/committed before, adding `.gitignore` does **not** untrack it. The app detects this (`git ls-files graphify-out/`) and warns with the fix (`git rm -r --cached graphify-out/`) — never silently.

### 9.5 Dependency note
Graphify needs Python 3.10+ (have 3.14.6) and an LLM API key for **docs** extraction (code extraction needs none). Reuse the same provider/key pi uses.

---

## 10. Kanban + push-pipeline dashboard (Phase 4)

### 10.1 Kanban
- Source: `/Volumes/ExternalM4/Project/Task All Project/<project>.json`, one file per project. Task shape (verified): `{no, url, deskripsi, pic, status, notes}`.
- Columns by `status`, default order `Backlog → In Progress → Review → Done`, extra statuses appended. Grouping is case-insensitive (`done` == `Done`).
- Filters: by `pic`, by project.
- Edit (drag/dropdown) writes back **atomically**: write temp file → `fsync` → rename; keep a `.bak` before overwrite. Never corrupt the JSON.
- Reuses the existing `backlog-local` skill's data files — no separate store.
- The model decides whether a request merits tracking via the `track_kanban_task` tool—no language/keyword classifier. Chosen work creates one session-linked task as `In Progress` without an approval prompt. Agent completion moves it to `Review`; user/editor acceptance moves it to `Done`.

### 10.2 Push-pipeline stage-view (Jenkins-style)
- Source: `_pipeline-runs.jsonl` (one run per line), **written by the `git-push-workflow` skill** (a small logging section added to that SKILL.md), read by the app. Location: `/Volumes/ExternalM4/Project/Task All Project/_pipeline-runs.jsonl`.
- Run record (final, append-only): `{run_id, project, project_type, date, status:"running|done", commits, stages:[{name, ms, status}]}` where stage `status ∈ pass|fail|skip|running|pending`. Live "which step" is tracked in a separate `_pipeline-current.json` patched per stage transition; `_pipeline-runs.jsonl` stays append-only (one final record per run). Logging is added to `git-push-workflow/SKILL.md` now (independent of app code) so runs accumulate before the Phase 4 UI exists.
- **Dynamic columns = union of all stages across project types** (MBI/KAI/Personal have different stages). A stage not run for a given project type renders greyed-out/skip. This mirrors the reference Jenkins Stage View screenshot.
- Stage sets mapped from `git-push-workflow`:
  - **MBI:** status → review → best-practices → sonar → commit → push rdev → merge dev → merge prod
  - **KAI:** status → review → best-practices → commit → sonar → build → push rdev → merge development → tag
  - **Personal:** status → review → best-practices → sonar → branch → commit → push branch → merge main → delete branch
- Header shows average time per stage; rows show per-run duration + colour per status. Newest run on top.

---

## 11. Milestones

**Phase 1 (build first):**
- M1 — Scaffold: `pnpm create tauri-app` (React/Vite/TS); `pnpm tauri dev` opens window.
- M2 — Scan: `list_projects` returns the ~21 real projects, sorted by mtime, with kind badges + search.
- M3 — pi RPC bridge: spawn `pi --mode rpc`, strict-LF JSONL reader in Rust, forward events to webview.
- M4 — Chatbox: send prompt, stream `message_update`, render tool calls, approval dialogs.
- M5 — Controls + Settings: model/thinking switch, session resume, Settings screen (pi path, root, defaults).
- M6 — Reliability: drive-unmounted empty state, pi-crash handling, error toasts.

**Later phases:** Phase 2 (diff + worktree), Phase 3 (graphify), Phase 4 (kanban + pipeline).

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| RPC framing bug (Unicode line separators) | Strict LF-only splitter in Rust; explicit test with U+2028 inside a JSON string |
| pi not resolvable / PATH | Absolute pi path from settings, default to verified path |
| pi subprocess crash | Rust supervises; UI shows "agent stopped", offers restart; app never crashes |
| External drive unmounted | Empty state + clear message; no hard crash |
| Graph docs-rebuild cost surprise | Never auto docs-rebuild; badge + explicit user action |
| `graphify-out/` already committed | Detect via `git ls-files`; warn with `git rm --cached` fix |
| JSON write corruption (kanban) | Atomic temp→rename + `.bak` |
| Path traversal from webview | Server-side child-of-root validation |
| Two agents same worktree | One-writer-per-worktree guardrail |

## 13. External dependencies

- `pi` (`/Users/rifkioktapratama/.local/bin/pi`) — RPC engine. Verified.
- `graphify` (`/Users/rifkioktapratama/.local/bin/graphify`), Python 3.14.6 — Phase 3. Verified.
- `git` 2.50 — diff/worktree/pipeline. Verified.
- `git-push-workflow` skill — push/merge + pipeline logging (needs a small logging section added). Existing.
- `backlog-local` skill data — kanban source. Existing.
- Tauri v2 toolchain (node 22, pnpm 10, cargo/rustc 1.94). Verified.

## 14. Open questions

1. Kanban is per-project JSON today; when a project has no JSON yet, create on first task add or hide the board? (Proposed: create on first add.)
2. Pipeline logging edit to `git-push-workflow/SKILL.md` — do it as part of Phase 4, or add the logging section earlier so runs accumulate before the UI exists? (Proposed: add logging section early so data builds up.)
