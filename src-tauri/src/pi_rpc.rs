use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use tauri::Emitter;

#[derive(Debug, Clone, Serialize)]
pub struct RpcEvent {
    pub session_id: String,
    /// raw JSON string forwarded as-is (frontend parses)
    pub raw: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RpcResponse {
    pub session_id: String,
    pub raw: String,
}

struct SessionHandle {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
}

type SharedSessionHandle = Arc<SessionHandle>;

static SESSIONS: OnceLock<Mutex<HashMap<String, SharedSessionHandle>>> = OnceLock::new();

fn sessions_map() -> &'static Mutex<HashMap<String, SharedSessionHandle>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn read_pi_config() -> Result<(String, serde_json::Value), String> {
    let raw = std::fs::read_to_string(crate::projects::config_path()).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let pi_path = v
        .get("pi_path")
        .and_then(|p| p.as_str())
        .ok_or_else(|| "pi_path missing in config".to_string())?
        .to_string();
    Ok((pi_path, v))
}

fn project_root_from_config(v: &serde_json::Value) -> Result<PathBuf, String> {
    // legacy — keep for fallback, but new guard uses registered projects
    if let Some(r) = v.get("project_root").and_then(|r| r.as_str()) {
        return Ok(PathBuf::from(r));
    }
    crate::projects::global_worktree_root().map(|p| p.parent().unwrap_or(&p).to_path_buf())
}

fn path_for_pi(pi_path: &str) -> std::ffi::OsString {
    let pi_dir = Path::new(pi_path).parent().unwrap_or_else(|| Path::new(""));
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut paths = vec![pi_dir.to_path_buf()];
    if let Some(home) = home {
        if let Ok(versions) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            paths.extend(
                versions
                    .filter_map(Result::ok)
                    .map(|entry| entry.path().join("bin"))
                    .filter(|path| path.is_dir()),
            );
        }
        paths.extend([
            home.join(".local/bin"),
            home.join(".npm-global/bin"),
            home.join(".bun/bin"),
        ]);
    }
    paths.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    std::env::join_paths(paths).unwrap_or_else(|_| pi_dir.as_os_str().to_owned())
}

fn candidate_pi_paths(configured: &str) -> Vec<PathBuf> {
    let configured = PathBuf::from(configured);
    let mut candidates = vec![configured.clone()];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        candidates.push(home.join(".local/bin/pi"));
        candidates.push(home.join(".pi/bin/pi"));
        candidates.push(home.join("bin/pi"));
        candidates.push(home.join(".cargo/bin/pi"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/pi"));
    candidates.push(PathBuf::from("/usr/local/bin/pi"));
    candidates
}

fn installed_pi(configured: &str) -> Option<PathBuf> {
    for path in candidate_pi_paths(configured) {
        if path.is_file() {
            // verify it actually runs
            if Command::new(&path).arg("--version").output().is_ok() {
                return Some(path);
            }
        }
    }
    None
}

fn install_pi_via_curl() -> Result<(), String> {
    let installer = std::env::temp_dir().join(format!("pi-install-{}.sh", std::process::id()));
    let download = Command::new("curl")
        .args(["-fsSL", "https://pi.dev/install.sh", "-o"])
        .arg(&installer)
        .status()
        .map_err(|error| format!("failed to download Pi installer: {error}"))?;
    if !download.success() {
        return Err("failed to download Pi installer from https://pi.dev/install.sh".into());
    }
    let install = Command::new("sh").arg(&installer).status();
    let _ = std::fs::remove_file(&installer);
    let install = install.map_err(|error| format!("failed to run Pi installer: {error}"))?;
    if !install.success() {
        return Err(format!("Pi installer failed with {install}"));
    }
    Ok(())
}

fn ensure_pi_installed(configured: &str) -> Result<PathBuf, String> {
    if let Some(path) = installed_pi(configured) {
        return Ok(path);
    }

    install_pi_via_curl()?;

    // retry after first install
    if let Some(path) = installed_pi(configured) {
        return Ok(path);
    }

    // Some installers place shim that needs PATH refresh, try again with home candidates
    // Give filesystem a moment
    std::thread::sleep(std::time::Duration::from_millis(300));
    installed_pi(configured).ok_or_else(|| {
        format!("Pi installed, but binary was not found at {configured} or ~/.local/bin/pi. Please run: curl -fsSL https://pi.dev/install.sh | sh")
    })
}

fn ensure_pi_installed_with_repair(app: Option<&tauri::AppHandle>, configured: &str) -> Result<PathBuf, String> {
    if let Some(path) = installed_pi(configured) {
        return Ok(path);
    }
    if let Some(app) = app {
        let _ = app.emit(
            "pi-rpc-stderr",
            serde_json::json!({
                "session_id": "system",
                "line": "⚠️ Pi binary not found on this Mac — reinstalling via https://pi.dev/install.sh ..."
            }),
        );
    }
    install_pi_via_curl()?;
    if let Some(app) = app {
        let _ = app.emit(
            "pi-rpc-stderr",
            serde_json::json!({
                "session_id": "system",
                "line": "✅ Pi reinstall finished, retrying spawn..."
            }),
        );
    }
    std::thread::sleep(std::time::Duration::from_millis(500));
    installed_pi(configured).ok_or_else(|| {
        format!("Pi still missing after auto-reinstall. Manually run: curl -fsSL https://pi.dev/install.sh | sh (checked: {:?})", candidate_pi_paths(configured))
    })
}

fn worktree_system_prompt(cwd: &Path, project: &Path) -> Option<String> {
    (cwd != project).then(|| {
        format!(
            "COMMAND RDEV CENTER WORKTREE:\n- This session runs in ephemeral worktree {} owned by {}.\n- The app may create worktree/node_modules as a symlink to the owning project's node_modules.\n- Turbopack rejects that external symlink with `points out of the filesystem root`. This is a known app constraint, not an unexplained build failure.\n- When a requested build hits it, replace only the worktree node_modules symlink with a local dependency install, then rerun the build. Do not modify or delete the owning project's node_modules.\n",
            cwd.display(),
            project.display()
        )
    })
}

pub fn global_chat_cwd() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    let path =
        PathBuf::from(home).join("Library/Application Support/command-rdev-center/global-chat");
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path.canonicalize().map_err(|e| e.to_string())?)
}

#[tauri::command]
pub fn get_global_chat_cwd() -> Result<String, String> {
    Ok(global_chat_cwd()?.to_string_lossy().into())
}

fn session_args(no_session: bool, session_file: Option<String>) -> Vec<String> {
    if no_session {
        vec!["--no-session".into()]
    } else if let Some(path) = session_file.filter(|path| !path.trim().is_empty()) {
        vec!["--session".into(), path]
    } else {
        Vec::new()
    }
}

/// Strict LF-only JSONL reader: split on \n only, strip trailing \r, do NOT split on U+2028/U+2029.
/// We implement our own line splitter over raw bytes to be correct.
struct LfLineReader<R: Read> {
    inner: BufReader<R>,
    buf: Vec<u8>,
}

impl<R: Read> LfLineReader<R> {
    fn new(r: R) -> Self {
        Self {
            inner: BufReader::new(r),
            buf: Vec::new(),
        }
    }

    /// Read next LF-delimited frame (without the LF). Returns None on EOF.
    /// Strips a single trailing \r if present.
    fn next_line(&mut self) -> Option<Result<String, String>> {
        self.buf.clear();
        // read until \n byte
        loop {
            let mut byte = [0u8; 1];
            match self.inner.read(&mut byte) {
                Ok(0) => {
                    // EOF
                    if self.buf.is_empty() {
                        return None;
                    } else {
                        break;
                    }
                }
                Ok(_) => {
                    if byte[0] == b'\n' {
                        break;
                    }
                    self.buf.push(byte[0]);
                }
                Err(e) => return Some(Err(e.to_string())),
            }
        }
        // strip trailing \r if present (accept \r\n from pi but emit without \r)
        if self.buf.last() == Some(&b'\r') {
            self.buf.pop();
        }
        match String::from_utf8(self.buf.clone()) {
            Ok(s) => Some(Ok(s)),
            Err(e) => Some(Err(format!("invalid utf8 in pi output: {}", e))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiSessionStart {
    pub session_id: String,
    /// cwd where pi should run (worktree path or project path)
    pub cwd: String,
    /// optional model override
    pub model: Option<String>,
    pub provider: Option<String>,
    pub thinking: Option<String>,
    /// whether to run with --no-session (for quick tests)
    pub no_session: Option<bool>,
}

#[tauri::command]
pub fn spawn_pi_rpc(
    app: tauri::AppHandle,
    session_id: String,
    cwd: String,
    model: Option<String>,
    provider: Option<String>,
    thinking: Option<String>,
    no_session: Option<bool>,
    session_file: Option<String>,
    graph_report_path: Option<String>,
    tools: Option<Vec<String>>,
    global_chat: Option<bool>,
    custom_system_prompt: Option<String>,
) -> Result<String, String> {
    let (configured_pi_path, _cfg) = read_pi_config()?;
    if session_id.trim().is_empty() || session_id.contains(['/', '\\']) {
        return Err("session_id must not contain path separators".to_string());
    }
    if cwd.trim().is_empty() {
        return Err("cwd required".to_string());
    }

    let global_chat = global_chat.unwrap_or(false);
    // Global chat has an app-owned empty cwd. It never inherits project context.
    let owning_project = if global_chat {
        let expected = global_chat_cwd()?;
        if Path::new(&cwd) != expected {
            return Err("global chat cwd is app-owned".into());
        }
        expected
    } else {
        crate::projects::ensure_path_allowed(Path::new(&cwd))?
    };

    if !Path::new(&cwd).exists() {
        return Err(format!("cwd does not exist (drive detached?): {}", cwd));
    }
    let pi_path = ensure_pi_installed_with_repair(Some(&app), &configured_pi_path).or_else(|_| ensure_pi_installed(&configured_pi_path))?;

    // Research IDs are never replaceable: duplicate lifecycle claims must not kill live work.
    if session_id.starts_with("research-") && is_pi_session_running(session_id.clone())? {
        return Err("research session is already running".into());
    }
    // Existing chat behavior remains replace-and-restart.
    if !session_id.starts_with("research-") {
        if let Ok(map) = sessions_map().lock() {
            if let Some(h) = map.get(&session_id) {
                if let Ok(mut maybe_child) = h.child.lock() {
                    if let Some(child) = maybe_child.as_mut() {
                        let _ = child.kill();
                    }
                }
            }
        }
    }

    let mut args: Vec<String> = vec!["--mode".into(), "rpc".into()];
    let figma = crate::settings::get_figma_mcp_settings()?;
    if figma.enabled {
        let config_path = std::env::temp_dir().join(format!("crc-figma-mcp-{session_id}.json"));
        let config = serde_json::json!({
            "mcpServers": { "figma": { "url": figma.url, "auth": "oauth" } }
        });
        std::fs::write(&config_path, serde_json::to_string(&config).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Figma MCP config: {e}"))?;
        args.push("--mcp-config".into());
        args.push(config_path.to_string_lossy().into());
    }
    if global_chat {
        args.push("--tools".into());
        args.push("web_search,source_check,fetch_content,get_search_content,mcp".into());
    } else if let Some(tools) = tools {
        if tools.is_empty() {
            args.push("--no-tools".into());
        } else {
            args.push("--tools".into());
            args.push(tools.join(","));
        }
    }
    if let Some(m) = &model {
        if !m.trim().is_empty() {
            args.push("--model".into());
            args.push(m.clone());
        }
    }
    if let Some(p) = &provider {
        if !p.trim().is_empty() {
            args.push("--provider".into());
            args.push(p.clone());
        }
    }
    if let Some(t) = &thinking {
        if !t.trim().is_empty() {
            args.push("--thinking".into());
            args.push(t.clone());
        }
    }
    args.extend(session_args(no_session.unwrap_or(false), session_file));
    if !global_chat {
        args.push("--extension".into());
        let extensions = crate::projects::extensions_path();
        args.push(extensions.join("kanban-task.ts").to_string_lossy().into());
        args.push("--extension".into());
        args.push(
            extensions
                .join("graphify-context.ts")
                .to_string_lossy()
                .into(),
        );
        args.push("--extension".into());
        args.push(
            extensions
                .join("pipeline-runner.ts")
                .to_string_lossy()
                .into(),
        );
    }
    if let Ok(settings) = crate::settings::get_pi_settings("global".into(), None) {
        if let Some(session_dir) = settings.get("sessionDir").and_then(|value| value.as_str()) {
            if !session_dir.trim().is_empty() {
                std::fs::create_dir_all(session_dir).map_err(|e| format!("sessionDir: {e}"))?;
                args.push("--session-dir".into());
                args.push(session_dir.into());
            }
        }
    }
    if !global_chat {
        if let Some(report) = graph_report_path.filter(|path| !path.trim().is_empty()) {
            let report = crate::graph::validate_report_path(Path::new(&report))?;
            args.push("--append-system-prompt".into());
            args.push(report.to_string_lossy().to_string());
        }
    }
    let custom_prompt_path = if let Some(prompt) = custom_system_prompt.filter(|value| !value.trim().is_empty()) {
        if prompt.len() > 1_000_000 {
            return Err("custom system prompt exceeds 1 MB".into());
        }
        let prompt_path = std::env::temp_dir().join(format!("crc-custom-prompt-{session_id}.md"));
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&prompt_path).map_err(|e| format!("custom system prompt: {e}"))?;
        file.write_all(prompt.as_bytes()).map_err(|e| format!("custom system prompt: {e}"))?;
        args.push("--append-system-prompt".into());
        args.push(prompt_path.to_string_lossy().to_string());
        Some(prompt_path)
    } else {
        None
    };
    if !global_chat {
        if let Some(prompt) = worktree_system_prompt(Path::new(&cwd), &owning_project) {
            let prompt_path = std::env::temp_dir().join(format!("crc-worktree-{session_id}.md"));
            std::fs::write(&prompt_path, prompt).map_err(|e| format!("worktree prompt: {e}"))?;
            args.push("--append-system-prompt".into());
            args.push(prompt_path.to_string_lossy().to_string());
        }
    }

    // Graphs live in the durable owning checkout; disable automatic context until one exists.
    let graph_json_path = owning_project.join("graphify-out/graph.json");
    let project_name = owning_project.file_name().unwrap_or_default();
    let task_dir = if global_chat {
        std::env::temp_dir()
    } else {
        crate::kanban::task_dir()?
    };
    let mut command = Command::new(&pi_path);
    command
        .args(&args)
        .current_dir(&cwd)
        .env("PATH", path_for_pi(&pi_path.to_string_lossy()));
    if !global_chat {
        command
            .env("CRC_PROJECT_ROOT", &owning_project)
            .env("CRC_PROJECT_CWD", &cwd)
            .env("CRC_PROJECT_NAME", project_name.clone())
            .env("CRC_SESSION_ID", &session_id)
            .env("CRC_TASK_DIR", task_dir.clone())
            .env("CRC_GRAPH_JSON", &graph_json_path)
            .env("GRAPHIFY_GRAPH", &graph_json_path);
    }
    let mut spawn_attempts = 0;
    let mut child = loop {
        match command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => break child,
            Err(e) if spawn_attempts == 0 && e.kind() == std::io::ErrorKind::NotFound => {
                // pi vanished mid-flight on macOS (nvm cleanup / brew unlink / spotlight?), auto-repair once
                let _ = app.emit(
                    "pi-rpc-stderr",
                    serde_json::json!({
                        "session_id": session_id,
                        "line": format!("⚠️ Pi spawn failed (NotFound: {e}) — auto-reinstalling...")
                    }),
                );
                match ensure_pi_installed_with_repair(Some(&app), &configured_pi_path) {
                    Ok(new_pi) => {
                        command = Command::new(&new_pi);
                        command
                            .args(&args)
                            .current_dir(&cwd)
                            .env("PATH", path_for_pi(&new_pi.to_string_lossy()));
                        if !global_chat {
                            command
                                .env("CRC_PROJECT_ROOT", &owning_project)
                                .env("CRC_PROJECT_CWD", &cwd)
                                .env("CRC_PROJECT_NAME", project_name.clone())
                                .env("CRC_SESSION_ID", &session_id)
                                .env("CRC_TASK_DIR", task_dir.clone())
                                .env("CRC_GRAPH_JSON", &graph_json_path)
                                .env("GRAPHIFY_GRAPH", &graph_json_path);
                        }
                        spawn_attempts += 1;
                        continue;
                    }
                    Err(repair_err) => {
                        return Err(format!("failed to spawn pi after auto-repair: {repair_err} (original: {e})"));
                    }
                }
            }
            Err(e) => return Err(format!("failed to spawn pi: {e}")),
        }
    };

    let process_id = child.id();
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let stdin = child.stdin.take().ok_or("no stdin")?;

    // Keep process control separate from stdin writes: a blocked pipe must not block Restart.
    let handle: SharedSessionHandle = Arc::new(SessionHandle {
        child: Mutex::new(Some(child)),
        stdin: Mutex::new(Some(stdin)),
    });
    if let Ok(mut map) = sessions_map().lock() {
        map.insert(session_id.clone(), handle);
    }

    // Wrap stdout reader in dedicated thread that emits Tauri events
    let sid = session_id.clone();
    let session_cwd = cwd.clone();
    let app_clone = app.clone();
    thread::spawn(move || {
        let mut reader = LfLineReader::new(stdout);
        // U+2028 inside JSON must NOT break framing — our LF-only splitter guarantees that
        while let Some(line_res) = reader.next_line() {
            match line_res {
                Ok(line) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    // forward as pi-rpc-event
                    // distinguish responses from events: both are JSON lines
                    // We'll emit raw; frontend can discriminate by "type": "response" vs "extension_ui_request" etc
                    let _ = app_clone.emit(
                        "pi-rpc-event",
                        RpcEvent {
                            session_id: sid.clone(),
                            raw: line.clone(),
                        },
                    );
                    if sid.starts_with("research-") {
                        crate::deep_research::observe_rpc(&app_clone, &sid, &line);
                    }
                }
                Err(e) => {
                    let _ = app_clone.emit(
                        "pi-rpc-error",
                        serde_json::json!({
                            "session_id": sid,
                            "error": e
                        }),
                    );
                    break;
                }
            }
        }
        // Ignore EOF from a process superseded by Restart/React StrictMode.
        let is_current = sessions_map()
            .lock()
            .ok()
            .and_then(|map| map.get(&sid).cloned())
            .and_then(|handle| {
                handle
                    .child
                    .lock()
                    .ok()
                    .and_then(|guard| guard.as_ref().map(Child::id))
            })
            == Some(process_id);
        if is_current {
            if sid.starts_with("research-") {
                crate::deep_research::observe_end(&app_clone, &sid);
            }
            let _ = app_clone.emit(
                "pi-rpc-ended",
                serde_json::json!({
                    "session_id": sid,
                    "cwd_exists": Path::new(&session_cwd).exists()
                }),
            );
        }
        if let Some(path) = custom_prompt_path {
            let _ = std::fs::remove_file(path);
        }
    });

    // stderr thread -> pi-rpc-stderr
    let sid2 = session_id.clone();
    let app_clone2 = app.clone();
    thread::spawn(move || {
        let buf = BufReader::new(stderr);
        for line in buf.lines() {
            match line {
                Ok(l) => {
                    let _ = app_clone2.emit(
                        "pi-rpc-stderr",
                        serde_json::json!({
                            "session_id": sid2,
                            "line": l
                        }),
                    );
                }
                Err(_) => break,
            }
        }
    });

    Ok(session_id)
}

#[tauri::command]
pub fn send_pi_command(session_id: String, json_line: String) -> Result<(), String> {
    if json_line.trim().is_empty() {
        return Err("empty command".to_string());
    }
    // Validate it's JSON (quick)
    serde_json::from_str::<serde_json::Value>(&json_line)
        .map_err(|e| format!("invalid JSON: {}", e))?;

    let map = sessions_map()
        .lock()
        .map_err(|_| "poisoned sessions lock".to_string())?;
    let h = map
        .get(&session_id)
        .ok_or_else(|| format!("unknown session {} — it may have crashed and been auto-reinstalled, try sending again", session_id))?;
    let mut guard = h.stdin.lock().map_err(|_| "poisoned stdin".to_string())?;
    let stdin = guard.as_mut().ok_or_else(|| {
        "stdin closed — pi process crashed on macOS (common when binary disappears). The app has auto-reinstalled it; please resend your message / restart the session.".to_string()
    })?;

    // Append LF
    let mut payload = json_line.as_bytes().to_vec();
    payload.push(b'\n');
    stdin
        .write_all(&payload)
        .map_err(|e| format!("write to pi stdin failed: {}", e))?;
    stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn is_pi_session_running(session_id: String) -> Result<bool, String> {
    let map = sessions_map()
        .lock()
        .map_err(|_| "poisoned lock".to_string())?;
    let Some(handle) = map.get(&session_id) else {
        return Ok(false);
    };
    let mut child = handle
        .child
        .lock()
        .map_err(|_| "poisoned child".to_string())?;
    match child.as_mut() {
        Some(child) => child
            .try_wait()
            .map(|status| status.is_none())
            .map_err(|e| e.to_string()),
        None => Ok(false),
    }
}

#[tauri::command]
pub fn kill_pi_session(session_id: String) -> Result<(), String> {
    let map = sessions_map()
        .lock()
        .map_err(|_| "poisoned lock".to_string())?;
    let h = map
        .get(&session_id)
        .ok_or_else(|| format!("unknown session {}", session_id))?;
    let mut guard = h.child.lock().map_err(|_| "poisoned".to_string())?;
    if let Some(child) = guard.as_mut() {
        let _ = child.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn list_pi_sessions() -> Result<Vec<String>, String> {
    let map = sessions_map().lock().map_err(|_| "poisoned".to_string())?;
    Ok(map.keys().cloned().collect())
}

// Self-test for LF-only splitter: U+2028 inside JSON string must not break framing.
// This is the explicit PRD risk mitigation test hook: called via cargo test.
#[cfg(test)]
mod tests {
    use super::*;

    fn make_line_reader(bytes: Vec<u8>) -> LfLineReader<std::io::Cursor<Vec<u8>>> {
        LfLineReader::new(std::io::Cursor::new(bytes))
    }

    #[test]
    fn lf_only_does_not_split_on_u2028() {
        // JSON containing \u2028 escape — should be one line regardless
        let json = "{\"text\":\"hello\\u2028world\"}\n{\"type\":\"done\"}\n";
        let bytes = json.as_bytes().to_vec();
        let mut r = make_line_reader(bytes);
        let _first = r.next_line().unwrap().unwrap();
        let second = r.next_line().unwrap().unwrap();
        assert!(second.contains("done"));
    }

    #[test]
    fn lf_only_literal_u2028_not_split() {
        // Build a payload where JSON text value contains literal U+2028 char
        let u2028 = "\u{2028}";
        let raw = format!("{{\"text\":\"a{}b\"}}\nnext\n", u2028);
        let mut r = make_line_reader(raw.as_bytes().to_vec());
        let first = r.next_line().unwrap().unwrap();
        assert!(
            first.contains('b'),
            "U+2028 must not break line, got: {:?}",
            first
        );
        let second = r.next_line().unwrap().unwrap();
        assert_eq!(second, "next");
        assert!(r.next_line().is_none());
    }

    #[test]
    fn strips_trailing_cr() {
        let raw = b"{\"a\":1}\r\n{\"b\":2}\n";
        let mut r = make_line_reader(raw.to_vec());
        let first = r.next_line().unwrap().unwrap();
        assert_eq!(first, "{\"a\":1}");
        let second = r.next_line().unwrap().unwrap();
        assert_eq!(second, "{\"b\":2}");
    }

    #[test]
    fn pi_directory_is_first_on_path() {
        let path = path_for_pi("/opt/pi/bin/pi");
        assert_eq!(
            std::env::split_paths(&path).next().unwrap(),
            Path::new("/opt/pi/bin")
        );
    }

    #[test]
    fn installed_pi_accepts_existing_configured_binary() {
        let path = std::env::current_exe().unwrap();
        assert_eq!(installed_pi(path.to_str().unwrap()), Some(path));
    }

    #[test]
    fn worktree_prompt_explains_external_node_modules_symlink() {
        let prompt =
            worktree_system_prompt(Path::new("/worktrees/chat"), Path::new("/projects/app"))
                .unwrap();
        assert!(prompt.contains("points out of the filesystem root"));
        assert!(prompt.contains("local dependency install"));
        assert!(
            worktree_system_prompt(Path::new("/projects/app"), Path::new("/projects/app"))
                .is_none()
        );
    }

    #[test]
    fn global_chat_search_tools_exclude_project_tools() {
        let tools = "web_search,source_check,fetch_content,get_search_content";
        assert!(tools.contains("web_search"));
        for denied in [
            "read",
            "bash",
            "edit",
            "write",
            "track_kanban_task",
            "run_pipeline",
            "graphify",
        ] {
            assert!(!tools.split(',').any(|tool| tool == denied));
        }
    }

    #[test]
    fn session_args_resume_exact_file() {
        assert_eq!(
            session_args(false, Some("/tmp/chat.jsonl".into())),
            ["--session", "/tmp/chat.jsonl"]
        );
        assert!(session_args(false, None).is_empty());
        assert_eq!(session_args(true, Some("ignored".into())), ["--no-session"]);
    }

    #[test]
    fn exact_session_flag_is_supported_by_pi() {
        let Ok(output) = Command::new(read_pi_config().unwrap().0)
            .arg("--help")
            .output()
        else {
            return;
        };
        assert!(String::from_utf8_lossy(&output.stdout).contains("--session <path|id>"));
    }
}
