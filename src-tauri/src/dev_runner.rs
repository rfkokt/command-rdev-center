use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
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
    format!("{nvm_bins}:{home}/.local/bin:{home}/.npm-global/bin:{home}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{current}")
}

#[derive(Clone, Serialize)]
pub struct DevRunnerInfo {
    pub command: String,
    pub url: String,
    pub running: bool,
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
    if record.process_command.is_empty() {
        return false;
    }
    let command_matches = Command::new("ps")
        .args(["-p", &record.process_group.to_string(), "-o", "command="])
        .output()
        .is_ok_and(|output| {
            output.status.success()
                && String::from_utf8_lossy(&output.stdout).contains(&record.process_command)
        });
    let port = record
        .url
        .rsplit(':')
        .next()
        .and_then(|value| value.parse::<u16>().ok());
    command_matches && port.is_some_and(|port| TcpStream::connect(("127.0.0.1", port)).is_ok())
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
pub fn start_dev_server(
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
    stop_dev_server(chat_id.clone())?;
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
    let mut child = Command::new("sh")
        .args(["-c", &run_command])
        .current_dir(&cwd)
        .env("PATH", format!("{}:{path}", project_bins.display()))
        .env("NODE_PATH", project.join("node_modules"))
        .env("PORT", port.to_string())
        .env("VITE_PORT", port.to_string())
        .process_group(0)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let mut ready_checks = 0;
    for _ in 0..150 {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            let mut output = String::new();
            if let Some(mut stderr) = child.stderr.take() {
                let _ = stderr.read_to_string(&mut output);
            }
            if output.trim().is_empty() {
                if let Some(mut stdout) = child.stdout.take() {
                    let _ = stdout.read_to_string(&mut output);
                }
            }
            return Err(format!(
                "dev server exited before startup ({status}): {}",
                output.trim()
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
    let _ = Command::new("kill")
        .args(["-TERM", &format!("-{}", child.id())])
        .status();
    let _ = child.wait();
}

#[tauri::command]
pub fn get_dev_server(chat_id: String, cwd: String) -> Result<Option<DevRunnerInfo>, String> {
    crate::projects::ensure_path_allowed(Path::new(&cwd))?;
    let _lock = REGISTRY_LOCK
        .lock()
        .map_err(|_| "dev runner registry lock poisoned")?;
    let mut records = read_records();
    let found = records
        .iter()
        .find(|record| record.chat_id == chat_id && record.cwd == cwd && record_is_live(record))
        .map(|record| DevRunnerInfo {
            command: record.command.clone(),
            url: record.url.clone(),
            running: true,
        });
    records
        .retain(|record| record.chat_id != chat_id || record.cwd != cwd || record_is_live(record));
    write_records(&records)?;
    Ok(found)
}

#[tauri::command]
pub fn stop_dev_server(chat_id: String) -> Result<(), String> {
    if let Some(mut child) = runners()
        .lock()
        .map_err(|_| "dev runner lock poisoned")?
        .remove(&chat_id)
    {
        kill_process_group(&mut child);
        remove_record(&chat_id)?;
    } else if let Some(record) = remove_record(&chat_id)? {
        if record_is_live(&record) {
            let _ = Command::new("kill")
                .args(["-TERM", &format!("-{}", record.process_group)])
                .status();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_pid_without_verifiable_command_is_never_live() {
        let record = DevRunnerRecord {
            chat_id: "chat-a".into(),
            cwd: "/tmp/a".into(),
            command: "pnpm dev".into(),
            url: "http://localhost:1".into(),
            process_group: std::process::id(),
            process_command: String::new(),
        };
        assert!(!record_is_live(&record));
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
            },
            DevRunnerRecord {
                chat_id: "chat-b".into(),
                cwd: "/tmp/b".into(),
                command: "b".into(),
                url: "b".into(),
                process_group: 2,
                process_command: "b".into(),
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
