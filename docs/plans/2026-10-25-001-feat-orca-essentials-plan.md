# Orca essentials for Kern

Status: active · Created: 2026-10-25 · Tasks: `docs/tasks/orca-essentials/task.json`

Kern ports the basic features it lacks from [Orca](https://github.com/stablyai/orca)
(MIT, © 2026 Lovecast Inc.), feature by feature. Orca is the most complete of the
four apps compared (Orca, CodexMonitor, AionUi, Emdash). Kern does **not** fork
Orca and does **not** add Orca's many-CLI terminal agents: the user ruled that out.

Shared doc with the comparison and rationale:
https://claude.ai/artifact/FfdgvdJu21ZUFpQAANheva

## Why port, not copy

| | Orca | Kern |
|---|---|---|
| Backend | Electron, Node (`node-pty`, `ssh2`) | Tauri, Rust |
| Frontend | React + zustand + Tailwind + Radix | React + plain CSS, no global store |
| Agent I/O | CLI in a PTY; transcript read back | Structured: pi RPC and ACP |
| Size | ~2M lines | ~50k lines |

Renderer logic can be adapted fairly directly; main-process logic is rewritten in
Rust. Orca reference paths in the task file are relative to Orca's `src/`
(a shallow clone was used at `/tmp/refs/orca`; re-clone with
`git clone --depth 1 https://github.com/stablyai/orca.git /tmp/refs/orca`).

## Attachment design (agreed with the user)

Every attachment is stored as a file in a per-chat attachment store and its path is
named in the prompt (Orca's model). Images additionally travel inline only to
models that read them:

| Model | Kern sends |
|---|---|
| Known to read images | Inline image + path |
| Unknown (e.g. `kern-9router/*`) | Inline + path; if the API rejects the image, resend path-only and tell the user |
| Known text-only | Path only; the chip says the model can't see images |

Capability sources: `input` in `~/.pi/agent/models.json` (pi) and
`agentCapabilities.promptCapabilities.image` (ACP, already read in
`acp_bridge.rs`, which today drops images silently when unsupported). Images are
downscaled before inline delivery (long edge 1568 px) and the chip shows an
estimated token cost (Claude: ≈ width × height / 750).

## Phases

1. **O0 Foundation** — attribution and capability metadata.
2. **O1 Composer** — attachment store, intake (drop/attach/paste), hybrid delivery,
   downscale + token estimate, prompt history, drafts, edit & resend.
3. **O2 Sessions & workflow** — rename/pin/archive, cross-session search, worktree
   setup config, sound + permission notifications.
4. **O3 Review** — diff line comments to the agent, PR + CI via `gh`.
5. **O4 Later** — command palette. (SSH, mobile, Design Mode stay out of scope.)

## Working rules for any agent picking this up

- Read `memory.md` (local, untracked) and this plan; pick the first task in
  `implementation_order` whose dependencies are `Done` and whose status is not `Done`.
- Set the task to `In Progress` when starting, `Review` when implemented and checked,
  and add a short `notes` entry on what landed and what is unverified. The user moves
  tasks to `Done` after trying them.
- Checks before `Review`: `pnpm exec tsc --noEmit -p .`, `pnpm exec vitest run`,
  `cargo check` and `cargo test --lib` in `src-tauri`, and `cargo fmt` on touched Rust.
  Setup in a fresh worktree: `pnpm install --frozen-lockfile` then
  `node scripts/prepare-browser-host.mjs`.
- Do not run prettier on `src/components/office/office-scene.ts` or
  `office-live.ts` (they are not prettier-formatted).
- Adapted Orca code gets a header comment `Adapted from stablyai/orca <path> (MIT)`
  and is listed in `THIRD_PARTY_NOTICES.md`.
- One commit per task, message `feat(<area>): …`; do not push to `main` without the
  user's go-ahead.
