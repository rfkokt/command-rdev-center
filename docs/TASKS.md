# TASKS — command-rdev-center

Derived from PRD.md §5 (user stories) + ADR-0001..0004 + CONTEXT.md. Phase 1 is the only thing built first.

---

## User stories (PRD §5, MoSCoW)

### Phase 1 — launcher + chatbox
| ID | Pri | As me, I want… | Acceptance | Tasks |
|----|-----|----------------|------------|-------|
| US-1 | Must | searchable list of my real projects (`.git`/`package.json`/`Cargo.toml`/`pom.xml`), sorted by mtime, stack badges | list shows ~21 projects, sorted newest-first, badge per kind, search filters | M2 |
| US-2 | Must | open a project into a chatbox, send a message, `pi` streams the reply | prompt sent → tokens stream into chat, capability = native pi | M3, M4 |
| US-3 | Must | tool calls render live; dangerous-command approval as in-app Allow/Block dialog | read/bash/edit/write shown live; approval dialog appears, app never auto-resolves | M4 |
| US-4 | Must | clear state (not crash) if drive unmounts or `pi` exits | drive-detached freeze + reconnect; pi crash → "agent stopped" + restart | M6 |
| US-5 | Should | switch model + thinking level from UI mid-session | dropdowns populated via RPC; `set_model`/`set_thinking_level` apply without restart | M5 |
| US-6 | Should | sessions persist per project; resume last session | Resume recreates worktree + spawns pi against durable session; history returns | M5 |
| US-7 | Could | multiple project chats open at once (tabs) | ≥2 chats concurrent, background chat not killed on unfocus | M5 (guard), tabs deferred |

### Phase 1 included — worktree-per-Chat
| ID | Pri | Story | Acceptance | Tasks |
|----|-----|-------|------------|-------|
| US-8 | Must | each git Chat spawns own worktree+branch `crc/<slug>`; two Chats same repo don't collide | worktree at `.crc-worktrees/<repo>/<slug>`, distinct branches | M5 |
| US-9 | Must | pi cwd = worktree, never main checkout | verify cwd, main checkout untouched | M5 |
| US-10 | Must | close-with-no-changes auto-removes worktree; Resume recreates | empty worktree gone on close; Resume rebuilds identical slug | M5 |

### Phase 2 — diff viewer
| ID | Pri | Story |
|----|-----|-------|
| US-11 | Must | per-file diff (added/removed) of agent edits, git source of truth |
| US-12 | Should | live "currently editing X" indicator from tool events |
| US-13 | Should | hand off from diff view to `git-push-workflow` skill |

### Phase 3 — graphify
| ID | Pri | Story |
|----|-----|-------|
| US-14 | Must | build Graphify graph per project; agent gets `GRAPH_REPORT.md` on session start |
| US-15 | Must | `graphify-out/` + trace files gitignored, never pushed |
| US-16 | Should | graph auto-updates (code-only) after task / commit / branch switch |
| US-17 | Should | UI shows graph status none/fresh/stale + rebuild action for docs/LLM path |

### Phase 4 — kanban + pipeline
| ID | Pri | Story |
|----|-----|-------|
| US-18 | Should | Kanban reads `Task All Project/*.json`, columns by status, atomic write-back |
| US-19 | Should | pipeline stage-view of `git-push-workflow` runs, dynamic columns per project type, avg per stage |

### Won't (any phase)
cloud sync, multi-user, Windows/Linux, telemetry.

---

## Phase 1 — launcher + pi RPC chatbox + worktree (build now)

### M1 Scaffold (done)
- [x] `pnpm create tauri-app` → React/Vite/TS, structure per PRD §6.5  \n  → package `command-rdev-center`, product `Command rdev Center`, `crc_lib`, window 1200×800
- [x] `pnpm tauri dev` opens a window  \n  → Rust (`cargo build`) ✅ · FE (`pnpm build`) ✅ (Tauri dev binary verified builds)
- [x] Seed JSON config (ADR/CONTEXT branch C): pi path `/Users/rifkioktapratama/.local/bin/pi`, project root `/Volumes/ExternalM4/Project`, default model/thinking/provider  \n  → `src-tauri/crc.config.json` + `get_config` Tauri command + frontend smoke test

### M2 Project scan (`list_projects`)
- [x] `projects.rs`: scan project root (47 entries filtered -> 23 real), detect kind `.git`/`package.json`/`Cargo.toml`/`pom.xml` + go.mod, hidden dot skip (.crc-worktrees etc)
- [x] Sort by mtime, kind badges + search — ProjectList.tsx
- [x] Path validation: child-of-root canonical check
- [x] `ProjectList` renders real projects, searchable

### M3 pi RPC bridge (`pi_rpc.rs`)
- [x] Spawn `pi --mode rpc` absolute path, cwd=worktree/project, session map, kill handle — spawn_pi_rpc, send_pi_command (snake_case args, was camelCase bug fixed), kill_pi_session
- [x] **Strict LF-only** JSONL reader (not Node readline; strip CR; U+2028/U+2029 safe) — custom byte reader, 4 tests passing including literal U+2028 not split
- [x] Write prompt + extension_ui_response + set_model etc via stdin; read events stdout; forward via Tauri events pi-rpc-event/ended/error/stderr
- [x] U+2028 test: cargo test passes

### M4 Chatbox
- [x] ChatView streams message_update text_delta/thinking_delta, tool_execution_* phases, toolcall_* events; MAX_HISTORY 600, thinking collapsible
- [x] ToolCall component live rendering
- [x] ApprovalDialog select/confirm/input/editor, never auto-resolves, safe Block default — handles extension_ui_request
- [x] @ file picker files.rs fuzzy + FilePicker.tsx, inserts @relative path

### M5 Controls + worktree lifecycle
- [x] Model/thinking dropdowns populated via get_available_models + get_state; set_model/set_thinking_level mid-session no restart (US-5)
- [ ] Session resume across app/tab close: persist/recover the original slug, recreate its worktree, then load pi history (US-6)
- [x] worktree.rs central .crc-worktrees/<repo>/<slug> -b crc/<slug> parent resolution origin/HEAD fallback main/master/HEAD; slug unique per tab for US-8 concurrent no-collide
- [x] Non-git project -> spawn directly + not isolated badge
- [x] Auto-remove worktree when porcelain empty on close + toast; idle guard blocks close if streaming (US-10 + US-4 safety)
- [x] Background tabs hidden not killed — tabs mounted display:none, streaming preserved (US-7)

### M6 Reliability
- [x] Drive-unmounted: spawn and pi-exit checks detect missing cwd; ChatView freezes input and offers reconnect (US-4)
- [x] pi crash supervised: stdout thread emits pi-rpc-ended -> stopped badge + restart button, no app crash (US-4)
- [x] Toasts stack 6 auto-clear 6s for rpc errors/stderr/worktree events

## Later phases

### Phase 2 — diff viewer + worktree hardening
- [ ] `diff.rs`: record parent at worktree create (`origin/HEAD`, fallback `main`)
- [ ] Compute baseline `git merge-base crc/<slug> <parent>` (ADR-0004, never stored)
- [ ] `git diff <merge-base>...HEAD` (three-dot) + uncommitted `git diff` + `--staged`
- [ ] `git status --porcelain` for touched-files list
- [ ] Per-file diff UI: added/removed lines, collapsible (US-11)
- [ ] Live "currently editing X" from `toolcall_end` edit/write events (US-12)
- [ ] Hand off to `git-push-workflow` skill from diff panel (US-13)
- [ ] Worktree hardening: auto-cleanup empty, cross-device guard (same-drive only)

### Phase 3 — graphify
- [ ] `graph.rs`: build graph in-repo `<repo>/graphify-out/` (ADR-0003)
- [ ] First-open prompt "build graph?" (one-time full build) (US-14)
- [ ] Inject `GRAPH_REPORT.md` on session start via `--append-system-prompt`
- [ ] Write AGENTS.md navigation note (graphify query/path/explain via bash)
- [ ] Two-layer gitignore: per-project `graphify-out/` + opt-in global (asks first) (US-15)
- [ ] Detect already-tracked via `git ls-files graphify-out/`, warn `git rm -r --cached` (never silent)
- [ ] Auto `--update` (code-only) after task finish / commit / branch switch (US-16)
- [ ] Docs/PDF/image change → "graph stale (docs), rebuild?" badge only, no auto
- [ ] Graph status per project: none / fresh / stale + rebuild action (US-17)

### Phase 4 — kanban + pipeline
- [ ] Kanban reads `Task All Project/<project>.json`, columns by status (`Backlog→In Progress→Review→Done`, case-insensitive) (US-18)
- [ ] Filters by `pic`, project
- [ ] Atomic write-back: temp → `fsync` → rename + `.bak` before overwrite
- [ ] Reuse `backlog-local` skill data files (no separate store)
- [ ] Pipeline stage-view (Jenkins grid) from `_pipeline-runs.jsonl` (append-only) (US-19)
- [ ] `_pipeline-current.json` patched per stage for live "which step" indicator
- [ ] Dynamic stage columns per project type (MBI / KAI / Personal)
- [ ] Header avg time per stage; rows per-run duration + colour per status; newest on top

## Open questions (PRD §14)
- [ ] Kanban with no JSON yet: create on first task add, or hide board? (proposed: create on first add)
- [ ] Add pipeline-logging section to `git-push-workflow/SKILL.md` early (Phase 4 or sooner)?
