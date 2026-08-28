use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use tauri::{AppHandle, Emitter};

const SCROLLBACK_CAP: usize = 256 * 1024; // bytes retained for replay on re-open

// One PTY per chat id. Writer/child for input/resize/kill; scrollback for replay.
struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    scrollback: Arc<Mutex<Vec<u8>>>,
}

// ponytail: one global lock over all sessions; per-session lock only if terminals get chatty
static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn snapshot_dir() -> PathBuf {
    std::env::temp_dir().join("command-rdev-center-terminals")
}

fn snapshot_path(chat_id: &str) -> Result<PathBuf, String> {
    if chat_id.is_empty()
        || !chat_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid terminal session id".into());
    }
    Ok(snapshot_dir().join(format!("{chat_id}.log")))
}

fn write_snapshot(chat_id: &str, bytes: &[u8]) {
    let Ok(path) = snapshot_path(chat_id) else {
        return;
    };
    if std::fs::create_dir_all(snapshot_dir()).is_ok() {
        let temporary = path.with_extension("tmp");
        if std::fs::write(&temporary, bytes).is_ok() {
            let _ = std::fs::rename(temporary, path);
        }
    }
}

fn remove_snapshot(chat_id: &str) {
    if let Ok(path) = snapshot_path(chat_id) {
        let _ = std::fs::remove_file(path);
    }
}

// Returns retained scrollback so the frontend can replay it (empty for a fresh session).
#[tauri::command]
pub fn terminal_open(
    app: AppHandle,
    chat_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    // The app-owned Global Chat directory is intentionally not an imported project.
    // It is the only non-project cwd permitted to host a terminal.
    if crate::pi_rpc::global_chat_cwd()
        .map(|global| global != Path::new(&cwd))
        .unwrap_or(true)
    {
        crate::projects::ensure_path_allowed(Path::new(&cwd))?;
    }
    {
        let map = sessions().lock().map_err(|e| e.to_string())?;
        if let Some(s) = map.get(&chat_id) {
            let sb = s.scrollback.lock().map_err(|e| e.to_string())?;
            return Ok(String::from_utf8_lossy(&sb).into_owned());
        }
    }

    let pty = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-il"); // interactive login shell: sources .zprofile + .zshrc so nvm/aliases/PATH match Terminal.app
    cmd.cwd(&cwd);
    // no PATH override: an interactive login shell rebuilds it from the user's rc files
    cmd.env("TERM", "xterm-256color");
    // nvm refuses to load when npm_config_prefix is set (inherited from the app's parent env)
    cmd.env_remove("npm_config_prefix");
    cmd.env_remove("NPM_CONFIG_PREFIX");

    let child = pty.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pty.slave);
    let writer = pty.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;

    let scrollback = Arc::new(Mutex::new(Vec::new()));
    sessions().lock().map_err(|e| e.to_string())?.insert(
        chat_id.clone(),
        Session {
            writer,
            master: pty.master,
            child,
            scrollback: scrollback.clone(),
        },
    );

    let event = format!("terminal://data/{chat_id}");
    let exit_event = format!("terminal://exit/{chat_id}");
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut sb) = scrollback.lock() {
                        sb.extend_from_slice(&buf[..n]);
                        if sb.len() > SCROLLBACK_CAP {
                            let drop_to = sb.len() - SCROLLBACK_CAP;
                            sb.drain(..drop_to);
                        }
                        write_snapshot(&chat_id, &sb);
                    }
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app.emit(&event, chunk);
                }
            }
        }
        let _ = app.emit(&exit_event, ());
        let _ = sessions().lock().map(|mut m| m.remove(&chat_id));
        remove_snapshot(&chat_id);
    });
    Ok(String::new())
}

#[tauri::command]
pub async fn terminal_execute_approved(cwd: String, command: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::projects::ensure_path_allowed(Path::new(&cwd))?;
        let output = std::process::Command::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()))
            .args(["-lc", &command])
            .current_dir(&cwd)
            .output()
            .map_err(|error| error.to_string())?;
        let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        Ok(format!("exit code: {}\n{}", output.status.code().unwrap_or(-1), text.trim()))
    })
    .await
    .map_err(|error| format!("Approved terminal worker failed: {error}"))?
}

#[tauri::command]
pub fn terminal_write(chat_id: String, data: String) -> Result<(), String> {
    let mut map = sessions().lock().map_err(|e| e.to_string())?;
    let s = map.get_mut(&chat_id).ok_or("no terminal session")?;
    s.writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn terminal_resize(chat_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = sessions().lock().map_err(|e| e.to_string())?;
    let s = map.get(&chat_id).ok_or("no terminal session")?;
    s.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

// Kill the shell + child processes and drop the session.
#[tauri::command]
pub fn terminal_close(chat_id: String) -> Result<(), String> {
    if let Some(mut s) = sessions()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&chat_id)
    {
        let _ = s.child.kill();
    }
    remove_snapshot(&chat_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::snapshot_path;

    #[test]
    fn terminal_snapshot_ids_cannot_escape_the_snapshot_directory() {
        assert!(snapshot_path("chat-123__0").is_ok());
        assert!(snapshot_path("../other").is_err());
        assert!(snapshot_path("chat/other").is_err());
    }
}
