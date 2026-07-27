# Graphify graph lives in-repo at the main checkout

The Graphify knowledge graph is stored in-repo at `<repo>/graphify-out/` (in the durable main checkout), not inside the ephemeral per-Chat worktree and not in a central cache like `~/.graphify/<repo>/`. Worktrees read the graph via absolute path; `--update` runs against main.

## Considered Options

- **Central cache (`~/.graphify/<repo>/`)** — keeps the repo perfectly clean, zero push risk. Rejected: it fights Graphify's native default (`graphify-out/graph.json` relative to cwd), so every invocation would need explicit `--graph`/`--out` flags, manual terminal queries wouldn't find the graph, and it requires a repo→dir mapping — reintroducing the app-owned state this project deliberately avoids (name collisions across drives, extra bookkeeping).
- **Per-worktree (`graphify-out/` in the worktree cwd)** — the naive default. Rejected: worktrees are ephemeral, so the graph is discarded and rebuilt (docs/LLM cost) every Session/Resume.
- **In-repo main checkout (chosen)** — matches Graphify's default and the global AGENTS.md contract (`graphify-out/graph.json`), no flags needed anywhere, survives worktree churn, manual `cd + graphify query` just works.

## Consequences

Push risk is covered by the two-layer gitignore (PRD §9.4). The graph is slightly stale for uncommitted worktree edits — accepted, since it is an orientation map refreshed after commit/branch-switch (PRD §9.3), not a live diff.
