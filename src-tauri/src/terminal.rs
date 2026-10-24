use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const SCROLLBACK_CAP: usize = 256 * 1024; // bytes retained for replay on re-open
                                          // Snapshots are for restoring after an app restart, not per read: writing the
                                          // whole scrollback on every PTY read stalled heavy output (installs, builds).
const SNAPSHOT_INTERVAL: Duration = Duration::from_millis(1000);

/// Bytes at the end of `bytes` that start a UTF-8 sequence the read cut short.
/// They are held back so a multi-byte glyph split across reads is not emitted
/// as replacement characters.
fn incomplete_utf8_tail(bytes: &[u8]) -> usize {
    for back in 1..=bytes.len().min(3) {
        let byte = bytes[bytes.len() - back];
        if byte & 0b1100_0000 == 0b1000_0000 {
            continue; // continuation byte: keep looking for the lead byte
        }
        let needed = match byte {
            b if b & 0b1110_0000 == 0b1100_0000 => 2,
            b if b & 0b1111_0000 == 0b1110_0000 => 3,
            b if b & 0b1111_1000 == 0b1111_0000 => 4,
            _ => return 0, // ASCII or invalid lead: nothing to hold back
        };
        return if needed > back { back } else { 0 };
    }
    0
}

/// macOS GUI apps start without a locale, so shells fall back to "C" and
/// mangle non-ASCII output. Mirror Terminal.app's UTF-8 default.
fn locale_fallback() -> Option<&'static str> {
    let has_locale = ["LC_ALL", "LC_CTYPE", "LANG"].iter().any(|key| {
        std::env::var(key)
            .map(|value| !value.is_empty())
            .unwrap_or(false)
    });
    (!has_locale).then_some("en_US.UTF-8")
}

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
                    // Interactive shell: a human is in the loop and sees the prompt, so a deleted
                    // worktree falls back to the nearest living ancestor instead of dying.
    let (live_cwd, _) = crate::projects::resolve_live_dir(Path::new(&cwd));
    cmd.cwd(&live_cwd);
    // no PATH override: an interactive login shell rebuilds it from the user's rc files
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(lang) = locale_fallback() {
        cmd.env("LANG", lang);
    }
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
    let dirty = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    {
        // Persist the scrollback at most once per interval, off the read path.
        let (dirty, finished, scrollback, chat_id) = (
            dirty.clone(),
            finished.clone(),
            scrollback.clone(),
            chat_id.clone(),
        );
        thread::spawn(move || {
            while !finished.load(Ordering::Acquire) {
                thread::sleep(SNAPSHOT_INTERVAL);
                if !dirty.swap(false, Ordering::AcqRel) {
                    continue;
                }
                // Checked under the lock the reader takes when it finishes, so
                // a write can never land after the snapshot is removed.
                if let Ok(sb) = scrollback.lock() {
                    if finished.load(Ordering::Acquire) {
                        break;
                    }
                    write_snapshot(&chat_id, &sb);
                }
            }
        });
    }
    thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut pending: Vec<u8> = Vec::new();
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
                    }
                    dirty.store(true, Ordering::Release);
                    pending.extend_from_slice(&buf[..n]);
                    let keep = incomplete_utf8_tail(&pending);
                    let tail = pending.split_off(pending.len() - keep);
                    if !pending.is_empty() {
                        let chunk = String::from_utf8_lossy(&pending).into_owned();
                        let _ = app.emit(&event, chunk);
                    }
                    pending = tail;
                }
            }
        }
        // Hold the scrollback lock so an in-flight snapshot write finishes first.
        let guard = scrollback.lock();
        finished.store(true, Ordering::Release);
        drop(guard);
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
        // One-shot approved commands never silently change directory: the approval
        // was for THIS cwd. Fail actionable instead.
        if !Path::new(&cwd).is_dir() {
            let (live, _) = crate::projects::resolve_live_dir(Path::new(&cwd));
            return Err(format!(
                "cwd deleted (nearest live: {}); re-run from a live directory",
                live.display()
            ));
        }
        // `-lc` skips ~/.zshrc, so approved commands get the same shell-token import as agents.
        let mut approved = std::process::Command::new(
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()),
        );
        approved.args(["-lc", &command]).current_dir(&cwd);
        for (k, v) in crate::projects::shell_token_env() {
            approved.env(k, v);
        }
        let output = approved.output().map_err(|error| error.to_string())?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(format!(
            "exit code: {}\n{}",
            output.status.code().unwrap_or(-1),
            text.trim()
        ))
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
    use super::{incomplete_utf8_tail, snapshot_path};

    #[test]
    fn holds_back_only_a_cut_off_utf8_sequence() {
        let glyph = "\u{e0b0}".as_bytes(); // powerline arrow, 3 bytes
        assert_eq!(incomplete_utf8_tail(b"ls -la"), 0);
        assert_eq!(incomplete_utf8_tail(glyph), 0);
        assert_eq!(incomplete_utf8_tail(&glyph[..1]), 1);
        assert_eq!(incomplete_utf8_tail(&glyph[..2]), 2);
        let mut cut = b"prompt ".to_vec();
        cut.extend_from_slice(&"\u{1f680}".as_bytes()[..3]); // rocket, 4 bytes
        assert_eq!(incomplete_utf8_tail(&cut), 3);
        assert_eq!(incomplete_utf8_tail(&[0xff]), 0);
    }

    #[test]
    fn terminal_snapshot_ids_cannot_escape_the_snapshot_directory() {
        assert!(snapshot_path("chat-123__0").is_ok());
        assert!(snapshot_path("../other").is_err());
        assert!(snapshot_path("chat/other").is_err());
    }
}
