//! ACP (Agent Client Protocol v1) ↔ pi RPC bridge.
//!
//! Kern's chat UI speaks pi's RPC protocol (see ADR-0007). Non-pi harnesses
//! (OpenCode, Claude Code, oh-my-pi, Codex, …) are driven over ACP instead, and
//! this module translates between the two so the UI does not need to know
//! which harness is running:
//!
//! * UI → bridge: pi RPC commands (`prompt`, `abort`, `get_state`, `set_model`, …)
//!   become ACP JSON-RPC requests, or are answered locally from bridge state.
//! * agent → bridge: ACP `session/update` notifications become pi-shaped events
//!   (`agent_start`, `message_update`, `tool_execution_*`, `agent_settled`, …).
//!
//! The bridge is a pure state machine: it never touches processes or Tauri.
//! Callers feed it lines and dispatch the returned [`Out`] values.

use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};

/// ACP protocol version this client implements.
pub const ACP_PROTOCOL_VERSION: u64 = 1;

/// `sessionFile` values for ACP chats look like `acp:<harness>:<sessionId>`.
/// The UI already persists `sessionFile` per chat and hands it back on Resume,
/// so this keeps Resume working without an app-owned mapping file.
const SESSION_FILE_PREFIX: &str = "acp:";

pub fn session_file_for(harness: &str, session_id: &str) -> String {
    format!("{SESSION_FILE_PREFIX}{harness}:{session_id}")
}

/// Returns `(harness, acp_session_id)` for an ACP session file reference.
pub fn parse_session_file(path: &str) -> Option<(&str, &str)> {
    let (harness, session) = path.strip_prefix(SESSION_FILE_PREFIX)?.split_once(':')?;
    (!harness.is_empty() && !session.is_empty()).then_some((harness, session))
}

#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    /// One JSON-RPC line for the ACP agent's stdin.
    Agent(String),
    /// One pi-RPC-shaped line for the UI (`pi-rpc-event`).
    Ui(String),
    /// Unrecoverable failure (`pi-rpc-error`).
    Fatal(String),
}

#[derive(Debug)]
enum Pending {
    Initialize,
    NewSession {
        pi_id: Option<Value>,
    },
    LoadSession,
    Prompt,
    /// `auto`: started by the context threshold, not by the user.
    Compact {
        pi_id: Option<Value>,
        auto: bool,
    },
    SetModel {
        pi_id: Option<Value>,
        value: String,
    },
    SetThinking {
        pi_id: Option<Value>,
        value: String,
    },
}

#[derive(Default)]
struct Turn {
    /// Text and thinking of the open assistant message (segment).
    text: String,
    thinking: String,
    used_tool: bool,
    /// An ACP turn is one prompt, but pi emits one assistant message per model
    /// call. Text before a tool call closes the segment so the UI separates
    /// it from the text that follows, as it does for pi.
    closed: Vec<Value>,
    segment_closed: bool,
}

struct PermissionRequest {
    rpc_id: Value,
    /// `(display name, optionId, kind)`
    options: Vec<(String, String, String)>,
}

pub struct AcpBridge {
    harness: String,
    cwd: String,
    mcp_servers: Value,
    resume: Option<String>,
    initial_model: Option<String>,
    next_id: u64,
    pending: HashMap<u64, Pending>,
    session_id: Option<String>,
    ready: bool,
    load_supported: bool,
    image_supported: bool,
    /// `initialize` answered, so `image_supported` is the agent's own answer.
    capabilities_known: bool,
    /// UI commands received before the ACP session exists.
    waiting: VecDeque<Value>,
    /// Prompts sent while a turn is running (ACP has no mid-turn steering).
    queued_prompts: VecDeque<(String, Vec<Value>)>,
    turn: Option<Turn>,
    replaying: bool,
    history: Vec<Value>,
    tools: HashMap<String, (String, Value)>,
    /// Tool calls already announced with a pi `toolcall_start` (needs args).
    announced: std::collections::HashSet<String>,
    permissions: HashMap<String, PermissionRequest>,
    seq: u64,
    config_options: Vec<Value>,
    /// Unstable ACP `models` state (`{currentModelId, availableModels}`), used
    /// by adapters that do not expose a `model` config option.
    legacy_models: Option<Value>,
    commands: Vec<Value>,
    usage: Option<(u64, u64)>,
    /// Cumulative `PromptResponse.usage` (inputTokens, cachedReadTokens, …).
    tokens: Option<Value>,
    /// Last request size, not cumulative turn/session usage.
    request_tokens: Option<u64>,
    /// Threshold compaction failed or is unavailable for this context; stop
    /// retrying it (and never hold prompts back) until a compaction succeeds.
    auto_compact_off: bool,
    /// Session cost in USD when the adapter reports it (`usage_update.cost`).
    cost: Option<f64>,
    /// A `/compact` prompt is running; user prompts wait for it.
    compacting: bool,
    /// Kern context (worktree rules, prompt engine) that pi receives via
    /// `--append-system-prompt`. ACP has no system-prompt field, so it rides
    /// along with the first prompt of each fresh session.
    preamble: Option<String>,
    preamble_pending: bool,
    /// Answer `session/request_permission` with an allow option instead of
    /// asking the user (global "Auto-approve" setting).
    auto_approve: bool,
}

fn line(value: Value) -> String {
    value.to_string()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn content_text(block: &Value) -> Option<&str> {
    (block.get("type").and_then(Value::as_str) == Some("text"))
        .then(|| block.get("text").and_then(Value::as_str))
        .flatten()
}

/// Tools served by Kern's MCP server (`extensions/kern-mcp.mjs`). The chat UI
/// reacts to these by bare name, so adapter prefixes are stripped.
pub const KERN_TOOLS: &[&str] = &[
    "track_kanban_task",
    "list_project_tasks",
    "get_project_task",
    "api_find_operations",
    "api_operation_detail",
    "report_recurring_error",
    "recommend_global_skills",
    "run_pipeline",
    "complete_pr_review",
    "provide_pipeline_input",
    "control_pipeline",
];

/// `mcp__kern__run_pipeline` (Claude Code), `kern_run_pipeline` (OpenCode),
/// `kern.run_pipeline`, … → `run_pipeline`.
fn kern_tool_name(candidate: &str) -> Option<&'static str> {
    KERN_TOOLS.iter().copied().find(|tool| {
        candidate == *tool
            || candidate
                .strip_suffix(tool)
                .is_some_and(|prefix| prefix.to_ascii_lowercase().contains("kern"))
    })
}

/// Pi renders tools by name (`bash`, `read`, `edit`, …). ACP gives a `kind`
/// plus a human title; prefer an explicit tool name when the adapter sends one.
fn tool_name(update: &Value) -> String {
    for field in ["name", "title"] {
        if let Some(tool) = update
            .get(field)
            .and_then(Value::as_str)
            .and_then(kern_tool_name)
        {
            return tool.to_string();
        }
    }
    if let Some(name) = update.get("name").and_then(Value::as_str) {
        if !name.is_empty() {
            return name.to_string();
        }
    }
    match update.get("kind").and_then(Value::as_str) {
        Some("execute") => "bash".into(),
        Some("read") => "read".into(),
        Some("edit") => "edit".into(),
        Some("delete") => "delete".into(),
        Some("move") => "move".into(),
        Some("search") => "grep".into(),
        Some("fetch") => "fetch".into(),
        Some("think") => "think".into(),
        _ => update
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| !title.is_empty())
            .unwrap_or("tool")
            .to_string(),
    }
}

/// Normalise common adapter argument spellings to the ones pi's tool cards read.
fn tool_args(update: &Value) -> Value {
    let mut args = match update.get("rawInput") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    for alias in ["file_path", "filePath", "abs_path"] {
        if !args.contains_key("path") {
            if let Some(path) = args.get(alias).cloned() {
                args.insert("path".into(), path);
            }
        }
    }
    if !args.contains_key("path") {
        if let Some(path) = update.pointer("/locations/0/path").and_then(Value::as_str) {
            args.insert("path".into(), json!(path));
        }
    }
    if let Some(title) = update.get("title").and_then(Value::as_str) {
        args.entry("title").or_insert_with(|| json!(title));
    }
    Value::Object(args)
}

fn tool_result_text(update: &Value) -> String {
    let mut parts = Vec::new();
    if let Some(items) = update.get("content").and_then(Value::as_array) {
        for item in items {
            match item.get("type").and_then(Value::as_str) {
                Some("content") => {
                    if let Some(text) = item.get("content").and_then(content_text) {
                        parts.push(text.to_string());
                    }
                }
                Some("diff") => {
                    let path = item.get("path").and_then(Value::as_str).unwrap_or("file");
                    parts.push(format!("Edited {path}"));
                }
                Some("terminal") => {
                    let id = item.get("terminalId").and_then(Value::as_str).unwrap_or("");
                    parts.push(format!("[terminal {id}]"));
                }
                _ => {}
            }
        }
    }
    if parts.is_empty() {
        match update.get("rawOutput") {
            Some(Value::String(text)) => parts.push(text.clone()),
            Some(Value::Null) | None => {}
            Some(other) => parts.push(other.to_string()),
        }
    }
    parts.join("\n")
}

fn flatten_select_options(option: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let Some(items) = option.get("options").and_then(Value::as_array) {
        for item in items {
            if let Some(nested) = item.get("options").and_then(Value::as_array) {
                for entry in nested {
                    if let Some(value) = entry.get("value").and_then(Value::as_str) {
                        let name = entry.get("name").and_then(Value::as_str).unwrap_or(value);
                        out.push((value.to_string(), name.to_string()));
                    }
                }
            } else if let Some(value) = item.get("value").and_then(Value::as_str) {
                let name = item.get("name").and_then(Value::as_str).unwrap_or(value);
                out.push((value.to_string(), name.to_string()));
            }
        }
    }
    out
}

fn stop_reason(acp: &str) -> &'static str {
    match acp {
        "end_turn" => "stop",
        "max_tokens" | "max_turn_requests" => "length",
        "cancelled" => "aborted",
        _ => "error",
    }
}

impl AcpBridge {
    pub fn new(
        harness: impl Into<String>,
        cwd: impl Into<String>,
        mcp_servers: Value,
        resume: Option<String>,
        initial_model: Option<String>,
    ) -> Self {
        Self {
            harness: harness.into(),
            cwd: cwd.into(),
            mcp_servers,
            resume,
            initial_model,
            next_id: 1,
            pending: HashMap::new(),
            session_id: None,
            ready: false,
            load_supported: false,
            image_supported: false,
            capabilities_known: false,
            waiting: VecDeque::new(),
            queued_prompts: VecDeque::new(),
            turn: None,
            replaying: false,
            history: Vec::new(),
            tools: HashMap::new(),
            announced: std::collections::HashSet::new(),
            permissions: HashMap::new(),
            seq: 0,
            config_options: Vec::new(),
            legacy_models: None,
            commands: Vec::new(),
            usage: None,
            tokens: None,
            request_tokens: None,
            auto_compact_off: false,
            cost: None,
            compacting: false,
            preamble: None,
            preamble_pending: false,
            auto_approve: false,
        }
    }

    pub fn with_preamble(mut self, preamble: Option<String>) -> Self {
        self.preamble = preamble.filter(|text| !text.trim().is_empty());
        self
    }

    pub fn set_auto_approve(&mut self, enabled: bool) {
        self.auto_approve = enabled;
    }

    // ---------------------------------------------------------------- output

    fn request(&mut self, method: &str, params: Value, pending: Pending) -> Out {
        let id = self.next_id;
        self.next_id += 1;
        self.pending.insert(id, pending);
        Out::Agent(line(
            json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        ))
    }

    fn notify(method: &str, params: Value) -> Out {
        Out::Agent(line(
            json!({ "jsonrpc": "2.0", "method": method, "params": params }),
        ))
    }

    fn ui(value: Value) -> Out {
        Out::Ui(line(value))
    }

    fn respond(command: &str, id: Option<&Value>, data: Option<Value>) -> Out {
        let mut value = json!({ "type": "response", "command": command, "success": true });
        if let Some(id) = id {
            value["id"] = id.clone();
        }
        if let Some(data) = data {
            value["data"] = data;
        }
        Self::ui(value)
    }

    fn fail(command: &str, id: Option<&Value>, error: impl Into<String>) -> Out {
        let mut value = json!({ "type": "response", "command": command, "success": false, "error": error.into() });
        if let Some(id) = id {
            value["id"] = id.clone();
        }
        Self::ui(value)
    }

    fn next_seq(&mut self, prefix: &str) -> String {
        self.seq += 1;
        format!("{prefix}-{}", self.seq)
    }

    // ------------------------------------------------------------- lifecycle

    /// First frames to send once the agent process is running.
    pub fn start(&mut self) -> Vec<Out> {
        vec![self.request(
            "initialize",
            json!({
                "protocolVersion": ACP_PROTOCOL_VERSION,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false
                },
                "clientInfo": { "name": "kern-studio", "version": env!("CARGO_PKG_VERSION") }
            }),
            Pending::Initialize,
        )]
    }

    pub fn session_file(&self) -> Option<String> {
        self.session_id
            .as_deref()
            .map(|id| session_file_for(&self.harness, id))
    }

    fn model_option(&self) -> Option<&Value> {
        self.config_options.iter().find(|option| {
            option.get("category").and_then(Value::as_str) == Some("model")
                || option.get("id").and_then(Value::as_str) == Some("model")
        })
    }

    fn thinking_option(&self) -> Option<&Value> {
        self.config_options
            .iter()
            .find(|option| option.get("category").and_then(Value::as_str) == Some("thought_level"))
    }

    fn available_models(&self) -> Vec<(String, String)> {
        if let Some(option) = self.model_option() {
            return flatten_select_options(option);
        }
        self.legacy_models
            .as_ref()
            .and_then(|models| models.get("availableModels"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let id = item.get("modelId").and_then(Value::as_str)?;
                        let name = item.get("name").and_then(Value::as_str).unwrap_or(id);
                        Some((id.to_string(), name.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn current_model(&self) -> Option<String> {
        if let Some(option) = self.model_option() {
            return option
                .get("currentValue")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        self.legacy_models
            .as_ref()
            .and_then(|models| models.get("currentModelId"))
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    /// Accepts `model`, `provider/model`, or `<harness>/model` and returns the
    /// matching ACP model value, if the harness offers it.
    fn resolve_model(&self, requested: &str) -> Option<String> {
        let models = self.available_models();
        let stripped = requested
            .strip_prefix(&format!("{}/", self.harness))
            .unwrap_or(requested);
        for candidate in [requested, stripped] {
            if let Some((value, _)) = models.iter().find(|(value, _)| value == candidate) {
                return Some(value.clone());
            }
        }
        // `anthropic/claude-x` → harness offers `claude-x`.
        let tail = stripped.rsplit('/').next().unwrap_or(stripped);
        models
            .iter()
            .find(|(value, _)| value == tail || value.ends_with(&format!("/{tail}")))
            .map(|(value, _)| value.clone())
    }

    fn set_model_request(&mut self, value: String, pi_id: Option<Value>) -> Option<Out> {
        let session_id = self.session_id.clone()?;
        if let Some(config_id) = self
            .model_option()
            .and_then(|option| option.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string)
        {
            return Some(self.request(
                "session/set_config_option",
                json!({ "sessionId": session_id, "configId": config_id, "value": value }),
                Pending::SetModel { pi_id, value },
            ));
        }
        self.legacy_models.as_ref()?;
        Some(self.request(
            "session/set_model",
            json!({ "sessionId": session_id, "modelId": value }),
            Pending::SetModel { pi_id, value },
        ))
    }

    fn state_data(&self) -> Value {
        let mut data = json!({
            "isStreaming": self.turn.is_some(),
            "isCompacting": false,
            "harness": self.harness,
            "pendingMessageCount": self.queued_prompts.len(),
            // ACP: an agent that omits promptCapabilities.image cannot take images.
            "imageInput": if self.capabilities_known { json!(self.image_supported) } else { Value::Null },
        });
        if let Some(file) = self.session_file() {
            data["sessionFile"] = json!(file);
            data["sessionId"] = json!(self.session_id);
        }
        if let Some(model) = self.current_model() {
            data["model"] = json!({ "provider": self.harness, "id": model });
        }
        if let Some(level) = self
            .thinking_option()
            .and_then(|option| option.get("currentValue"))
            .and_then(Value::as_str)
        {
            data["thinkingLevel"] = json!(level);
        }
        data
    }

    fn queue_update(&self) -> Out {
        let follow_up: Vec<Value> = self
            .queued_prompts
            .iter()
            .map(|(text, _)| json!(text))
            .collect();
        Self::ui(json!({ "type": "queue_update", "steering": [], "followUp": follow_up }))
    }

    // ------------------------------------------------------------ UI → agent

    /// Handle one pi RPC command line from the UI.
    pub fn on_ui(&mut self, raw: &str) -> Vec<Out> {
        let Ok(command) = serde_json::from_str::<Value>(raw) else {
            return vec![Out::Ui(line(json!({
                "type": "response", "command": "parse", "success": false,
                "error": "invalid JSON command"
            })))];
        };
        if !self.ready {
            // Permission answers can arrive while a session/load replay is
            // still running; everything else waits for the session.
            if command.get("type").and_then(Value::as_str) != Some("extension_ui_response") {
                self.waiting.push_back(command);
                return Vec::new();
            }
        }
        self.handle_command(command)
    }

    fn handle_command(&mut self, command: Value) -> Vec<Out> {
        let kind = command
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let id = command.get("id").cloned();
        let id = id.as_ref();
        let message = command
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let images = command
            .get("images")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        match kind.as_str() {
            "prompt" => {
                if self.compacting {
                    self.queued_prompts.push_back((message, images));
                    return vec![Self::respond("prompt", id, None), self.queue_update()];
                }
                if self.turn.is_some() {
                    if command.get("streamingBehavior").is_some() {
                        self.queued_prompts.push_back((message, images));
                        return vec![Self::respond("prompt", id, None), self.queue_update()];
                    }
                    return vec![Self::fail(
                        "prompt",
                        id,
                        "Agent is already processing. Wait for it to finish or stop it first.",
                    )];
                }
                let mut out = vec![Self::respond("prompt", id, None)];
                out.extend(self.start_prompt(message, images));
                out
            }
            "steer" | "follow_up" => {
                if self.turn.is_some() || self.compacting {
                    // ACP cannot inject into a running turn: deliver after it settles.
                    self.queued_prompts.push_back((message, images));
                    return vec![Self::respond(&kind, id, None), self.queue_update()];
                }
                let mut out = vec![Self::respond(&kind, id, None)];
                out.extend(self.start_prompt(message, images));
                out
            }
            "abort" => {
                let mut out = Vec::new();
                for (_, request) in self.permissions.drain() {
                    out.push(Out::Agent(line(json!({
                        "jsonrpc": "2.0", "id": request.rpc_id,
                        "result": { "outcome": { "outcome": "cancelled" } }
                    }))));
                }
                self.queued_prompts.clear();
                if self.turn.is_some() || self.compacting {
                    if let Some(session_id) = self.session_id.clone() {
                        out.push(Self::notify(
                            "session/cancel",
                            json!({ "sessionId": session_id }),
                        ));
                    }
                }
                out.push(Self::respond("abort", id, None));
                out
            }
            "extension_ui_response" => self.answer_permission(&command),
            "get_state" => vec![Self::respond("get_state", id, Some(self.state_data()))],
            "get_available_models" => {
                let models: Vec<Value> = self
                    .available_models()
                    .into_iter()
                    .map(|(value, name)| json!({ "provider": self.harness, "id": value, "name": name }))
                    .collect();
                vec![Self::respond(
                    "get_available_models",
                    id,
                    Some(json!({ "models": models })),
                )]
            }
            "set_model" => {
                let model_id = command.get("modelId").and_then(Value::as_str).unwrap_or("");
                let requested = match command.get("provider").and_then(Value::as_str) {
                    Some(provider) if !provider.is_empty() => format!("{provider}/{model_id}"),
                    _ => model_id.to_string(),
                };
                let Some(value) = self.resolve_model(&requested) else {
                    return vec![Self::fail(
                        "set_model",
                        id,
                        format!(
                            "Model {requested} is not offered by the {} harness",
                            self.harness
                        ),
                    )];
                };
                match self.set_model_request(value, id.cloned()) {
                    Some(out) => vec![out],
                    None => vec![Self::fail(
                        "set_model",
                        id,
                        format!(
                            "The {} harness does not support model selection",
                            self.harness
                        ),
                    )],
                }
            }
            "set_thinking_level" => {
                let level = command.get("level").and_then(Value::as_str).unwrap_or("");
                let target = self.thinking_option().and_then(|option| {
                    let config_id = option.get("id").and_then(Value::as_str)?.to_string();
                    flatten_select_options(option)
                        .into_iter()
                        .find(|(value, name)| value == level || name.eq_ignore_ascii_case(level))
                        .map(|(value, _)| (config_id, value))
                });
                match (target, self.session_id.clone()) {
                    (Some((config_id, value)), Some(session_id)) => {
                        vec![self.request(
                        "session/set_config_option",
                        json!({ "sessionId": session_id, "configId": config_id, "value": value }),
                        Pending::SetThinking { pi_id: id.cloned(), value },
                    )]
                    }
                    _ => vec![Self::fail(
                        "set_thinking_level",
                        id,
                        format!(
                            "Thinking level {level} is not offered by the {} harness",
                            self.harness
                        ),
                    )],
                }
            }
            "get_messages" => vec![Self::respond(
                "get_messages",
                id,
                Some(json!({ "messages": self.history })),
            )],
            "get_session_stats" => match self.session_stats() {
                Some(stats) => vec![Self::respond("get_session_stats", id, Some(stats))],
                None => vec![Self::fail(
                    "get_session_stats",
                    id,
                    "usage not reported yet",
                )],
            },
            "compact" => self.compact(id),
            "get_commands" => {
                let commands: Vec<Value> = self
                    .commands
                    .iter()
                    .filter_map(|command| {
                        let name = command.get("name").and_then(Value::as_str)?;
                        Some(json!({
                            "name": name,
                            "description": command.get("description").cloned().unwrap_or(Value::Null),
                            "source": self.harness,
                        }))
                    })
                    .collect();
                vec![Self::respond(
                    "get_commands",
                    id,
                    Some(json!({ "commands": commands })),
                )]
            }
            "new_session" => {
                if self.turn.is_some() {
                    return vec![Self::fail("new_session", id, "Stop the running turn first")];
                }
                self.history.clear();
                self.usage = None;
                self.tokens = None;
                self.request_tokens = None;
                self.auto_compact_off = false;
                self.cost = None;
                self.ready = false;
                vec![self.request(
                    "session/new",
                    json!({ "cwd": self.cwd, "mcpServers": self.mcp_servers }),
                    Pending::NewSession { pi_id: id.cloned() },
                )]
            }
            other => vec![Self::fail(
                if other.is_empty() { "unknown" } else { other },
                id,
                format!("`{other}` is not supported by the {} harness", self.harness),
            )],
        }
    }

    /// pi-shaped `get_session_stats` data from ACP usage reports.
    fn session_stats(&self) -> Option<Value> {
        if self.usage.is_none() && self.tokens.is_none() {
            return None;
        }
        let count = |key: &str| {
            self.tokens
                .as_ref()
                .and_then(|tokens| tokens.get(key))
                .and_then(Value::as_u64)
                .unwrap_or(0)
        };
        let (input, output) = (count("inputTokens"), count("outputTokens"));
        let (cache_read, cache_write) = (count("cachedReadTokens"), count("cachedWriteTokens"));
        let total = match count("totalTokens") {
            0 => input + output + cache_read + cache_write,
            total => total,
        };
        let mut stats = json!({
            "tokens": {
                "input": input, "output": output,
                "cacheRead": cache_read, "cacheWrite": cache_write,
                "total": if total == 0 { self.usage.map_or(0, |(used, _)| used) } else { total }
            }
        });
        if let Some((used, size)) = self
            .usage
            .or_else(|| self.request_tokens.map(|used| (used, 0)))
        {
            let percent = if size > 0 {
                (used as f64 / size as f64) * 100.0
            } else {
                0.0
            };
            stats["contextUsage"] =
                json!({ "tokens": used, "contextWindow": size, "percent": percent });
        }
        if let Some(cost) = self.cost {
            stats["cost"] = json!(cost);
        }
        Some(stats)
    }

    /// ACP has no compaction method, but Claude Code, Codex and others offer
    /// a `/compact` slash command; run it as a hidden prompt.
    fn compact(&mut self, id: Option<&Value>) -> Vec<Out> {
        self.compact_as(id, false)
    }

    fn compact_as(&mut self, id: Option<&Value>, auto: bool) -> Vec<Out> {
        if self.turn.is_some() || self.compacting {
            return vec![Self::fail("compact", id, "Stop the running turn first")];
        }
        let Some(session_id) = self.session_id.clone() else {
            return vec![Self::fail("compact", id, "Session is not ready yet")];
        };
        let command = ["compact", "summarize"].into_iter().find(|name| {
            self.commands
                .iter()
                .any(|command| command.get("name").and_then(Value::as_str) == Some(name))
        });
        let Some(command) = command else {
            return vec![Self::fail(
                "compact",
                id,
                format!("The {} harness does not offer compaction", self.harness),
            )];
        };
        self.compacting = true;
        vec![
            Self::ui(
                json!({ "type": "compaction_start", "reason": if auto { "threshold" } else { "manual" } }),
            ),
            self.request(
                "session/prompt",
                json!({
                    "sessionId": session_id,
                    "prompt": [{ "type": "text", "text": format!("/{command}") }]
                }),
                Pending::Compact {
                    pi_id: id.cloned(),
                    auto,
                },
            ),
        ]
    }

    fn start_prompt(&mut self, message: String, images: Vec<Value>) -> Vec<Out> {
        let threshold = crate::harness::compact_threshold(&self.harness);
        let used = self
            .request_tokens
            .or_else(|| self.usage.map(|(used, _)| used));
        let mut notice = Vec::new();
        if self.turn.is_none()
            && !self.compacting
            && !self.auto_compact_off
            && used.is_some_and(|used| used >= threshold)
        {
            let out = self.compact_as(None, true);
            if self.compacting {
                // Runs right after compaction, ahead of anything queued later.
                self.queued_prompts.push_front((message, images));
                return out;
            }
            // No compaction in this agent (or not ready): say so once and
            // send anyway — the user's prompt is never held back.
            self.auto_compact_off = true;
            notice.push(Self::ui(json!({"type":"message_end", "message": {
                "role":"custom", "customType":"kern-context-threshold", "display":true,
                "content": format!("Context is over the {threshold}-token threshold, but {} cannot compact here. Consider a new chat with a summary.", self.harness)
            }})));
        }
        let Some(session_id) = self.session_id.clone() else {
            return vec![Self::fail("prompt", None, "ACP session is not ready")];
        };
        let omitted_images = !self.image_supported && !images.is_empty();
        let message = if omitted_images {
            format!("{message}\n\nThis agent cannot receive inline images. They were omitted; use the saved attachment paths above if available. Do not assume their visual contents.")
        } else {
            message
        };
        let mut user_content = vec![json!({ "type": "text", "text": message })];
        let sent = match (&self.preamble, self.preamble_pending) {
            (Some(preamble), true) => {
                self.preamble_pending = false;
                format!(
                    "<kern-context>\n{}\n</kern-context>\n\n{message}",
                    preamble.trim()
                )
            }
            _ => message,
        };
        let mut blocks = vec![json!({ "type": "text", "text": sent })];
        for image in images {
            let (Some(data), Some(mime)) = (
                image.get("data").and_then(Value::as_str),
                image.get("mimeType").and_then(Value::as_str),
            ) else {
                continue;
            };
            let block = json!({ "type": "image", "data": data, "mimeType": mime });
            user_content.push(block.clone());
            if self.image_supported {
                blocks.push(block);
            }
        }
        let user_id = self.next_seq("acp-user");
        self.history.push(json!({
            "id": user_id,
            "role": "user",
            "content": user_content,
            "timestamp": now_ms(),
        }));
        self.turn = Some(Turn::default());
        self.tools.clear();
        self.announced.clear();
        let mut out = notice;
        out.push(self.request(
            "session/prompt",
            json!({ "sessionId": session_id, "prompt": blocks }),
            Pending::Prompt,
        ));
        // The notice lands before the assistant turn opens: appended after
        // message_start it would sit below the streaming bubble and make the
        // next delta open a second, empty assistant bubble.
        if omitted_images {
            out.push(Self::ui(json!({"type":"message_end", "message": {
                "role":"custom", "customType":"kern-image-fallback", "display":true,
                "content":"This agent cannot receive inline images. Only the attachment text and saved paths were sent."
            }})));
        }
        out.push(Self::ui(json!({ "type": "agent_start" })));
        out.push(Self::ui(
            json!({ "type": "message_start", "message": { "role": "assistant" } }),
        ));
        out
    }

    fn answer_permission(&mut self, command: &Value) -> Vec<Out> {
        let Some(ui_id) = command.get("id").and_then(Value::as_str) else {
            return Vec::new();
        };
        let Some(request) = self.permissions.remove(ui_id) else {
            return Vec::new();
        };
        let find_kind = |prefix: &str| {
            request
                .options
                .iter()
                .find(|(_, _, kind)| kind.starts_with(prefix))
                .map(|(_, option_id, _)| option_id.clone())
        };
        let chosen = if command.get("cancelled").and_then(Value::as_bool) == Some(true) {
            None
        } else if let Some(value) = command.get("value").and_then(Value::as_str) {
            request
                .options
                .iter()
                .find(|(name, option_id, _)| name == value || option_id == value)
                .map(|(_, option_id, _)| option_id.clone())
        } else {
            match command.get("confirmed").and_then(Value::as_bool) {
                Some(true) => find_kind("allow"),
                Some(false) => find_kind("reject"),
                None => None,
            }
        };
        let outcome = match chosen {
            Some(option_id) => json!({ "outcome": "selected", "optionId": option_id }),
            None => json!({ "outcome": "cancelled" }),
        };
        vec![Out::Agent(line(json!({
            "jsonrpc": "2.0", "id": request.rpc_id, "result": { "outcome": outcome }
        })))]
    }

    fn flush_waiting(&mut self) -> Vec<Out> {
        let mut out = Vec::new();
        while self.ready {
            let Some(command) = self.waiting.pop_front() else {
                break;
            };
            out.extend(self.handle_command(command));
        }
        out
    }

    // ------------------------------------------------------------ agent → UI

    /// Handle one JSON-RPC line from the agent's stdout.
    pub fn on_agent(&mut self, raw: &str) -> Vec<Out> {
        let Ok(message) = serde_json::from_str::<Value>(raw) else {
            // Some adapters log to stdout; never let that kill the session.
            return Vec::new();
        };
        let method = message.get("method").and_then(Value::as_str);
        let has_id = message.get("id").is_some_and(|id| !id.is_null());
        match (method, has_id) {
            (Some(method), true) => self.on_agent_request(method, &message),
            (Some("session/update"), false) => message
                .pointer("/params/update")
                .map(|update| self.on_update(update))
                .unwrap_or_default(),
            (Some(_), false) => Vec::new(),
            (None, true) => self.on_agent_response(&message),
            (None, false) => Vec::new(),
        }
    }

    fn on_agent_request(&mut self, method: &str, message: &Value) -> Vec<Out> {
        let rpc_id = message.get("id").cloned().unwrap_or(Value::Null);
        if method != "session/request_permission" {
            return vec![Out::Agent(line(json!({
                "jsonrpc": "2.0", "id": rpc_id,
                "error": { "code": -32601, "message": format!("Kern does not implement {method}") }
            })))];
        }
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let options: Vec<(String, String, String)> = params
            .get("options")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        Some((
                            item.get("name").and_then(Value::as_str)?.to_string(),
                            item.get("optionId").and_then(Value::as_str)?.to_string(),
                            item.get("kind")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if self.auto_approve {
            // Prefer a one-off allow: `allow_always` makes some adapters
            // persist rules into the agent's own settings.
            let allow = ["allow_once", "allow"].iter().find_map(|prefix| {
                options
                    .iter()
                    .find(|(_, _, kind)| kind.starts_with(prefix))
                    .map(|(_, option_id, _)| option_id.clone())
            });
            if let Some(option_id) = allow {
                return vec![Out::Agent(line(json!({
                    "jsonrpc": "2.0", "id": rpc_id,
                    "result": { "outcome": { "outcome": "selected", "optionId": option_id } }
                })))];
            }
        }
        let tool = params.get("toolCall").cloned().unwrap_or(Value::Null);
        let title = tool
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                tool.get("toolCallId")
                    .and_then(Value::as_str)
                    .and_then(|id| self.tools.get(id))
                    .map(|(name, _)| name.clone())
            })
            .unwrap_or_else(|| "tool".into());
        let detail = tool
            .pointer("/rawInput/command")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| tool_result_text(&tool));
        let ui_id = self.next_seq("acp-permission");
        let names: Vec<String> = options.iter().map(|(name, _, _)| name.clone()).collect();
        self.permissions
            .insert(ui_id.clone(), PermissionRequest { rpc_id, options });
        let mut request = json!({
            "type": "extension_ui_request",
            "id": ui_id,
            "method": "select",
            "title": format!("{} wants to run: {title}", self.harness),
            "options": names,
        });
        if !detail.is_empty() {
            request["message"] = json!(detail);
        }
        vec![Self::ui(request)]
    }

    fn on_agent_response(&mut self, message: &Value) -> Vec<Out> {
        let Some(id) = message.get("id").and_then(Value::as_u64) else {
            return Vec::new();
        };
        let Some(pending) = self.pending.remove(&id) else {
            return Vec::new();
        };
        let error = message.get("error").map(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| error.to_string())
        });
        let result = message.get("result").cloned().unwrap_or(Value::Null);
        match pending {
            Pending::Initialize => {
                if let Some(error) = error {
                    return vec![Out::Fatal(format!(
                        "{} failed to initialize: {error}",
                        self.harness
                    ))];
                }
                self.load_supported = result
                    .pointer("/agentCapabilities/loadSession")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.image_supported = result
                    .pointer("/agentCapabilities/promptCapabilities/image")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.capabilities_known = true;
                match self.resume.clone() {
                    Some(session_id) if self.load_supported => {
                        self.replaying = true;
                        vec![self.request(
                            "session/load",
                            json!({ "sessionId": session_id, "cwd": self.cwd, "mcpServers": self.mcp_servers }),
                            Pending::LoadSession,
                        )]
                    }
                    resume => {
                        let mut out = Vec::new();
                        if resume.is_some() {
                            out.push(Self::ui(json!({
                                "type": "extension_ui_request", "id": self.next_seq("acp-notify"),
                                "method": "notify",
                                "message": format!("{} cannot restore saved sessions — started a new one.", self.harness)
                            })));
                        }
                        out.push(self.request(
                            "session/new",
                            json!({ "cwd": self.cwd, "mcpServers": self.mcp_servers }),
                            Pending::NewSession { pi_id: None },
                        ));
                        out
                    }
                }
            }
            Pending::NewSession { pi_id } => {
                if let Some(error) = error {
                    return match pi_id {
                        Some(pi_id) => vec![Self::fail("new_session", Some(&pi_id), error)],
                        None => vec![Out::Fatal(format!(
                            "{} could not start a session: {error}",
                            self.harness
                        ))],
                    };
                }
                let Some(session_id) = result.get("sessionId").and_then(Value::as_str) else {
                    return vec![Out::Fatal(format!(
                        "{} returned no sessionId",
                        self.harness
                    ))];
                };
                self.session_id = Some(session_id.to_string());
                self.absorb_session_state(&result);
                self.ready = true;
                self.preamble_pending = self.preamble.is_some();
                let mut out = Vec::new();
                if let Some(pi_id) = pi_id {
                    out.push(Self::respond(
                        "new_session",
                        Some(&pi_id),
                        Some(json!({ "cancelled": false })),
                    ));
                }
                out.extend(self.apply_initial_model());
                out.extend(self.flush_waiting());
                out
            }
            Pending::LoadSession => {
                self.replaying = false;
                if let Some(error) = error {
                    // A stale or foreign session id must not brick the chat.
                    self.history.clear();
                    let mut out = vec![Self::ui(json!({
                        "type": "extension_ui_request", "id": self.next_seq("acp-notify"),
                        "method": "notify",
                        "message": format!("Could not restore the {} session ({error}) — started a new one.", self.harness)
                    }))];
                    out.push(self.request(
                        "session/new",
                        json!({ "cwd": self.cwd, "mcpServers": self.mcp_servers }),
                        Pending::NewSession { pi_id: None },
                    ));
                    return out;
                }
                self.session_id = self.resume.clone();
                self.absorb_session_state(&result);
                self.ready = true;
                let mut out = self.apply_initial_model();
                out.extend(self.flush_waiting());
                out
            }
            Pending::Prompt => {
                if let Some(usage) = result.get("usage").filter(|usage| usage.is_object()) {
                    self.tokens = Some(usage.clone());
                    // PromptResponse usage is cumulative across the session; only
                    // usage_update describes the adapter's latest request context.
                }
                let reason = result
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .unwrap_or("end_turn");
                self.finish_turn(reason, error)
            }
            Pending::Compact { pi_id, auto } => {
                let mut end = json!({ "type": "compaction_end", "reason": if auto { "threshold" } else { "manual" } });
                if let Some(error) = &error {
                    end["errorMessage"] = json!(error);
                }
                if let Some(usage) = result.get("usage").filter(|usage| usage.is_object()) {
                    self.tokens = Some(usage.clone());
                }
                // The pre-compaction size is stale until the next usage_update.
                if error.is_none() {
                    self.usage = None;
                    self.request_tokens = None;
                    self.auto_compact_off = false;
                } else if auto {
                    // Don't loop on a failing compaction; carry on without it.
                    self.auto_compact_off = true;
                }
                self.compacting = false;
                let ack = match error {
                    Some(error) => Self::fail("compact", pi_id.as_ref(), error),
                    None => Self::respond("compact", pi_id.as_ref(), None),
                };
                let mut out = vec![Self::ui(end), ack];
                if let Some((message, images)) = self.queued_prompts.pop_front() {
                    out.push(self.queue_update());
                    out.extend(self.start_prompt(message, images));
                }
                out
            }
            Pending::SetModel { pi_id, value } => {
                if let Some(error) = error {
                    return vec![Self::fail("set_model", pi_id.as_ref(), error)];
                }
                self.absorb_session_state(&result);
                self.set_current_model(&value);
                vec![Self::respond(
                    "set_model",
                    pi_id.as_ref(),
                    Some(json!({ "provider": self.harness, "id": value })),
                )]
            }
            Pending::SetThinking { pi_id, value } => {
                if let Some(error) = error {
                    return vec![Self::fail("set_thinking_level", pi_id.as_ref(), error)];
                }
                self.absorb_session_state(&result);
                if let Some(option) = self.config_options.iter_mut().find(|option| {
                    option.get("category").and_then(Value::as_str) == Some("thought_level")
                }) {
                    option["currentValue"] = json!(value);
                }
                vec![Self::respond("set_thinking_level", pi_id.as_ref(), None)]
            }
        }
    }

    fn set_current_model(&mut self, value: &str) {
        if let Some(option) = self.config_options.iter_mut().find(|option| {
            option.get("category").and_then(Value::as_str) == Some("model")
                || option.get("id").and_then(Value::as_str) == Some("model")
        }) {
            option["currentValue"] = json!(value);
        } else if let Some(models) = self.legacy_models.as_mut() {
            models["currentModelId"] = json!(value);
        }
    }

    fn absorb_session_state(&mut self, result: &Value) {
        if let Some(options) = result.get("configOptions").and_then(Value::as_array) {
            self.config_options = options.clone();
        }
        if let Some(models) = result.get("models").filter(|models| models.is_object()) {
            self.legacy_models = Some(models.clone());
        }
    }

    fn apply_initial_model(&mut self) -> Vec<Out> {
        let Some(requested) = self.initial_model.take() else {
            return Vec::new();
        };
        match self.resolve_model(&requested) {
            Some(value) if self.current_model().as_deref() != Some(value.as_str()) => {
                self.set_model_request(value, None).into_iter().collect()
            }
            _ => Vec::new(),
        }
    }

    fn segment_message(&mut self, text: &str, thinking: &str, stop: &str) -> Value {
        let mut content = Vec::new();
        if !thinking.is_empty() {
            content.push(json!({ "type": "thinking", "thinking": thinking }));
        }
        if !text.is_empty() {
            content.push(json!({ "type": "text", "text": text }));
        }
        json!({
            "id": self.next_seq("acp-assistant"),
            "role": "assistant",
            "content": content,
            "stopReason": stop,
            "timestamp": now_ms(),
        })
    }

    /// Close the open segment before a tool call when it holds output.
    fn close_segment(&mut self) -> Option<Out> {
        let turn = self.turn.as_mut()?;
        if turn.segment_closed || (turn.text.is_empty() && turn.thinking.is_empty()) {
            return None;
        }
        let text = std::mem::take(&mut turn.text);
        let thinking = std::mem::take(&mut turn.thinking);
        turn.segment_closed = true;
        let message = self.segment_message(&text, &thinking, "toolUse");
        self.history.push(message.clone());
        if let Some(turn) = self.turn.as_mut() {
            turn.closed.push(message.clone());
        }
        Some(Self::ui(
            json!({ "type": "message_end", "message": message }),
        ))
    }

    fn finish_turn(&mut self, reason: &str, error: Option<String>) -> Vec<Out> {
        let turn = self.turn.take().unwrap_or_default();
        let stop = if error.is_some() || reason == "refusal" {
            "error"
        } else if turn.used_tool && turn.text.is_empty() {
            "toolUse"
        } else {
            stop_reason(reason)
        };
        let mut assistant = self.segment_message(&turn.text, &turn.thinking, stop);
        if let Some(error) = &error {
            assistant["errorMessage"] = json!(error);
        } else if reason == "refusal" {
            assistant["errorMessage"] = json!(format!("{} refused to continue", self.harness));
        }
        let has_output = !turn.text.is_empty() || !turn.thinking.is_empty();
        if has_output {
            self.history.push(assistant.clone());
        }
        // Pending permission prompts belong to the finished turn.
        self.permissions.clear();
        let mut messages = turn.closed;
        let mut out = Vec::new();
        // A closed segment with nothing after it already had its message_end;
        // a fresh empty one would only add a blank bubble (errors still show).
        if !turn.segment_closed || has_output || assistant.get("errorMessage").is_some() {
            out.push(Self::ui(
                json!({ "type": "message_end", "message": assistant }),
            ));
            messages.push(assistant);
        }
        out.push(Self::ui(
            json!({ "type": "agent_end", "messages": messages }),
        ));
        out.push(Self::ui(json!({ "type": "agent_settled" })));
        if let Some((message, images)) = self.queued_prompts.pop_front() {
            out.push(self.queue_update());
            out.extend(self.start_prompt(message, images));
        }
        out
    }

    fn append_replay(&mut self, role: &str, text: &str) {
        if let Some(last) = self.history.last_mut() {
            if last.get("role").and_then(Value::as_str) == Some(role) {
                if let Some(block) = last.pointer_mut("/content/0/text") {
                    let joined = format!("{}{text}", block.as_str().unwrap_or(""));
                    *block = json!(joined);
                    return;
                }
            }
        }
        let id = self.next_seq("acp-history");
        self.history.push(json!({
            "id": id,
            "role": role,
            "content": [{ "type": "text", "text": text }],
        }));
    }

    fn on_update(&mut self, update: &Value) -> Vec<Out> {
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("");
        match kind {
            "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk" => {
                let Some(text) = update.get("content").and_then(content_text) else {
                    return Vec::new();
                };
                if self.replaying {
                    let role = if kind == "user_message_chunk" {
                        "user"
                    } else {
                        "assistant"
                    };
                    if kind != "agent_thought_chunk" {
                        self.append_replay(role, text);
                    }
                    return Vec::new();
                }
                let Some(turn) = self.turn.as_mut() else {
                    return Vec::new();
                };
                if kind == "user_message_chunk" {
                    return Vec::new();
                }
                let mut out = Vec::new();
                if turn.segment_closed {
                    turn.segment_closed = false;
                    out.push(Self::ui(
                        json!({ "type": "message_start", "message": { "role": "assistant" } }),
                    ));
                }
                let delta_type = match kind {
                    "agent_message_chunk" => {
                        turn.text.push_str(text);
                        "text_delta"
                    }
                    "agent_thought_chunk" => {
                        turn.thinking.push_str(text);
                        "thinking_delta"
                    }
                    _ => return Vec::new(),
                };
                out.push(Self::ui(json!({
                    "type": "message_update",
                    "assistantMessageEvent": { "type": delta_type, "delta": text }
                })));
                out
            }
            "tool_call" => {
                if self.replaying {
                    return Vec::new();
                }
                let Some(call_id) = update.get("toolCallId").and_then(Value::as_str) else {
                    return Vec::new();
                };
                let name = tool_name(update);
                let args = tool_args(update);
                self.tools
                    .insert(call_id.to_string(), (name.clone(), args.clone()));
                let mut out: Vec<Out> = self.close_segment().into_iter().collect();
                if let Some(turn) = self.turn.as_mut() {
                    turn.used_tool = true;
                }
                out.push(Self::ui(json!({
                    "type": "tool_execution_start",
                    "toolCallId": call_id, "toolName": name, "args": args
                })));
                let finished = matches!(
                    update.get("status").and_then(Value::as_str),
                    Some("completed" | "failed")
                );
                out.extend(self.announce(call_id, finished));
                if finished {
                    out.extend(self.tool_end(call_id, update));
                }
                out
            }
            "tool_call_update" => {
                if self.replaying {
                    return Vec::new();
                }
                let Some(call_id) = update.get("toolCallId").and_then(Value::as_str) else {
                    return Vec::new();
                };
                let mut out = Vec::new();
                if !self.tools.contains_key(call_id) {
                    out.extend(self.close_segment());
                    if let Some(turn) = self.turn.as_mut() {
                        turn.used_tool = true;
                    }
                    let name = tool_name(update);
                    let args = tool_args(update);
                    self.tools
                        .insert(call_id.to_string(), (name.clone(), args.clone()));
                    out.push(Self::ui(json!({
                        "type": "tool_execution_start",
                        "toolCallId": call_id, "toolName": name, "args": args
                    })));
                } else if update.get("rawInput").is_some_and(Value::is_object) {
                    let args = tool_args(update);
                    if let Some(entry) = self.tools.get_mut(call_id) {
                        entry.1 = args;
                    }
                }
                let finished = matches!(
                    update.get("status").and_then(Value::as_str),
                    Some("completed" | "failed")
                );
                out.extend(self.announce(call_id, finished));
                match update.get("status").and_then(Value::as_str) {
                    Some("completed" | "failed") => out.extend(self.tool_end(call_id, update)),
                    _ => {
                        let text = tool_result_text(update);
                        if !text.is_empty() {
                            out.push(Self::ui(json!({
                                "type": "tool_execution_update",
                                "toolCallId": call_id,
                                "partialResult": { "content": [{ "type": "text", "text": text }] }
                            })));
                        }
                    }
                }
                out
            }
            "available_commands_update" => {
                if let Some(commands) = update.get("availableCommands").and_then(Value::as_array) {
                    self.commands = commands.clone();
                }
                Vec::new()
            }
            "config_option_update" => {
                if let Some(options) = update.get("configOptions").and_then(Value::as_array) {
                    self.config_options = options.clone();
                }
                Vec::new()
            }
            "usage_update" => {
                if let (Some(used), Some(size)) = (
                    update.get("used").and_then(Value::as_u64),
                    update.get("size").and_then(Value::as_u64),
                ) {
                    self.usage = Some((used, size));
                    self.request_tokens = Some(used);
                }
                if let Some(amount) = update.pointer("/cost/amount").and_then(Value::as_f64) {
                    self.cost = Some(amount);
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    /// pi streams `toolcall_start` (with arguments) before executing a tool, and
    /// the UI keys some app actions off it (e.g. Kanban sync). ACP may send a
    /// tool call before its input is known, so announce once input exists.
    fn announce(&mut self, call_id: &str, finished: bool) -> Option<Out> {
        if self.announced.contains(call_id) {
            return None;
        }
        let (name, args) = self.tools.get(call_id)?.clone();
        let has_input = args
            .as_object()
            .is_some_and(|map| map.keys().any(|key| key != "title" && key != "path"));
        if !has_input && !finished {
            return None;
        }
        self.announced.insert(call_id.to_string());
        Some(Self::ui(json!({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_start",
                "toolCall": { "id": call_id, "name": name, "arguments": args }
            }
        })))
    }

    fn tool_end(&mut self, call_id: &str, update: &Value) -> Vec<Out> {
        let (name, args) = self
            .tools
            .remove(call_id)
            .unwrap_or_else(|| (tool_name(update), tool_args(update)));
        let is_error = update.get("status").and_then(Value::as_str) == Some("failed");
        let text = tool_result_text(update);
        let mut result = json!({ "content": [{ "type": "text", "text": text }], "details": {} });
        if let Some(diff) = update
            .get("content")
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item.get("type").and_then(Value::as_str) == Some("diff"))
            })
        {
            result["details"]["diff"] = diff.clone();
        }
        vec![Self::ui(json!({
            "type": "tool_execution_end",
            "toolCallId": call_id, "toolName": name, "args": args,
            "result": result, "isError": is_error
        }))]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(out: &[Out]) -> Vec<Value> {
        out.iter()
            .filter_map(|o| match o {
                Out::Agent(l) => Some(serde_json::from_str(l).unwrap()),
                _ => None,
            })
            .collect()
    }

    fn ui(out: &[Out]) -> Vec<Value> {
        out.iter()
            .filter_map(|o| match o {
                Out::Ui(l) => Some(serde_json::from_str(l).unwrap()),
                _ => None,
            })
            .collect()
    }

    fn reply(id: u64, result: Value) -> String {
        json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
    }

    fn update(update: Value) -> String {
        json!({ "jsonrpc": "2.0", "method": "session/update", "params": { "sessionId": "s1", "update": update } })
            .to_string()
    }

    fn model_option() -> Value {
        json!({
            "id": "model", "name": "Model", "category": "model", "type": "select",
            "currentValue": "anthropic/claude-sonnet",
            "options": [
                { "value": "anthropic/claude-sonnet", "name": "Sonnet" },
                { "group": "openai", "name": "OpenAI", "options": [{ "value": "openai/gpt-5", "name": "GPT-5" }] }
            ]
        })
    }

    /// Bridge after initialize + session/new, with the given capabilities.
    fn ready_bridge(load: bool) -> AcpBridge {
        let mut bridge = AcpBridge::new("opencode", "/repo", json!([]), None, None);
        let init = agent(&bridge.start());
        assert_eq!(init[0]["method"], "initialize");
        assert_eq!(init[0]["params"]["protocolVersion"], 1);
        let out = bridge.on_agent(&reply(
            1,
            json!({ "protocolVersion": 1, "agentCapabilities": { "loadSession": load, "promptCapabilities": { "image": true } } }),
        ));
        let new = agent(&out);
        assert_eq!(new[0]["method"], "session/new");
        assert_eq!(new[0]["params"]["cwd"], "/repo");
        bridge.on_agent(&reply(
            2,
            json!({ "sessionId": "s1", "configOptions": [model_option()] }),
        ));
        bridge
    }

    #[test]
    fn session_file_round_trips() {
        let file = session_file_for("claude-code", "abc:123");
        assert_eq!(parse_session_file(&file), Some(("claude-code", "abc:123")));
        assert_eq!(
            parse_session_file("/Users/x/.pi/agent/sessions/a.jsonl"),
            None
        );
        assert_eq!(parse_session_file("acp::x"), None);
    }

    #[test]
    fn state_reports_image_input_once_initialized() {
        let mut bridge = AcpBridge::new("opencode", "/repo", json!([]), None, None);
        assert_eq!(bridge.state_data()["imageInput"], Value::Null);
        bridge.start();
        bridge.on_agent(&reply(
            1,
            json!({ "agentCapabilities": { "promptCapabilities": { "image": true } } }),
        ));
        assert_eq!(bridge.state_data()["imageInput"], true);
    }

    #[test]
    fn commands_before_ready_are_queued_then_answered() {
        let mut bridge = AcpBridge::new("opencode", "/repo", json!([]), None, None);
        bridge.start();
        assert!(bridge.on_ui(r#"{"type":"get_state","id":"a"}"#).is_empty());
        bridge.on_agent(&reply(1, json!({ "agentCapabilities": {} })));
        let out = bridge.on_agent(&reply(
            2,
            json!({ "sessionId": "s1", "configOptions": [model_option()] }),
        ));
        let state = &ui(&out)[0];
        assert_eq!(state["command"], "get_state");
        assert_eq!(state["id"], "a");
        assert_eq!(state["data"]["sessionFile"], "acp:opencode:s1");
        // No promptCapabilities.image: the agent cannot take images.
        assert_eq!(state["data"]["imageInput"], false);
        assert_eq!(state["data"]["model"]["id"], "anthropic/claude-sonnet");
        assert_eq!(state["data"]["isStreaming"], false);
    }

    #[test]
    fn unsupported_inline_images_have_an_explicit_notice_and_keep_paths() {
        let mut bridge = ready_bridge(false);
        bridge.image_supported = false;
        let out = bridge.start_prompt(
            "look /store/shot.png".into(),
            vec![json!({"data":"AAAA", "mimeType":"image/png"})],
        );
        let sent = agent(&out);
        let blocks = sent[0]["params"]["prompt"].as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        let text = blocks[0]["text"].as_str().unwrap();
        assert!(text.contains("/store/shot.png"));
        assert!(text.contains("cannot receive inline images"));
        let events = ui(&out);
        let notice = events
            .iter()
            .position(|event| event["message"]["customType"] == "kern-image-fallback")
            .expect("notice");
        let opened = events
            .iter()
            .position(|event| event["type"] == "message_start")
            .expect("assistant turn");
        assert!(notice < opened, "notice must precede the assistant turn");
        assert!(bridge.history.last().unwrap()["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("cannot receive inline images"));
    }

    #[test]
    fn prompt_streams_pi_events_and_settles() {
        let mut bridge = ready_bridge(false);
        let out = bridge.on_ui(r#"{"type":"prompt","message":"hi","images":[]}"#);
        let sent = agent(&out);
        assert_eq!(sent[0]["method"], "session/prompt");
        assert_eq!(sent[0]["params"]["prompt"][0]["text"], "hi");
        let events: Vec<_> = ui(&out)
            .iter()
            .map(|e| e["type"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(events, ["response", "agent_start", "message_start"]);

        let delta = ui(&bridge.on_agent(&update(json!({
            "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "Hello" }
        }))));
        assert_eq!(delta[0]["assistantMessageEvent"]["type"], "text_delta");
        assert_eq!(delta[0]["assistantMessageEvent"]["delta"], "Hello");
        bridge.on_agent(&update(json!({
            "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "hmm" }
        })));

        let busy = ui(&bridge.on_ui(r#"{"type":"prompt","message":"again"}"#));
        assert_eq!(busy[0]["success"], false);

        let settled = ui(&bridge.on_agent(&reply(
            sent[0]["id"].as_u64().unwrap(),
            json!({ "stopReason": "end_turn" }),
        )));
        let kinds: Vec<_> = settled
            .iter()
            .map(|e| e["type"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["message_end", "agent_end", "agent_settled"]);
        assert_eq!(settled[0]["message"]["stopReason"], "stop");
        assert_eq!(settled[0]["message"]["content"][1]["text"], "Hello");
        assert_eq!(settled[0]["message"]["content"][0]["thinking"], "hmm");

        let history = ui(&bridge.on_ui(r#"{"type":"get_messages","id":7}"#));
        let messages = history[0]["data"]["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[1]["role"], "assistant");
    }

    #[test]
    fn tool_calls_split_text_into_separate_assistant_messages() {
        let mut bridge = ready_bridge(false);
        let id = agent(&bridge.on_ui(r#"{"type":"prompt","message":"x"}"#))[0]["id"]
            .as_u64()
            .unwrap();
        let text = |t: &str| {
            update(json!({
                "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": t }
            }))
        };
        let kinds = |out: &[Out]| -> Vec<String> {
            ui(out)
                .iter()
                .map(|e| e["type"].as_str().unwrap().to_string())
                .collect()
        };
        bridge.on_agent(&text("Checking:"));
        let tool = bridge.on_agent(&update(json!({
            "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "ls", "status": "pending"
        })));
        assert_eq!(kinds(&tool)[..2], ["message_end", "tool_execution_start"]);
        assert_eq!(ui(&tool)[0]["message"]["content"][0]["text"], "Checking:");
        // A second tool with no text in between does not emit an empty message.
        let second = bridge.on_agent(&update(json!({
            "sessionUpdate": "tool_call", "toolCallId": "t2", "title": "cat", "status": "pending"
        })));
        assert_eq!(kinds(&second)[0], "tool_execution_start");
        assert_eq!(
            kinds(&bridge.on_agent(&text("Done."))),
            ["message_start", "message_update"]
        );

        let settled = ui(&bridge.on_agent(&reply(id, json!({ "stopReason": "end_turn" }))));
        assert_eq!(settled[0]["type"], "message_end");
        assert_eq!(settled[0]["message"]["content"][0]["text"], "Done.");
        let ended = settled[1]["messages"].as_array().unwrap();
        assert_eq!(ended.len(), 2);

        // Ending right after a closed segment adds no blank message.
        let id = agent(&bridge.on_ui(r#"{"type":"prompt","message":"y"}"#))[0]["id"]
            .as_u64()
            .unwrap();
        bridge.on_agent(&text("Running:"));
        bridge.on_agent(&update(json!({
            "sessionUpdate": "tool_call", "toolCallId": "t3", "title": "ls", "status": "completed"
        })));
        let settled = bridge.on_agent(&reply(id, json!({ "stopReason": "end_turn" })));
        assert_eq!(kinds(&settled), ["agent_end", "agent_settled"]);
    }

    #[test]
    fn compact_runs_the_adapters_slash_command_and_queues_prompts() {
        let mut bridge = ready_bridge(false);
        let refused = ui(&bridge.on_ui(r#"{"type":"compact","id":"c0"}"#));
        assert_eq!(refused[0]["success"], false);

        bridge.on_agent(&update(json!({
            "sessionUpdate": "available_commands_update",
            "availableCommands": [{ "name": "compact", "description": "Compact" }]
        })));
        let out = bridge.on_ui(r#"{"type":"compact","id":"c1"}"#);
        assert_eq!(ui(&out)[0]["type"], "compaction_start");
        let sent = agent(&out);
        assert_eq!(sent[0]["method"], "session/prompt");
        assert_eq!(sent[0]["params"]["prompt"][0]["text"], "/compact");
        let compact_id = sent[0]["id"].as_u64().unwrap();

        // The summary the adapter streams is not a chat message.
        let chunk = bridge.on_agent(&update(json!({
            "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "summary" }
        })));
        assert!(ui(&chunk).is_empty());
        // A prompt sent meanwhile waits for compaction.
        let queued = bridge.on_ui(r#"{"type":"prompt","message":"next"}"#);
        assert!(agent(&queued).is_empty());

        let done = bridge.on_agent(&reply(compact_id, json!({ "stopReason": "end_turn" })));
        let events = ui(&done);
        assert_eq!(events[0]["type"], "compaction_end");
        assert!(events[0].get("errorMessage").is_none());
        assert_eq!(events[1]["command"], "compact");
        assert_eq!(events[1]["id"], "c1");
        let next = agent(&done);
        assert_eq!(next[0]["params"]["prompt"][0]["text"], "next");
    }

    #[test]
    fn threshold_compacts_only_between_turns_and_drains_after_success() {
        let mut bridge = ready_bridge(false);
        bridge.commands = vec![json!({"name":"compact"})];
        let first = agent(&bridge.on_ui(r#"{"type":"prompt","message":"first"}"#))[0]["id"]
            .as_u64()
            .unwrap();
        bridge.on_agent(&update(
            json!({"sessionUpdate":"usage_update", "used":250_000, "size":1_000_000}),
        ));
        let queued = bridge.on_ui(r#"{"type":"follow_up","message":"next"}"#);
        assert!(agent(&queued).is_empty());
        assert!(!bridge.compacting);
        let out = bridge.on_agent(&reply(first, json!({"stopReason":"end_turn"})));
        let compact = agent(&out);
        assert_eq!(compact[0]["params"]["prompt"][0]["text"], "/compact");
        assert!(bridge.turn.is_none());
        let out = bridge.on_agent(&reply(compact[0]["id"].as_u64().unwrap(), json!({})));
        assert_eq!(agent(&out)[0]["params"]["prompt"][0]["text"], "next");
    }

    #[test]
    fn threshold_compaction_failure_still_sends_the_prompt_and_stops_retrying() {
        let mut bridge = ready_bridge(false);
        bridge.commands = vec![json!({"name":"compact"})];
        bridge.request_tokens = Some(250_000);
        let out = bridge.on_ui(r#"{"type":"prompt","message":"keep this"}"#);
        let compact = agent(&out);
        assert_eq!(compact[0]["params"]["prompt"][0]["text"], "/compact");
        let id = compact[0]["id"].as_u64().unwrap();
        let after = bridge.on_agent(
            &json!({"jsonrpc":"2.0","id":id,"error":{"code":-1,"message":"failed"}}).to_string(),
        );
        // The held prompt goes out anyway; no second compaction attempt.
        let sent = agent(&after);
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["params"]["prompt"][0]["text"], "keep this");
        assert!(bridge.auto_compact_off);
    }

    #[test]
    fn threshold_without_compaction_support_sends_with_one_notice() {
        let mut bridge = ready_bridge(false);
        bridge.commands = vec![];
        bridge.request_tokens = Some(250_000);
        let out = bridge.on_ui(r#"{"type":"prompt","message":"go"}"#);
        assert_eq!(agent(&out)[0]["params"]["prompt"][0]["text"], "go");
        assert!(ui(&out)
            .iter()
            .any(|event| event["message"]["customType"] == "kern-context-threshold"));
        bridge.turn = None;
        let again = bridge.on_ui(r#"{"type":"prompt","message":"again"}"#);
        assert!(!ui(&again)
            .iter()
            .any(|event| event["message"]["customType"] == "kern-context-threshold"));
    }

    #[test]
    fn session_stats_report_acp_token_usage_and_cost() {
        let mut bridge = ready_bridge(false);
        let failed = ui(&bridge.on_ui(r#"{"type":"get_session_stats","id":"s"}"#));
        assert_eq!(failed[0]["success"], false);

        let id = agent(&bridge.on_ui(r#"{"type":"prompt","message":"x"}"#))[0]["id"]
            .as_u64()
            .unwrap();
        bridge.on_agent(&update(json!({
            "sessionUpdate": "usage_update", "used": 50_000, "size": 200_000,
            "cost": { "amount": 0.42, "currency": "USD" }
        })));
        bridge.on_agent(&reply(
            id,
            json!({ "stopReason": "end_turn", "usage": {
                "inputTokens": 1200, "outputTokens": 800,
                "cachedReadTokens": 45000, "cachedWriteTokens": 3000, "totalTokens": 50000
            }}),
        ));
        let stats = ui(&bridge.on_ui(r#"{"type":"get_session_stats","id":"s"}"#));
        let data = &stats[0]["data"];
        assert_eq!(data["tokens"]["input"], 1200);
        assert_eq!(data["tokens"]["cacheRead"], 45000);
        assert_eq!(data["tokens"]["cacheWrite"], 3000);
        assert_eq!(data["tokens"]["total"], 50000);
        assert_eq!(data["contextUsage"]["percent"], 25.0);
        assert_eq!(data["cost"], 0.42);
    }

    #[test]
    fn prompt_error_surfaces_as_pi_error_message() {
        let mut bridge = ready_bridge(false);
        let id = agent(&bridge.on_ui(r#"{"type":"prompt","message":"x"}"#))[0]["id"]
            .as_u64()
            .unwrap();
        let out = ui(&bridge.on_agent(
            &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": "401 invalid api key" } }).to_string(),
        ));
        assert_eq!(out[0]["message"]["stopReason"], "error");
        assert_eq!(out[0]["message"]["errorMessage"], "401 invalid api key");
        assert_eq!(out[2]["type"], "agent_settled");
    }

    #[test]
    fn tool_calls_map_to_tool_execution_events() {
        let mut bridge = ready_bridge(false);
        bridge.on_ui(r#"{"type":"prompt","message":"run tests"}"#);
        let start = ui(&bridge.on_agent(&update(json!({
            "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "pnpm test",
            "kind": "execute", "status": "pending", "rawInput": { "command": "pnpm test" }
        }))));
        assert_eq!(start[0]["type"], "tool_execution_start");
        assert_eq!(start[0]["toolName"], "bash");
        assert_eq!(start[0]["args"]["command"], "pnpm test");

        let partial = ui(&bridge.on_agent(&update(json!({
            "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "in_progress",
            "content": [{ "type": "content", "content": { "type": "text", "text": "running" } }]
        }))));
        assert_eq!(partial[0]["type"], "tool_execution_update");

        let end = ui(&bridge.on_agent(&update(json!({
            "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "failed",
            "content": [{ "type": "content", "content": { "type": "text", "text": "1 failed" } }]
        }))));
        assert_eq!(end[0]["type"], "tool_execution_end");
        assert_eq!(end[0]["isError"], true);
        assert_eq!(end[0]["toolName"], "bash");
        assert_eq!(end[0]["result"]["content"][0]["text"], "1 failed");

        let edit = ui(&bridge.on_agent(&update(json!({
            "sessionUpdate": "tool_call", "toolCallId": "t2", "title": "Edit a.ts", "kind": "edit",
            "status": "completed", "rawInput": { "file_path": "/repo/a.ts" },
            "content": [{ "type": "diff", "path": "/repo/a.ts", "oldText": "a", "newText": "b" }]
        }))));
        assert_eq!(edit[0]["args"]["path"], "/repo/a.ts");
        let kinds: Vec<_> = edit.iter().map(|e| e["type"].as_str().unwrap()).collect();
        assert_eq!(
            kinds,
            [
                "tool_execution_start",
                "message_update",
                "tool_execution_end"
            ]
        );
        assert_eq!(edit[2]["result"]["details"]["diff"]["newText"], "b");
    }

    #[test]
    fn permission_request_round_trips_through_approval_dialog() {
        let mut bridge = ready_bridge(false);
        bridge.on_ui(r#"{"type":"prompt","message":"rm"}"#);
        let request = json!({
            "jsonrpc": "2.0", "id": 99, "method": "session/request_permission",
            "params": {
                "sessionId": "s1",
                "toolCall": { "toolCallId": "t1", "title": "rm -rf dist", "rawInput": { "command": "rm -rf dist" } },
                "options": [
                    { "optionId": "ok", "name": "Allow", "kind": "allow_once" },
                    { "optionId": "always", "name": "Always allow", "kind": "allow_always" },
                    { "optionId": "no", "name": "Reject", "kind": "reject_once" }
                ]
            }
        });
        let dialog = ui(&bridge.on_agent(&request.to_string()));
        assert_eq!(dialog[0]["type"], "extension_ui_request");
        assert_eq!(dialog[0]["method"], "select");
        assert_eq!(dialog[0]["message"], "rm -rf dist");
        assert_eq!(
            dialog[0]["options"],
            json!(["Allow", "Always allow", "Reject"])
        );
        let ui_id = dialog[0]["id"].as_str().unwrap();

        let answer = agent(&bridge.on_ui(
            &json!({ "type": "extension_ui_response", "id": ui_id, "value": "Reject" }).to_string(),
        ));
        assert_eq!(answer[0]["id"], 99);
        assert_eq!(
            answer[0]["result"]["outcome"],
            json!({ "outcome": "selected", "optionId": "no" })
        );

        // Second dialog cancelled → ACP `cancelled` outcome.
        let dialog = ui(&bridge.on_agent(&request.to_string()));
        let ui_id = dialog[0]["id"].as_str().unwrap();
        let answer = agent(&bridge.on_ui(
            &json!({ "type": "extension_ui_response", "id": ui_id, "cancelled": true }).to_string(),
        ));
        assert_eq!(answer[0]["result"]["outcome"]["outcome"], "cancelled");
    }

    #[test]
    fn auto_approve_answers_permission_without_dialog() {
        let mut bridge = ready_bridge(false);
        bridge.set_auto_approve(true);
        bridge.on_ui(r#"{"type":"prompt","message":"rm"}"#);
        let request = |options: Value| {
            json!({
                "jsonrpc": "2.0", "id": 7, "method": "session/request_permission",
                "params": { "sessionId": "s1", "toolCall": { "toolCallId": "t1" }, "options": options }
            })
            .to_string()
        };
        let out = bridge.on_agent(&request(json!([
            { "optionId": "always", "name": "Always allow", "kind": "allow_always" },
            { "optionId": "ok", "name": "Allow", "kind": "allow_once" },
            { "optionId": "no", "name": "Reject", "kind": "reject_once" }
        ])));
        assert!(ui(&out).is_empty());
        let answer = agent(&out);
        assert_eq!(answer[0]["id"], 7);
        assert_eq!(
            answer[0]["result"]["outcome"],
            json!({ "outcome": "selected", "optionId": "ok" })
        );

        // Only `allow_always` offered → still approved.
        let answer = agent(&bridge.on_agent(&request(json!([
            { "optionId": "always", "name": "Always allow", "kind": "allow_always" },
            { "optionId": "no", "name": "Reject", "kind": "reject_once" }
        ]))));
        assert_eq!(answer[0]["result"]["outcome"]["optionId"], "always");

        // No allow option at all → fall back to the dialog.
        let dialog = ui(&bridge.on_agent(&request(json!([
            { "optionId": "no", "name": "Reject", "kind": "reject_once" }
        ]))));
        assert_eq!(dialog[0]["type"], "extension_ui_request");
    }

    #[test]
    fn abort_cancels_turn_and_open_permissions() {
        let mut bridge = ready_bridge(false);
        bridge.on_ui(r#"{"type":"prompt","message":"x"}"#);
        bridge.on_agent(
            &json!({ "jsonrpc": "2.0", "id": 5, "method": "session/request_permission",
                "params": { "sessionId": "s1", "toolCall": { "toolCallId": "t" }, "options": [] } })
            .to_string(),
        );
        let out = bridge.on_ui(r#"{"type":"abort","id":"ab"}"#);
        let sent = agent(&out);
        assert_eq!(sent[0]["id"], 5);
        assert_eq!(sent[0]["result"]["outcome"]["outcome"], "cancelled");
        assert_eq!(sent[1]["method"], "session/cancel");
        assert!(sent[1].get("id").is_none());
        assert_eq!(ui(&out)[0]["command"], "abort");
    }

    #[test]
    fn steer_while_running_is_delivered_after_settle() {
        let mut bridge = ready_bridge(false);
        let first = agent(&bridge.on_ui(r#"{"type":"prompt","message":"one"}"#))[0]["id"]
            .as_u64()
            .unwrap();
        let queued = ui(&bridge.on_ui(r#"{"type":"steer","message":"two"}"#));
        assert_eq!(queued[1]["type"], "queue_update");
        assert_eq!(queued[1]["followUp"], json!(["two"]));
        let out = bridge.on_agent(&reply(first, json!({ "stopReason": "end_turn" })));
        let next = agent(&out);
        assert_eq!(next[0]["method"], "session/prompt");
        assert_eq!(next[0]["params"]["prompt"][0]["text"], "two");
        assert!(ui(&out).iter().any(|e| e["type"] == "agent_start"));
    }

    #[test]
    fn models_are_listed_and_selected_via_config_options() {
        let mut bridge = ready_bridge(false);
        let models = ui(&bridge.on_ui(r#"{"type":"get_available_models","id":1}"#));
        let list = models[0]["data"]["models"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(
            list[1],
            json!({ "provider": "opencode", "id": "openai/gpt-5", "name": "GPT-5" })
        );

        // UI splits "opencode/openai/gpt-5" into provider + modelId.
        let sent = agent(&bridge.on_ui(
            r#"{"type":"set_model","provider":"opencode","modelId":"openai/gpt-5","id":"m"}"#,
        ));
        assert_eq!(sent[0]["method"], "session/set_config_option");
        assert_eq!(
            sent[0]["params"],
            json!({ "sessionId": "s1", "configId": "model", "value": "openai/gpt-5" })
        );
        let done = ui(&bridge.on_agent(&reply(sent[0]["id"].as_u64().unwrap(), json!({}))));
        assert_eq!(done[0]["success"], true);
        assert_eq!(done[0]["id"], "m");
        let state = ui(&bridge.on_ui(r#"{"type":"get_state"}"#));
        assert_eq!(state[0]["data"]["model"]["id"], "openai/gpt-5");

        // A pi default model the harness does not offer is rejected locally.
        let rejected = bridge.on_ui(r#"{"type":"set_model","provider":"zai","modelId":"glm-9"}"#);
        assert!(agent(&rejected).is_empty());
        assert_eq!(ui(&rejected)[0]["success"], false);
    }

    #[test]
    fn legacy_models_api_is_supported() {
        let mut bridge = AcpBridge::new(
            "claude-code",
            "/repo",
            json!([]),
            None,
            Some("anthropic/opus".into()),
        );
        bridge.start();
        bridge.on_agent(&reply(1, json!({ "agentCapabilities": {} })));
        let out = bridge.on_agent(&reply(2, json!({
            "sessionId": "c1",
            "models": { "currentModelId": "sonnet", "availableModels": [{ "modelId": "sonnet", "name": "Sonnet" }, { "modelId": "opus", "name": "Opus" }] }
        })));
        // initial model "anthropic/opus" resolves to the harness's "opus".
        let sent = agent(&out);
        assert_eq!(sent[0]["method"], "session/set_model");
        assert_eq!(sent[0]["params"]["modelId"], "opus");
    }

    #[test]
    fn resume_replays_history_without_streaming_it() {
        let mut bridge = AcpBridge::new("opencode", "/repo", json!([]), Some("old".into()), None);
        bridge.start();
        let load = agent(&bridge.on_agent(&reply(
            1,
            json!({ "agentCapabilities": { "loadSession": true } }),
        )));
        assert_eq!(load[0]["method"], "session/load");
        assert_eq!(load[0]["params"]["sessionId"], "old");
        assert!(bridge
            .on_ui(r#"{"type":"get_messages","id":"h"}"#)
            .is_empty());
        for (kind, text) in [
            ("user_message_chunk", "fix "),
            ("user_message_chunk", "bug"),
            ("agent_message_chunk", "done"),
        ] {
            let out = bridge.on_agent(&update(
                json!({ "sessionUpdate": kind, "content": { "type": "text", "text": text } }),
            ));
            assert!(out.is_empty());
        }
        let out = ui(&bridge.on_agent(&reply(2, json!({}))));
        let messages = out[0]["data"]["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["content"][0]["text"], "fix bug");
        assert_eq!(bridge.session_file().as_deref(), Some("acp:opencode:old"));
    }

    #[test]
    fn failed_resume_falls_back_to_new_session() {
        let mut bridge = AcpBridge::new("opencode", "/repo", json!([]), Some("gone".into()), None);
        bridge.start();
        bridge.on_agent(&reply(
            1,
            json!({ "agentCapabilities": { "loadSession": true } }),
        ));
        let out = bridge.on_agent(&json!({ "jsonrpc": "2.0", "id": 2, "error": { "code": -32002, "message": "not found" } }).to_string());
        assert_eq!(ui(&out)[0]["method"], "notify");
        assert_eq!(agent(&out)[0]["method"], "session/new");
    }

    #[test]
    fn unsupported_pi_commands_fail_with_their_id() {
        let mut bridge = ready_bridge(false);
        let out = ui(&bridge.on_ui(r#"{"type":"fork","entryId":"e1","id":"f"}"#));
        assert_eq!(out[0]["success"], false);
        assert_eq!(out[0]["id"], "f");
        assert_eq!(out[0]["command"], "fork");
    }

    #[test]
    fn unknown_agent_requests_get_method_not_found() {
        let mut bridge = ready_bridge(false);
        let out = agent(
            &bridge
                .on_agent(r#"{"jsonrpc":"2.0","id":"x","method":"fs/read_text_file","params":{}}"#),
        );
        assert_eq!(out[0]["error"]["code"], -32601);
        assert!(bridge.on_agent("not json at all").is_empty());
    }

    #[test]
    fn mcp_servers_are_sent_on_new_and_load() {
        let server = json!([{ "name": "kern", "command": "/usr/bin/node", "args": ["kern-mcp.mjs"], "env": [] }]);
        let mut bridge = AcpBridge::new(
            "opencode",
            "/repo",
            server.clone(),
            Some("old".into()),
            None,
        );
        bridge.start();
        let load = agent(&bridge.on_agent(&reply(
            1,
            json!({ "agentCapabilities": { "loadSession": true } }),
        )));
        assert_eq!(load[0]["params"]["mcpServers"], server);
        let mut fresh = AcpBridge::new("opencode", "/repo", server.clone(), None, None);
        fresh.start();
        let new = agent(&fresh.on_agent(&reply(1, json!({ "agentCapabilities": {} }))));
        assert_eq!(new[0]["params"]["mcpServers"], server);
    }

    #[test]
    fn kern_mcp_tool_names_are_normalized_for_the_ui() {
        assert_eq!(
            kern_tool_name("mcp__kern__track_kanban_task"),
            Some("track_kanban_task")
        );
        assert_eq!(kern_tool_name("kern_run_pipeline"), Some("run_pipeline"));
        assert_eq!(kern_tool_name("run_pipeline"), Some("run_pipeline"));
        assert_eq!(kern_tool_name("evil_run_pipeline"), None);
        assert_eq!(kern_tool_name("bash"), None);
        let mut bridge = ready_bridge(false);
        bridge.on_ui(r#"{"type":"prompt","message":"go"}"#);
        let out = ui(&bridge.on_agent(&update(json!({
            "sessionUpdate": "tool_call", "toolCallId": "k1",
            "title": "mcp__kern__control_pipeline", "kind": "other", "status": "pending",
            "rawInput": { "action": "retry" }
        }))));
        assert_eq!(out[0]["toolName"], "control_pipeline");
    }

    #[test]
    fn toolcall_start_waits_for_arguments_and_fires_once() {
        let mut bridge = ready_bridge(false);
        bridge.on_ui(r#"{"type":"prompt","message":"track it"}"#);
        // OpenCode-style: pending with empty input first.
        let first = ui(&bridge.on_agent(&update(json!({
            "sessionUpdate": "tool_call", "toolCallId": "k1",
            "title": "kern_track_kanban_task", "kind": "other", "status": "pending", "rawInput": {}
        }))));
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["type"], "tool_execution_start");
        let second = ui(&bridge.on_agent(&update(json!({
            "sessionUpdate": "tool_call_update", "toolCallId": "k1", "status": "in_progress",
            "rawInput": { "status": "Done", "description": "Ship login" }
        }))));
        let start = second
            .iter()
            .find(|e| e["assistantMessageEvent"]["type"] == "toolcall_start")
            .expect("announced once input is known");
        assert_eq!(
            start["assistantMessageEvent"]["toolCall"]["name"],
            "track_kanban_task"
        );
        assert_eq!(
            start["assistantMessageEvent"]["toolCall"]["arguments"]["status"],
            "Done"
        );
        let third = ui(&bridge.on_agent(&update(json!({
            "sessionUpdate": "tool_call_update", "toolCallId": "k1", "status": "completed",
            "content": [{ "type": "content", "content": { "type": "text", "text": "Kanban task marked Done." } }]
        }))));
        assert!(third.iter().all(|e| e["type"] != "message_update"));
        assert_eq!(third[0]["type"], "tool_execution_end");
        assert_eq!(third[0]["args"]["description"], "Ship login");
    }

    #[test]
    fn preamble_rides_on_first_prompt_of_fresh_sessions_only() {
        let mut bridge = AcpBridge::new("opencode", "/wt", json!([]), None, None)
            .with_preamble(Some("WORKTREE RULES".into()));
        bridge.start();
        bridge.on_agent(&reply(1, json!({ "agentCapabilities": {} })));
        bridge.on_agent(&reply(2, json!({ "sessionId": "s1" })));
        let first = agent(&bridge.on_ui(r#"{"type":"prompt","message":"hi"}"#));
        let text = first[0]["params"]["prompt"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("<kern-context>\nWORKTREE RULES\n</kern-context>"));
        assert!(text.ends_with("hi"));
        let id = first[0]["id"].as_u64().unwrap();
        bridge.on_agent(&reply(id, json!({ "stopReason": "end_turn" })));
        let history = ui(&bridge.on_ui(r#"{"type":"get_messages"}"#));
        assert_eq!(
            history[0]["data"]["messages"][0]["content"][0]["text"],
            "hi"
        );
        let second = agent(&bridge.on_ui(r#"{"type":"prompt","message":"again"}"#));
        assert_eq!(second[0]["params"]["prompt"][0]["text"], "again");

        // A resumed session already has its context.
        let mut resumed = AcpBridge::new("opencode", "/wt", json!([]), Some("old".into()), None)
            .with_preamble(Some("WORKTREE RULES".into()));
        resumed.start();
        resumed.on_agent(&reply(
            1,
            json!({ "agentCapabilities": { "loadSession": true } }),
        ));
        resumed.on_agent(&reply(2, json!({})));
        let sent = agent(&resumed.on_ui(r#"{"type":"prompt","message":"go"}"#));
        assert_eq!(sent[0]["params"]["prompt"][0]["text"], "go");
    }

    /// Real-agent handshake: `KERN_ACP_LIVE="opencode acp" cargo test --lib live_acp -- --ignored --nocapture`.
    /// Checks initialize → session/new → model listing against an installed harness (no LLM call).
    #[test]
    #[ignore]
    fn live_acp_handshake() {
        use std::io::{BufRead, BufReader, Write};
        use std::process::{Command, Stdio};
        let spec = std::env::var("KERN_ACP_LIVE").expect("set KERN_ACP_LIVE");
        let mut parts = spec.split_whitespace();
        let program = parts.next().unwrap();
        let cwd = std::env::temp_dir();
        let mut child = Command::new(program)
            .args(parts)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn harness");
        let mut stdin = child.stdin.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let stdout = child.stdout.take().unwrap();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let mcp = std::env::var("KERN_ACP_LIVE_MCP")
            .ok()
            .map(|raw| serde_json::from_str(&raw).expect("KERN_ACP_LIVE_MCP is JSON"))
            .unwrap_or_else(|| json!([]));
        let mut bridge = AcpBridge::new("live", cwd.to_string_lossy(), mcp, None, None);
        let mut events = Vec::new();
        let send =
            |outs: Vec<Out>, stdin: &mut std::process::ChildStdin, events: &mut Vec<Value>| {
                for out in outs {
                    match out {
                        Out::Agent(line) => writeln!(stdin, "{line}").unwrap(),
                        Out::Ui(line) => events.push(serde_json::from_str(&line).unwrap()),
                        Out::Fatal(error) => panic!("fatal: {error}"),
                    }
                }
            };
        send(bridge.start(), &mut stdin, &mut events);
        send(
            bridge.on_ui(r#"{"type":"get_available_models","id":"m"}"#),
            &mut stdin,
            &mut events,
        );
        send(
            bridge.on_ui(r#"{"type":"get_state","id":"s"}"#),
            &mut stdin,
            &mut events,
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        while events.len() < 2 && std::time::Instant::now() < deadline {
            if let Ok(line) = rx.recv_timeout(std::time::Duration::from_millis(500)) {
                send(bridge.on_agent(&line), &mut stdin, &mut events);
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        println!("{}", serde_json::to_string_pretty(&events).unwrap());
        let state = events
            .iter()
            .find(|e| e["command"] == "get_state")
            .expect("get_state answered");
        assert!(state["data"]["sessionFile"]
            .as_str()
            .unwrap()
            .starts_with("acp:live:"));
    }
}
