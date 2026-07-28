# Per-project isolation (registered + hard fence)

Every Chat is scoped to exactly one imported project (via `add_project`).
`crc.config.json` field `projects` is source of truth. `project_root` is legacy
base for `.crc-worktrees` location only.

Guard layers (both enforced):
1) **Tauri backend**: `ensure_path_allowed()` in `projects.rs`:
   - `find_owning_project(cwd)` — cwd itself is child of a registered project.
   - `find_owning_project_for_worktree(cwd)` — cwd under `.crc-worktrees/<safe_repo>/<slug>` maps back to owning project by repo dirname.
   Used by: `spawn_pi_rpc`, `ensure_worktree`, `remove_worktree`, `get_graph_status`,
   `get_git_fingerprint`, `search_files`, `get_pi_settings(project)`.

2) **pi extension hard fence**: `~/.pi/agent/extensions/crc-isolation/index.ts`
   Enabled only when `CRC_PROJECT_ROOT` env set (by this app's Tauri spawn).
   Hooks `tool_call` for bash/read/write/edit/ls/find/grep.
   - Extracts absolute paths from bash strings.
   - Blocks if target under `/Volumes/ExternalM4/Project/<other>` or sibling project dir
     not inside owning root.
   - System paths (/tmp, /usr, etc) and pi's own session dir allowed.

Rejected: using only `project_root=parent` with starts_with check — too permissive, allows project hopping.

Consequence: agent in Chat A can no longer `read ../../OtherService` unless OtherService
is same owning project or subdir. Cross-project work = open Chat for that project.
