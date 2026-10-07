# Project coding workflow

Kern keeps Pi as the runtime. Project sessions load the task-verification extension after the formatter; global and Deep Research sessions do not load these project tools. This workflow requires Pi 1.0's `agent_before_settle`, `agent_settled`, and nested `executeTool` APIs.

## Response readability

Visible responses use short Markdown paragraphs, concise progress updates, and a final summary of findings and evidence. The runtime prompt applies these rules to both progress and final messages. The chat respects Pi's assistant `message_start` boundaries: distinct messages within a turn are separated by blank lines, while token chunks, cumulative snapshots, and final-event deduplication stay local to the current message. This preserves code blocks and earlier progress when a later response arrives without streaming deltas. Historical messages retain their original text.

Assistant text uses a 15px font, 1.8 line height, a 72-character reading measure, and separate paragraph/list spacing within the existing theme. These source changes require an app rebuild/relaunch; existing Pi sessions must restart to receive the updated response prompt.

## Task and completion evidence

The agent records the user's goal, acceptance criteria, and constraints with `set_task_contract`. It uses `run_check` for relevant validation, which first flushes queued formatting, then calls the existing bash tool through its normal permission hooks. The host records the real exit code and Git source fingerprints before and after the command. Commands that mutate source, fail, or are interrupted cannot count as successful evidence for the final source snapshot.

`report_task` records one assessment per criterion and an outcome:

- `checks_passed`: the latest attempt of every named check succeeds on the current source snapshot, all criteria have assessments, and no limitations were reported.
- `complete_with_limitations`: the agent describes what could not be verified or completed.
- `incomplete`: work remains, with an explicit explanation.

Passing commands establish execution evidence. The agent still chooses the checks and assesses the criteria; the host cannot establish semantic correctness from an exit code. Review the diff and the stated limitations. Missing Git history, fingerprint failures, or oversized source changes require an explicit limitation instead of a claim of verified checks.

Task metadata persists as custom entries in the Pi session's active branch and can be inspected with `/kern-task` without a model request. Resuming an unfinished task retains its criteria and constraints. Model guidance includes a bounded summary of recent checks rather than all recorded command text. Read-only requests with no source changes do not require a verification turn.

Before settlement, the host rechecks the reported source snapshot. Missing or stale evidence can request one corrective continuation. If evidence is still unavailable, it records an incomplete outcome. Aborted or failed runs never trigger that continuation. The frontend changes to idle and sends its completion notification only on `agent_settled`, after retry, compaction, and queued work; `agent_end` only finalizes that run's assistant output.

## Context compaction and recovery

The chat handles Pi 1.0 `compaction_start`/`compaction_end` events and legacy `auto_compaction_start`/`auto_compaction_end` events. Automatic overflow compaction keeps the task active through its retry; manual `/compact` displays its own running state, correlates the RPC response, and exposes errors even when no result payload/end event arrives. Aborting a turn to begin manual compaction does not mark that task complete. Drafts stay in the composer while manual compaction runs. Prompt preflight rejections are also surfaced immediately because no agent start/settlement events follow them. Failed or canceled compaction does not send a task-finished notification or advance its Kanban status.

The activity card, transcript, and context banner show summarization, elapsed time, and failure/cancellation. Runtime state is checked every ten seconds while compacting to recover from missed events. Polling replies do not count as model progress. Silent compaction is exempt from the normal two-minute provider inactivity limit; a separate five-minute deadline aborts a stalled attempt and exposes Retry compaction / Restart agent. An open input dialog pauses watchdog actions. Restart resumes the saved session file; it does not create a new context or discard chat history.

Context usage refreshes at turn completion and compaction completion. A successful compaction immediately clears stale context percentages; Pi may report usage as unknown until the next model response. The context dialog shows whether automatic compaction is enabled and allows manual compaction. A context warning appears at 90%; it does not override the user's automatic-compaction setting.

## Formatting and context

Successful write/edit calls queue supported source files. Repeated edits to one file are formatted once at the next bash command, `format_changed_files`, or final boundary. Prettier runs asynchronously, preferring the nearest project installation and using the bundled formatter as fallback. Memory, generated directories, minified files, and paths outside the workspace are excluded. Formatting that changes source at the final boundary requests at most one continuation to inspect and revalidate it. Failures are surfaced as warnings or limitations.

Graphify context queries have a five-second timeout per graph. Results are cached in memory by graph path, modification time, size, and task query. Continuation prompts reuse the previous task query without injecting the same context again; a different task or updated graph invalidates that reuse. Successful repositories still contribute context when another query fails. Branch navigation resets the cache. After compaction, cached orientation can be injected again on the next prompt. Graph provenance and truncation are disclosed, and graph results must be checked against current source.

## Checkpoints and memory

Idle prompt dispatch waits for a best-effort checkpoint. Failure appears as a toast and does not block the user's prompt. Active steering/follow-up dispatch does not checkpoint while the agent may be editing. Snapshots use a private temporary index and Git objects referenced by `refs/kern/checkpoints/<worktree-key>`. Creating one leaves the current branch and staging unchanged; duplicate content reuses its previous snapshot. Existing checkpoint commits in branch history remain readable. Explicit restore changes tracked files and staging while retaining HEAD and unrelated untracked files.

Per-chat `memory.md` is anchored under the repository's common Git metadata at `kern/memory/<worktree-key>.md`, excluded from Git, and symlinked into the checkout on macOS. Legacy checkout memory is migrated before normal or forced worktree removal. Recreating the same chat checkout restores its memory. The non-Unix fallback copies and synchronizes at setup/removal. Memory is scoped to the chat's checkout path within its repository; it is not automatically shared between chats or repositories. Renaming or relocating a checkout changes that key. Session metadata and memory remain local and are not automatically backed up remotely.

## Swagger discovery and task requirements

Before mapping a task to API calls, read `get_project_task` for the full description, notes, and references. The result identifies its file/cache source, update time, task ID, and revision. Local task files take precedence over cached previews; configured Sheets tasks use the Sheets cache. Duplicate IDs are errors. A failed Sheets refresh preserves the last good cache and records its failure instead of making tasks appear absent.

`api_find_operations` searches every loaded contract by operation ID, path, summary, description, tags, and parameter names. An empty query browses the full inventory; follow `hasMore` and `offset`. `refresh: true` refetches saved JSON document sources within the active session. Failed/stale documents and unresolved references make the inventory partial, so a missing search result cannot establish endpoint absence. `api_operation_detail` resolves the exact selector, inherited parameters, local `$ref` schemas, security definitions, and server overrides. Ambiguous or contradictory selectors require a more specific contract ID/method/path.

The loader reads every JSON document in a Swagger configuration or initializer dropdown. Relative server URLs, default server roots, server variables with defaults, and Swagger 2 `host`/`basePath` are supported. Documents up to 8 MB remain available to the tools. The prompt contains a compact outline rather than a partial endpoint list. Failed connectivity metadata retains the searchable document and reports the actual target-resolution issue. External references and YAML-only documents are disclosed as unavailable; they are not silently treated as missing endpoints.

`api_contract_test` resolves the selected operation before making a request. Missing path/query/header parameters, request bodies, and top-level body fields referenced through `$ref`/`allOf` are detected before transmission. JSON bodies, common scalar/array query serialization, private bearer/API-key header authentication, and configured localhost development APIs are supported. Tokens and mutation approval are scoped to their destination origin; initial anonymous requests never receive cached credentials. Other request media types or security mechanisms return a specific limitation while retaining the operation's identity.

API testing does not require frontend login or a browser host. Per-turn guidance directs the agent to the API tools and forbids searching workspace files/cookies for user tokens or generating JWTs. For prompts explicitly asking to test/call an API without UI verification, a tool-call guard blocks browser actions; explicit UI/browser requests allow them again. Continuation prompts retain the current scope, while new tasks and session/branch changes reset it.

If Swagger omits security, the first request carries no token. An unexpected `401` opens the private token dialog and retries once; a later challenged request can reuse that origin's token. `authenticated: true` requests authentication before transmission. Explicit `authenticated: false` and `expectedStatus: 401` preserve unauthorized test cases without opening the dialog. Canceling input reports `authentication_required`; a rejected retry reports `authentication_failed` without launching browser login. Collected tokens stay in memory and are not added to tool results.

Results distinguish blocked requests, HTTP failures, and undocumented/unexpected statuses. An explicit `expectedStatus` supports documented negative tests. Validation covers required inputs and documented HTTP status only: full response-schema validation and business assertions are marked `not_performed`. The agent must inspect the body and validate each task requirement before reporting a bug as fixed. The server/base-path behavior follows the [OpenAPI 3 server rules](https://spec.openapis.org/oas/v3.0.4.html#server-object) and [Swagger 2 host/base-path rules](https://spec.openapis.org/oas/v2.0.html#swagger-object).
