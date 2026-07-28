<!-- command-rdev-center:graphify -->
## Graphify gate (blocking)
For every new coding task, before any file search/read (`rg`, `grep`, `find`, `ls`, `read`, or Codebase Memory):
1. Check whether `graphify-out/graph.json` is fresh against `git HEAD`; run `graphify update .` if stale.
2. Run `graphify query "<the user's task>"`.
3. Only then inspect the returned files/symbols.
Do not skip this gate for small tasks. Use `graphify path "A" "B"` or `graphify explain "X"` when needed.
<!-- /command-rdev-center:graphify -->
