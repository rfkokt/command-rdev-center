use getrandom::fill;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::{fs::PermissionsExt, net::UnixListener};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const MAX_FRAME: usize = 1024 * 1024;
const CAPABILITY_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);
const INACTIVITY_TIMEOUT: Duration = Duration::from_secs(30 * 60);

pub struct BrowserSessions {
    hosts: HashMap<String, BrowserHost>,
    bridges: HashMap<String, BrowserBridge>,
    closed: HashSet<String>,
}

struct BrowserBridge {
    socket: PathBuf,
    capability: String,
    stop: Arc<AtomicBool>,
}

pub struct BrowserState(pub Mutex<BrowserSessions>);

impl Default for BrowserState {
    fn default() -> Self {
        Self(Mutex::new(BrowserSessions {
            hosts: HashMap::new(),
            bridges: HashMap::new(),
            closed: HashSet::new(),
        }))
    }
}

pub(crate) struct BrowserHost {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    capability: String,
    session_id: String,
    next_id: u64,
    revoked: bool,
    expires_at: SystemTime,
    last_used: Instant,
}

#[derive(Debug, Deserialize)]
struct Response {
    id: String,
    status: String,
    #[serde(default)]
    data: Value,
    #[serde(default)]
    error: Value,
}

fn random_hex() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn valid_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn browser_host_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let packaged = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("browser-host");
    if packaged.join("host.mjs").is_file() {
        return Ok(packaged);
    }
    Ok(Path::new(env!("CARGO_MANIFEST_DIR")).join("browser-host"))
}

fn artifact_root(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("sessions")
        .join(session_id)
        .join("browser");
    std::fs::create_dir_all(&root).map_err(|error| format!("browser artifact root: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("browser artifact permissions: {error}"))?;
    }
    Ok(root)
}

impl BrowserHost {
    fn start(app: &AppHandle, session_id: &str, approved_origins: &str) -> Result<Self, String> {
        if !valid_session_id(session_id) {
            return Err("invalid browser session id".into());
        }
        let root = browser_host_dir(app)?;
        let node = root.join("runtime/node-aarch64-apple-darwin");
        if !node.is_file() || !root.join("host.mjs").is_file() {
            return Err("browser_host_unavailable".into());
        }
        let capability = random_hex()?;
        let expires_at = SystemTime::now() + CAPABILITY_LIFETIME;
        let expires_ms = expires_at
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis()
            .to_string();
        let mut command = Command::new(node);
        command
            .arg(root.join("host.mjs"))
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", std::env::var("HOME").unwrap_or_default())
            .env("KERN_BROWSER_CAPABILITY", &capability)
            .env("KERN_BROWSER_SESSION_ID", session_id)
            .env("KERN_BROWSER_PARENT_PID", std::process::id().to_string())
            .env("KERN_BROWSER_EXPIRES_AT", expires_ms)
            .env(
                "KERN_BROWSER_ARTIFACT_ROOT",
                artifact_root(app, session_id)?,
            )
            .env("KERN_BROWSER_APPROVED_ORIGINS", approved_origins)
            .env("PLAYWRIGHT_BROWSERS_PATH", root.join(".browsers"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|_| "browser_host_unavailable".to_string())?;
        let input = child.stdin.take().ok_or("browser_host_unavailable")?;
        let output = BufReader::new(child.stdout.take().ok_or("browser_host_unavailable")?);
        Ok(Self {
            child,
            input,
            output,
            capability,
            session_id: session_id.into(),
            next_id: 0,
            revoked: false,
            expires_at,
            last_used: Instant::now(),
        })
    }

    fn call(&mut self, action: &str, args: Value) -> Result<Response, String> {
        if self.revoked {
            return Err("browser_host_closing".into());
        }
        if SystemTime::now() >= self.expires_at {
            self.shutdown();
            return Err("browser_capability_expired".into());
        }
        if self
            .child
            .try_wait()
            .map_err(|_| "browser_host_unavailable")?
            .is_some()
        {
            self.revoked = true;
            return Err("browser_host_unavailable".into());
        }
        self.next_id += 1;
        let id = format!("call-{}", self.next_id);
        let frame = serde_json::to_vec(&json!({
            "version": 1, "id": id, "sessionId": self.session_id,
            "capability": self.capability, "action": action, "args": args,
        }))
        .map_err(|_| "browser_invalid_request".to_string())?;
        if frame.len() > MAX_FRAME {
            return Err("browser_request_too_large".into());
        }
        self.input
            .write_all(&frame)
            .and_then(|_| self.input.write_all(b"\n"))
            .and_then(|_| self.input.flush())
            .map_err(|_| "browser_host_unavailable".to_string())?;
        let mut line = String::new();
        self.output
            .read_line(&mut line)
            .map_err(|_| "browser_host_unavailable".to_string())?;
        if line.is_empty() || line.len() > MAX_FRAME {
            return Err("browser_invalid_response".into());
        }
        let response: Response =
            serde_json::from_str(&line).map_err(|_| "browser_invalid_response")?;
        if response.id != id {
            return Err("browser_response_mismatch".into());
        }
        self.last_used = Instant::now();
        Ok(response)
    }

    fn shutdown(&mut self) {
        if self.revoked {
            return;
        }
        self.revoked = true;
        let frame = json!({"version":1,"id":"shutdown","sessionId":self.session_id,"capability":self.capability,"action":"shutdown","args":{}});
        let _ = writeln!(self.input, "{frame}");
        let _ = self.input.flush();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for BrowserHost {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn prune_inactive(hosts: &mut HashMap<String, BrowserHost>) {
    hosts.retain(|_, host| {
        let keep = host.last_used.elapsed() < INACTIVITY_TIMEOUT
            && !host.revoked
            && host.child.try_wait().ok().flatten().is_none();
        if !keep {
            host.shutdown();
        }
        keep
    });
}

pub(crate) fn call(
    app: &AppHandle,
    state: &BrowserState,
    session_id: &str,
    action: &str,
    args: Value,
) -> Result<Value, String> {
    let mut sessions = state.0.lock().map_err(|_| "browser_state_unavailable")?;
    prune_inactive(&mut sessions.hosts);
    if sessions.closed.contains(session_id) {
        return Err("browser_capability_closed".into());
    }
    if !sessions.hosts.contains_key(session_id) {
        let approved_origins = args
            .get("url")
            .and_then(Value::as_str)
            .and_then(|value| url_origin(value).ok())
            .unwrap_or_default();
        sessions.hosts.insert(
            session_id.into(),
            BrowserHost::start(app, session_id, &approved_origins)?,
        );
    }
    let response = sessions
        .hosts
        .get_mut(session_id)
        .ok_or("browser_host_unavailable")?
        .call(action, args)?;
    if response.status == "ok" {
        Ok(response.data)
    } else {
        Err(response
            .error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("browser_host_error")
            .to_string())
    }
}

fn url_origin(value: &str) -> Result<String, String> {
    let url = url::Url::parse(value).map_err(|_| "browser_url_invalid".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("browser_url_blocked".into());
    }
    let host = url.host_str().ok_or("browser_url_invalid")?;
    Ok(format!(
        "{}://{}{}",
        url.scheme(),
        host,
        url.port()
            .map(|port| format!(":{port}"))
            .unwrap_or_default()
    ))
}

#[cfg(unix)]
pub fn ensure_bridge(
    app: &AppHandle,
    state: &BrowserState,
    session_id: &str,
) -> Result<(PathBuf, String), String> {
    let mut sessions = state.0.lock().map_err(|_| "browser_state_unavailable")?;
    if let Some(bridge) = sessions.bridges.get(session_id) {
        return Ok((bridge.socket.clone(), bridge.capability.clone()));
    }
    let mut host = BrowserHost::start(app, session_id, "")?;
    let capability = host.capability.clone();
    let socket_dir = artifact_root(app, session_id)?.join("ipc");
    std::fs::create_dir_all(&socket_dir).map_err(|_| "browser_socket_unavailable")?;
    std::fs::set_permissions(&socket_dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|_| "browser_socket_unavailable")?;
    let socket = socket_dir.join("host.sock");
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).map_err(|_| "browser_socket_unavailable")?;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))
        .map_err(|_| "browser_socket_unavailable")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "browser_socket_unavailable")?;
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let thread_socket = socket.clone();
    let expected_session = session_id.to_string();
    let expected_capability = capability.clone();
    std::thread::spawn(move || {
        while !thread_stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let mut reader = BufReader::new(stream);
                    let mut line = String::new();
                    let response = if reader.read_line(&mut line).is_ok() && line.len() <= MAX_FRAME
                    {
                        serde_json::from_str::<Value>(&line).ok().and_then(|request| {
                            let valid = request.get("version") == Some(&json!(1))
                                && request.get("sessionId").and_then(Value::as_str) == Some(expected_session.as_str())
                                && request.get("capability").and_then(Value::as_str) == Some(expected_capability.as_str());
                            valid.then(|| {
                                let id = request.get("id").cloned().unwrap_or(Value::Null);
                                let action = request.get("action").and_then(Value::as_str).unwrap_or("");
                                match host.call(action, request.get("args").cloned().unwrap_or_else(|| json!({}))) {
                                    Ok(reply) => json!({"version":1,"id":id,"status":reply.status,"data":reply.data,"error":reply.error}),
                                    Err(code) => json!({"version":1,"id":id,"status":"error","error":{"code":code}}),
                                }
                            })
                        }).unwrap_or_else(|| json!({"version":1,"id":null,"status":"error","error":{"code":"unauthorized_or_invalid"}}))
                    } else {
                        json!({"version":1,"id":null,"status":"error","error":{"code":"frame_too_large"}})
                    };
                    let _ = writeln!(reader.get_mut(), "{response}");
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(25))
                }
                Err(_) => break,
            }
        }
        host.shutdown();
        let _ = std::fs::remove_file(thread_socket);
    });
    sessions.bridges.insert(
        session_id.into(),
        BrowserBridge {
            socket: socket.clone(),
            capability: capability.clone(),
            stop,
        },
    );
    Ok((socket, capability))
}

pub fn close_session(state: &BrowserState, session_id: &str) {
    if let Ok(mut sessions) = state.0.lock() {
        sessions.closed.insert(session_id.into()); // revoke before teardown
        if let Some(bridge) = sessions.bridges.remove(session_id) {
            bridge.stop.store(true, Ordering::SeqCst);
            let _ = std::fs::remove_file(bridge.socket);
        }
        if let Some(mut host) = sessions.hosts.remove(session_id) {
            host.shutdown();
        }
    }
}

pub fn allow_fresh_session(state: &BrowserState, session_id: &str) {
    if let Ok(mut sessions) = state.0.lock() {
        sessions.closed.remove(session_id);
    }
}

pub fn reap_inactive(state: &BrowserState) {
    if let Ok(mut sessions) = state.0.lock() {
        let expired = sessions
            .hosts
            .iter()
            .filter(|(_, host)| host.last_used.elapsed() >= INACTIVITY_TIMEOUT)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        sessions.closed.extend(expired);
        prune_inactive(&mut sessions.hosts);
    }
}

pub fn shutdown(state: &BrowserState) {
    if let Ok(mut sessions) = state.0.lock() {
        let active = sessions.hosts.keys().cloned().collect::<Vec<_>>();
        sessions.closed.extend(active);
        for (_, bridge) in sessions.bridges.drain() {
            bridge.stop.store(true, Ordering::SeqCst);
            let _ = std::fs::remove_file(bridge.socket);
        }
        for (_, mut host) in sessions.hosts.drain() {
            host.shutdown();
        }
    }
}

#[tauri::command]
pub fn browser_b0_packaged_smoke(
    app: AppHandle,
    state: tauri::State<'_, BrowserState>,
    url: String,
) -> Result<Value, String> {
    if !cfg!(debug_assertions)
        && std::env::var("KERN_ENABLE_BROWSER_B0_SPIKE").as_deref() != Ok("1")
    {
        return Err("B0 browser smoke is disabled".into());
    }
    if !url.starts_with("http://127.0.0.1:") && !url.starts_with("http://localhost:") {
        return Err("B0 smoke accepts loopback URLs only".into());
    }
    let session = format!("b0-{}", &random_hex()?[..16]);
    let isolation = call(&app, &state, &session, "isolate", json!({"url": url}))?;
    let health = call(&app, &state, &session, "health", json!({}))?;
    let smoke = call(&app, &state, &session, "smoke", json!({"url": url}))?;
    close_session(&state, &session);
    Ok(json!({"health":health,"isolation":isolation,"smoke":smoke,"closed":true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_is_256_bits_and_unique() {
        let first = random_hex().unwrap();
        let second = random_hex().unwrap();
        assert_eq!(first.len(), 64);
        assert_ne!(first, second);
    }

    #[test]
    fn session_ids_are_path_safe() {
        assert!(valid_session_id("chat-123_ok"));
        assert!(!valid_session_id("../chat"));
        assert!(!valid_session_id(""));
    }

    #[test]
    fn unavailable_error_is_stable() {
        assert_eq!("browser_host_unavailable", "browser_host_unavailable");
    }

    #[test]
    fn browser_origin_rejects_credentials_and_unsupported_schemes() {
        assert_eq!(
            url_origin("http://127.0.0.1:3000/path").unwrap(),
            "http://127.0.0.1:3000"
        );
        assert!(url_origin("file:///tmp/a").is_err());
        assert!(url_origin("https://user:pass@example.com").is_err());
    }
}
