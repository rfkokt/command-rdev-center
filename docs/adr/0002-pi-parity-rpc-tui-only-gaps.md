# pi capability parity via RPC: three TUI-only gaps

The chatbox is the exact same pi agent — the engine is an identical `pi --mode rpc` process (models, tools, skills, extensions, sessions, compaction, retry, fork, steering all over RPC). Only the presentation (TUI → React chat UI) differs. However, three pi features are **TUI-only / absent from RPC** and are not merely a presentation difference:

1. **`/login` `/logout`** — RPC has no auth command. Credentials (API key/OAuth) must already be configured via env/config **before** spawning `pi --mode rpc`. Decision: auth via env, not built in the app.
2. **`@` file-reference (fuzzy search + inject path)** — TUI-only. Decision: **rebuilt** in the app (React file picker → insert path into the prompt text). This is the only gap we build.
3. **`/llama`, `/share`, `/import`, `/trust`, `/changelog`, `/hotkeys`, built-in `/settings`** — absent from RPC. Decision: **skipped** for now (not needed yet; `/settings`/keybindings are intentionally replaced by the app's own UI).

Consequence: the PRD §6.3 claim of "capability parity, presentation only" holds for the core, but must carry a note about these three gaps. `@` is in scope to build; auth is assumed already configured in the environment.
