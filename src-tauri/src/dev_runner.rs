use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::net::{TcpListener, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

static RUNNERS: OnceLock<Mutex<HashMap<String, Child>>> = OnceLock::new();
static REGISTRY_LOCK: Mutex<()> = Mutex::new(());

fn runners() -> &'static Mutex<HashMap<String, Child>> {
    RUNNERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn shell_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    let nvm_bins = std::fs::read_dir(format!("{home}/.nvm/versions/node"))
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("bin"))
        .filter(|path| path.is_dir())
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(":");
    format!("{nvm_bins}:{home}/.cargo/bin:{home}/.local/bin:{home}/.npm-global/bin:{home}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{current}")
}

#[derive(Clone, Serialize)]
pub struct DevRunnerInfo {
    pub command: String,
    pub url: String,
    pub running: bool,
    pub error: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct DevRunnerRecord {
    chat_id: String,
    cwd: String,
    command: String,
    url: String,
    process_group: u32,
    #[serde(default)]
    process_command: String,
    #[serde(default)]
    log_path: String,
}

fn read_log_tail(path: &str) -> String {
    let Ok(mut file) = std::fs::File::open(path) else {
        return "No dev-server.log output available.".into();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = file.seek(SeekFrom::Start(len.saturating_sub(8_000)));
    let mut output = String::new();
    let _ = file.read_to_string(&mut output);
    output.trim().to_string()
}

fn registry_path() -> std::path::PathBuf {
    std::env::temp_dir().join("command-rdev-center-dev-runners.json")
}

fn read_records() -> Vec<DevRunnerRecord> {
    std::fs::read_to_string(registry_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_records(records: &[DevRunnerRecord]) -> Result<(), String> {
    let path = registry_path();
    let tmp = path.with_extension("tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec(records).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}

fn record_is_live(record: &DevRunnerRecord) -> bool {
    if let Ok(mut children) = runners().lock() {
        if let Some(child) = children.get_mut(&record.chat_id) {
            if child.try_wait().is_ok_and(|status| status.is_none()) {
                return true;
            }
        }
    }
    if record.process_command.is_empty() {
        return false;
    }
    let process_group = record.process_group.to_string();
    let command_matches = Command::new("ps")
        .args(["-axo", "pgid=,command="])
        .output()
        .is_ok_and(|output| {
            output.status.success()
                && String::from_utf8_lossy(&output.stdout).lines().any(|line| {
                    let mut fields = line.trim().splitn(2, char::is_whitespace);
                    fields.next() == Some(process_group.as_str())
                        && fields
                            .next()
                            .is_some_and(|command| command.contains(&record.process_command))
                })
        });
    let port = record
        .url
        .rsplit(':')
        .next()
        .and_then(|value| value.parse::<u16>().ok());
    command_matches && port.is_some_and(|port| TcpStream::connect(("127.0.0.1", port)).is_ok())
}

fn take_live_record(
    records: &mut Vec<DevRunnerRecord>,
    chat_id: &str,
    cwd: &str,
    mut is_live: impl FnMut(&DevRunnerRecord) -> bool,
) -> Option<DevRunnerRecord> {
    let index = records
        .iter()
        .position(|record| record.chat_id == chat_id && record.cwd == cwd)?;
    if is_live(&records[index]) {
        Some(records.remove(index))
    } else {
        records.remove(index);
        None
    }
}

fn project_runner_chat_ids(
    records: &[DevRunnerRecord],
    project: &Path,
    mut owner: impl FnMut(&Path) -> Option<std::path::PathBuf>,
) -> Vec<String> {
    records
        .iter()
        .filter(|record| owner(Path::new(&record.cwd)).as_deref() == Some(project))
        .map(|record| record.chat_id.clone())
        .collect()
}

fn stop_project_dev_servers(project: &Path) -> Result<(), String> {
    let chat_ids = project_runner_chat_ids(&read_records(), project, |cwd| {
        crate::projects::ensure_path_allowed(cwd).ok()
    });
    for chat_id in chat_ids {
        stop_dev_server_blocking(chat_id)?;
    }
    Ok(())
}

fn remove_record(chat_id: &str) -> Result<Option<DevRunnerRecord>, String> {
    let _lock = REGISTRY_LOCK
        .lock()
        .map_err(|_| "dev runner registry lock poisoned")?;
    let mut records = read_records();
    let removed = records
        .iter()
        .position(|record| record.chat_id == chat_id)
        .map(|index| records.remove(index));
    write_records(&records)?;
    Ok(removed)
}

fn ensure_node_modules(cwd: &Path, project: &Path) -> Result<(), String> {
    let target = cwd.join("node_modules");
    let source = project.join("node_modules");
    if target.exists() {
        return Ok(());
    }
    if !source.exists() {
        return Err(format!(
            "dependencies missing: run install once in {}",
            project.display()
        ));
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(source, target).map_err(|e| e.to_string())?;
    Ok(())
}

fn detect_command(cwd: &Path) -> Result<String, String> {
    if cwd.join("package.json").exists() {
        let raw = std::fs::read_to_string(cwd.join("package.json")).map_err(|e| e.to_string())?;
        let package: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if package
            .pointer("/scripts/dev")
            .and_then(|v| v.as_str())
            .is_none()
        {
            return Err("package.json has no dev script".into());
        }
        return Ok(if cwd.join("pnpm-lock.yaml").exists() {
            "pnpm dev"
        } else if cwd.join("yarn.lock").exists() {
            "yarn dev"
        } else if cwd.join("bun.lock").exists() || cwd.join("bun.lockb").exists() {
            "bun run dev"
        } else {
            "npm run dev"
        }
        .into());
    }
    if cwd.join("Cargo.toml").exists() {
        return Ok("cargo run".into());
    }
    Err("No supported dev command detected".into())
}

#[tauri::command]
pub fn detect_dev_command(cwd: String) -> Result<String, String> {
    crate::projects::ensure_path_allowed(Path::new(&cwd))?;
    detect_command(Path::new(&cwd))
}

#[tauri::command]
pub async fn start_dev_server(
    chat_id: String,
    cwd: String,
    command: String,
) -> Result<DevRunnerInfo, String> {
    tauri::async_runtime::spawn_blocking(move || start_dev_server_blocking(chat_id, cwd, command))
        .await
        .map_err(|e| format!("Dev-server start worker failed: {e}"))?
}

fn start_dev_server_blocking(
    chat_id: String,
    cwd: String,
    command: String,
) -> Result<DevRunnerInfo, String> {
    let project = crate::projects::ensure_path_allowed(Path::new(&cwd))?;
    let detected = detect_command(Path::new(&cwd))?;
    let allowed = if Path::new(&cwd).join("package.json").exists() {
        ["npm run dev", "pnpm dev", "yarn dev", "bun run dev"].contains(&command.as_str())
    } else {
        command == detected
    };
    if !allowed {
        return Err("unsupported dev command".into());
    }
    ensure_node_modules(Path::new(&cwd), &project)?;
    stop_project_dev_servers(&project)?;
    let port = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| e.to_string())?
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    let dev_script = std::fs::read_to_string(Path::new(&cwd).join("package.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|package| {
            package
                .pointer("/scripts/dev")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        });
    let next = dev_script
        .as_deref()
        .is_some_and(|script| script.split_whitespace().next() == Some("next"));
    let webpack = next
        && !dev_script
            .as_deref()
            .is_some_and(|script| script.split_whitespace().any(|arg| arg == "--webpack"));
    let separator = if command.starts_with("npm ") {
        " --"
    } else {
        ""
    };
    let run_command = if command == "cargo run" {
        command.clone()
    } else if webpack {
        format!("{command}{separator} --webpack --port {port}")
    } else {
        format!("{command}{separator} --port {port}")
    };
    let path = shell_path();
    let project_bins = project.join("node_modules/.bin");
    let log_path = std::env::temp_dir().join(format!("command-rdev-center-dev-{chat_id}.log"));
    let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let mut child = Command::new("sh")
        .args(["-c", &run_command])
        .current_dir(&cwd)
        .env("PATH", format!("{}:{path}", project_bins.display()))
        .env("NODE_PATH", project.join("node_modules"))
        .env("PORT", port.to_string())
        .env("VITE_PORT", port.to_string())
        .process_group(0)
        .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|e| e.to_string())?;

    let mut ready_checks = 0;
    for _ in 0..150 {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!(
                "dev server exited before startup ({status}): {}",
                read_log_tail(&log_path.to_string_lossy())
            ));
        }
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            ready_checks += 1;
            if ready_checks == 10 {
                let url = format!("http://localhost:{port}");
                let record = DevRunnerRecord {
                    chat_id: chat_id.clone(),
                    cwd,
                    command: command.clone(),
                    url: url.clone(),
                    process_group: child.id(),
                    process_command: run_command,
                    log_path: log_path.to_string_lossy().into_owned(),
                };
                {
                    let _lock = REGISTRY_LOCK
                        .lock()
                        .map_err(|_| "dev runner registry lock poisoned")?;
                    let mut records = read_records();
                    records.retain(|item| item.chat_id != chat_id);
                    records.push(record);
                    if let Err(error) = write_records(&records) {
                        kill_process_group(&mut child);
                        return Err(error);
                    }
                }
                if let Err(error) = runners()
                    .lock()
                    .map_err(|_| "dev runner lock poisoned")
                    .map(|mut runners| runners.insert(chat_id.clone(), child))
                {
                    if let Some(record) = remove_record(&chat_id)? {
                        let _ = Command::new("kill")
                            .args(["-TERM", &format!("-{}", record.process_group)])
                            .status();
                    }
                    return Err(error.into());
                }
                return Ok(DevRunnerInfo {
                    command,
                    url,
                    running: true,
                    error: None,
                });
            }
        } else {
            ready_checks = 0;
        }
        thread::sleep(Duration::from_millis(100));
    }
    kill_process_group(&mut child);
    Err("dev server did not become reachable within 15 seconds".into())
}

fn kill_process_group(child: &mut Child) {
    let group = format!("-{}", child.id());
    let _ = Command::new("kill").args(["-TERM", &group]).status();
    for _ in 0..20 {
        if child.try_wait().is_ok_and(|status| status.is_some()) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = Command::new("kill").args(["-KILL", &group]).status();
    let _ = child.wait();
}

fn kill_port_listener(url: &str) {
    let Some(port) = url
        .rsplit(':')
        .next()
        .and_then(|value| value.parse::<u16>().ok())
    else {
        return;
    };
    let port_arg = format!("-iTCP:{port}");
    let Ok(output) = Command::new("lsof")
        .args(["-nP", "-t", &port_arg, "-sTCP:LISTEN"])
        .output()
    else {
        return;
    };
    for pid in String::from_utf8_lossy(&output.stdout).split_whitespace() {
        let _ = Command::new("kill").args(["-TERM", pid]).status();
    }
    for _ in 0..20 {
        if TcpStream::connect(("127.0.0.1", port)).is_err() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    if let Ok(output) = Command::new("lsof")
        .args(["-nP", "-t", &port_arg, "-sTCP:LISTEN"])
        .output()
    {
        for pid in String::from_utf8_lossy(&output.stdout).split_whitespace() {
            let _ = Command::new("kill").args(["-KILL", pid]).status();
        }
    }
}

#[tauri::command]
pub fn get_dev_server(chat_id: String, cwd: String) -> Result<Option<DevRunnerInfo>, String> {
    crate::projects::ensure_path_allowed(Path::new(&cwd))?;
    let _lock = REGISTRY_LOCK
        .lock()
        .map_err(|_| "dev runner registry lock poisoned")?;
    let mut records = read_records();
    let stopped = records
        .iter()
        .find(|record| record.chat_id == chat_id && record.cwd == cwd)
        .filter(|record| !record_is_live(record))
        .map(|record| DevRunnerInfo {
            command: record.command.clone(),
            url: record.url.clone(),
            running: false,
            error: Some(read_log_tail(&record.log_path)),
        });
    let found = take_live_record(&mut records, &chat_id, &cwd, record_is_live);
    let info = found
        .as_ref()
        .map(|record| DevRunnerInfo {
            command: record.command.clone(),
            url: record.url.clone(),
            running: true,
            error: None,
        })
        .or(stopped);
    if let Some(record) = found {
        records.push(record);
    }
    write_records(&records)?;
    Ok(info)
}

fn stop_dev_server_blocking(chat_id: String) -> Result<(), String> {
    let record = remove_record(&chat_id)?;
    if let Some(mut child) = runners()
        .lock()
        .map_err(|_| "dev runner lock poisoned")?
        .remove(&chat_id)
    {
        kill_process_group(&mut child);
    } else if let Some(record) = &record {
        if record_is_live(record) {
            let _ = Command::new("kill")
                .args(["-TERM", &format!("-{}", record.process_group)])
                .status();
        }
    }
    if let Some(record) = record {
        kill_port_listener(&record.url);
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_dev_server(chat_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_dev_server_blocking(chat_id))
        .await
        .map_err(|e| format!("Dev-server stop worker failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_runner_ids_include_other_worktrees_of_same_project() {
        let records = [
            DevRunnerRecord {
                chat_id: "same-project".into(),
                cwd: "/worktrees/a".into(),
                command: "dev".into(),
                url: "http://localhost:1".into(),
                process_group: 1,
                process_command: "dev".into(),
                log_path: String::new(),
            },
            DevRunnerRecord {
                chat_id: "other-project".into(),
                cwd: "/worktrees/b".into(),
                command: "dev".into(),
                url: "http://localhost:2".into(),
                process_group: 2,
                process_command: "dev".into(),
                log_path: String::new(),
            },
        ];
        let project = Path::new("/projects/a");
        let ids = project_runner_chat_ids(&records, project, |cwd| match cwd.to_str() {
            Some("/worktrees/a") => Some(project.into()),
            Some("/worktrees/b") => Some("/projects/b".into()),
            _ => None,
        });
        assert_eq!(ids, ["same-project"]);
    }

    #[test]
    fn log_tail_is_bounded_to_recent_output() {
        let path = std::env::temp_dir().join("crc-dev-log-tail-test.log");
        std::fs::write(&path, format!("{}LATEST ERROR", "x".repeat(9_000))).unwrap();
        let tail = read_log_tail(&path.to_string_lossy());
        assert!(tail.len() <= 8_000);
        assert!(tail.ends_with("LATEST ERROR"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn stop_force_kills_a_process_group_that_ignores_term() {
        let mut child = Command::new("sh")
            .args(["-c", "trap '' TERM; sleep 30 & wait"])
            .process_group(0)
            .spawn()
            .unwrap();
        let started = std::time::Instant::now();
        kill_process_group(&mut child);
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn stop_kills_listener_that_escaped_the_launcher_group() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut server = Command::new("python3")
            .args([
                "-m",
                "http.server",
                &port.to_string(),
                "--bind",
                "127.0.0.1",
            ])
            .process_group(0)
            .spawn()
            .unwrap();
        for _ in 0..20 {
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        kill_port_listener(&format!("http://localhost:{port}"));
        let stopped = TcpStream::connect(("127.0.0.1", port)).is_err();
        let _ = server.kill();
        let _ = server.wait();
        assert!(stopped);
    }

    #[test]
    fn shell_path_includes_rustup_binaries() {
        let home = std::env::var("HOME").unwrap();
        assert!(shell_path()
            .split(':')
            .any(|path| path == format!("{home}/.cargo/bin")));
    }

    #[test]
    fn in_memory_child_is_live_without_matching_shell_command() {
        let mut child = Command::new("sleep").arg("5").spawn().unwrap();
        let chat_id = "in-memory-live-check";
        runners().lock().unwrap().insert(chat_id.into(), child);
        let record = DevRunnerRecord {
            chat_id: chat_id.into(),
            cwd: "/tmp/a".into(),
            command: "pnpm dev".into(),
            url: "http://localhost:1".into(),
            process_group: 1,
            process_command: "command that ps will not contain".into(),
            log_path: String::new(),
        };
        assert!(record_is_live(&record));
        child = runners().lock().unwrap().remove(chat_id).unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn persisted_pid_without_verifiable_command_is_never_live() {
        let record = DevRunnerRecord {
            chat_id: "chat-a".into(),
            cwd: "/tmp/a".into(),
            command: "pnpm dev".into(),
            url: "http://localhost:1".into(),
            process_group: std::process::id(),
            process_command: String::new(),
            log_path: String::new(),
        };
        assert!(!record_is_live(&record));
    }

    #[test]
    fn polling_checks_matching_runner_once() {
        let mut records = vec![DevRunnerRecord {
            chat_id: "chat-a".into(),
            cwd: "/tmp/a".into(),
            command: "pnpm dev".into(),
            url: "http://localhost:1".into(),
            process_group: 1,
            process_command: "pnpm dev".into(),
            log_path: String::new(),
        }];
        let mut checks = 0;
        let found = take_live_record(&mut records, "chat-a", "/tmp/a", |_| {
            checks += 1;
            true
        });
        assert!(found.is_some());
        assert_eq!(checks, 1);
    }

    #[test]
    fn runner_registry_is_keyed_per_chat() {
        let records = [
            DevRunnerRecord {
                chat_id: "chat-a".into(),
                cwd: "/tmp/a".into(),
                command: "a".into(),
                url: "a".into(),
                process_group: 1,
                process_command: "a".into(),
                log_path: String::new(),
            },
            DevRunnerRecord {
                chat_id: "chat-b".into(),
                cwd: "/tmp/b".into(),
                command: "b".into(),
                url: "b".into(),
                process_group: 2,
                process_command: "b".into(),
                log_path: String::new(),
            },
        ];
        let remaining: Vec<_> = records
            .iter()
            .filter(|record| record.chat_id != "chat-a")
            .collect();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].chat_id, "chat-b");
    }
}
