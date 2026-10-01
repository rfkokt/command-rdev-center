<p align="center">
  <img src="public/kern-studio-icon.png" width="96" height="96" alt="Kern Studio logo" />
</p>

<h1 align="center">Kern Studio</h1>

<p align="center">
  A local-first AI developer workspace for running the
  <a href="https://github.com/badlogic/pi-mono">pi coding agent</a>
  across local projects.
</p>

Kern Studio brings project discovery, isolated task worktrees, native agent chat, local Deep Research, code review, Graphify context, Kanban tracking, and delivery-pipeline visibility into one focused desktop application.

## Workspace

- **Agent sessions** — run project-aware and global conversations from one desktop workspace.
- **Isolated work** — keep task changes separated in dedicated Git worktrees.
- **Review and delivery** — inspect diffs, monitor pipelines, and follow work through Kanban.
- **Local knowledge** — use Graphify and RAG context without duplicating project state in the cloud.
- **Deep Research** — create source-backed reports in a restricted, project-independent session.

## Deep Research

The global **Deep Research** dashboard runs one dedicated Pi session with a restricted tool allowlist of 11 tools: `web_search`, `source_check`, `fetch_content`, `get_search_content`, plus the `agent_reach_*` research tools (`agent_reach_status`, `agent_reach_web_read`, `agent_reach_github_search`, `agent_reach_youtube_search`, `agent_reach_youtube_transcript`, `agent_reach_rss_read`, `agent_reach_exa_search`). It cannot read projects, run shell commands, or mutate files. Progress, partial Markdown, source metadata, and completed reports are stored locally under the app's Application Support directory; queries and reports may contain sensitive information. Cancellation retains partial work. Runs interrupted by an app/process restart can resume from the exact Pi session when available, otherwise from a disclosed bounded checkpoint.

## Session Branches and Checkpoints

The session tree retains all branches using Pi's flat `get_entries` response. Forking is available on user messages only; it replaces the active transcript with that branch's history and restores the selected prompt as an editable draft.

Git-worktree chats await a best-effort checkpoint before dispatching each user message. Restoring a checkpoint restores the tracked snapshot, including removing tracked files added afterward, without changing HEAD, unrelated untracked files, or conversation history. File-picker results are cached for at most one second so nested file and ignore-rule changes become visible on the next lookup after expiry.

## Stack

- Tauri 2
- React 19 + TypeScript
- Vite 7
- Rust

## Requirements

- macOS on Apple Silicon
- Node.js 22+
- Rust toolchain
- `pi` CLI
- `git`
- `graphify` (optional, for knowledge graphs)

## Development

```bash
pnpm install
pnpm tauri dev
# or frontend only
pnpm dev
```

## Checks

```bash
pnpm test
pnpm run check:version  # cargo/tauri conf ↔ package.json sync
pnpm build              # check:version + tsc + vite build
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib # macOS backend tests
```

## Scripts

- `dev` — Vite dev server
- `test` — vitest run (jsdom)
- `check:version` — version sync gate
- `build` — gate + typecheck + bundle
- `preview` — serve build
- `tauri` — Tauri CLI proxy (`pnpm tauri dev/build`)

## Documentation

- [Product requirements](docs/PRD.md)
- [Project context and glossary](CONTEXT.md)
- [Architecture decisions](docs/adr/)

## Status

Under active development for a single-user, local-first workflow.

> The internal package name, bundle identifier, Application Support paths, and updater endpoint still use `command-rdev-center` for compatibility with existing installations.
