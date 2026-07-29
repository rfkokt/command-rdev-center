# Command RDev Center

A local-first macOS desktop app for running the [`pi`](https://github.com/badlogic/pi-mono) coding agent across local projects.

Command RDev Center combines project discovery, isolated task worktrees, native agent chat, git diff review, Graphify context, Kanban tracking, and push-pipeline visibility in one Tauri app.

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
npm install
npm run tauri dev
```

## Checks

```bash
npm test
npm run build
```

## Documentation

- [Product requirements](docs/PRD.md)
- [Project context and glossary](CONTEXT.md)
- [Architecture decisions](docs/adr/)

## Status

Under active development for a single-user, local-first workflow.
