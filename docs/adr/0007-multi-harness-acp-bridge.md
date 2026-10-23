# Multi-harness: pi RPC stays the UI protocol, ACP harnesses are bridged in Rust

Kern should run other coding agents (OpenCode, Claude Code, oh-my-pi, Codex, Gemini CLI, any ACP agent) besides pi, without forking the chat UI.

## Decision

**pi's RPC protocol remains Kern's internal agent protocol.** `ChatView` keeps sending pi commands and consuming pi events. Non-pi harnesses are spawned in **ACP mode** (Agent Client Protocol v1, JSON-RPC over stdio) and translated by `src-tauri/src/acp_bridge.rs`, a pure state machine with no process or Tauri access:

- UI → agent: `prompt`/`steer`/`follow_up` → `session/prompt`; `abort` → `session/cancel`; `set_model`/`set_thinking_level` → `session/set_config_option` (or the unstable `session/set_model`); `new_session` → `session/new`; `extension_ui_response` → the `session/request_permission` reply.
- Answered locally from bridge state: `get_state`, `get_available_models`, `get_messages`, `get_session_stats` (from `usage_update`), `get_commands` (from `available_commands_update`).
- Agent → UI: `agent_message_chunk`/`agent_thought_chunk` → `message_update` deltas; `tool_call`/`tool_call_update` → `tool_execution_start|update|end`; the `session/prompt` result → `message_end`, `agent_end`, `agent_settled`; `session/request_permission` → an `extension_ui_request` `select` dialog.
- Everything else (fork, session tree, compaction, steering modes, auto-retry) fails fast with a `success:false` response carrying the request id, so awaiting round-trips never hang.

`src-tauri/src/harness.rs` holds the harness registry (built-ins plus user-defined ACP commands) and the choice of harness per spawn. Settings live in `<app config>/harnesses.json` because `crc.config.json` is rewritten through a typed struct that drops unknown keys.

## Session identity and Resume

An ACP chat's `sessionFile` is `acp:<harness>:<sessionId>`. The UI already persists `sessionFile` per chat and passes it back on Resume, so the harness and session are recovered **without an app-owned mapping file** (keeping ADR-0001's principle). A saved ACP session always reopens in its own harness; a saved pi session stays on pi even if the default changes. If the agent lacks `loadSession` or the load fails, the bridge starts a new session and notifies the user instead of failing the chat.

## Why not a new normalized event model in the UI

`ChatView`'s `handleRaw` is ~700 lines tuned against pi semantics (settlement, compaction, queues, dedup of final messages). Rewriting it around a new `AgentEvent` union would re-open those edge cases for every harness. pi's protocol is the richest of the candidates, so it is a superset target: translating ACP into it at the Rust edge decouples the UI with no UI rewrite. Revisit if a harness needs concepts pi's protocol cannot express.

## Kern tools for ACP harnesses

`src-tauri/extensions/kern-mcp.mjs` is a zero-dependency MCP stdio server passed to every project chat in `session/new.mcpServers` (`node` from PATH). It mirrors the pi extension tools the UI reacts to — `track_kanban_task`, `list_project_tasks`, `get_project_task`, `report_recurring_error`, `recommend_global_skills`, `run_pipeline`, `provide_pipeline_input`, `control_pipeline` — with identical names, schemas and descriptions. The bridge strips adapter prefixes (`mcp__kern__…`, `kern_…`) and emits pi's `toolcall_start` once a call's arguments are known, so Kanban sync, pipeline approval and error-report flows behave exactly as with pi.

Worktree rules and the selected prompt engine (pi's `--append-system-prompt`) are sent as a `<kern-context>` block on the first prompt of each fresh ACP session; the stored history keeps the user's original text.

## Known gaps (ACP harnesses)

- Not yet ported: `task-verification`, `browser-tools`, `api-test`/OpenAPI, terminal tools, auto-format, Jev routing, Graphify context injection, and the pipeline workflow-policy prompt.
- Deep Research is always pi (it depends on pi's `--tools` allowlist).
- Fork, session tree, manual compaction and mid-turn steering are pi-only; `steer`/`follow_up` are queued until the turn settles. `/resume` only offers sessions from the same harness.
- Adapter stderr is filtered: only error-looking lines reach the chat; the rest goes to the app log.

## Model connections

`src-tauri/src/connections.rs` stores connection profiles (name, protocol — OpenAI Chat Completions, OpenAI Responses or Anthropic Messages — base URL, models) in `<app config>/connections.json`, with keys in the macOS Keychain. They are applied per harness:

| Harness | Mechanism |
|---|---|
| pi | `kern-<id>` providers in `~/.pi/agent/models.json` (all profiles) |
| oh-my-pi | `kern-<id>` providers in `~/.omp/agent/models.yml` (all profiles, only if installed) |
| OpenCode | `kern-<id>` providers via `OPENCODE_CONFIG_CONTENT` (all profiles); optional default model |
| Claude Code | `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/model aliases for the assigned Anthropic profile |
| Codex | `OPENAI_BASE_URL`/`OPENAI_API_KEY` for the assigned Responses profile (unverified against codex-acp) |

Config files only name an env var (`KERN_CONNECTION_<ID>_API_KEY`) that Kern sets when spawning agents, so keys never touch disk. Kern only rewrites `kern-*` provider entries, keeps a one-time `.kern-backup` of each file, and refuses to touch a file that does not parse. Model ids are `kern-<id>/<model>` in pi, oh-my-pi and OpenCode alike. Graphify can reuse an OpenAI-compatible profile instead of its own endpoint and key. Jev keeps its dedicated settings because it is a routing service, not a model provider.
