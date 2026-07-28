use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::Path;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

static RUNNERS: OnceLock<Mutex<HashMap<String, Child>>> = OnceLock::new();

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

#[derive(Clone, Deserialize, Serialize)]
pub struct DevRunnerInfo {
    pub command: String,
    pub url: String,
    pub running: bool,
    pid: u32,
}

fn state_path() -> std::path::PathBuf {
    crate::projects::config_path().with_file_name("dev-runners.json")
}

fn read_states() -> HashMap<String, DevRunnerInfo> {
    std::fs::read_to_string(state_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_states(states: &HashMap<String, DevRunnerInfo>) -> Result<(), String> {
    std::fs::write(state_path(), serde_json::to_vec(states).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn runner_reachable(info: &DevRunnerInfo) -> bool {
    let Some(port) = info.url.rsplit_once(':').and_then(|(_, port)| port.parse::<u16>().ok()) else { return false };
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_secs(1)) else { return false };
    let timeout = Some(Duration::from_secs(2));
    if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() { return false; }
    if stream.write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n").is_err() { return false; }
    let _ = stream.shutdown(Shutdown::Write);
    let mut response = [0; 12];
    stream.read(&mut response).is_ok_and(|read| read >= 12 && response.starts_with(b"HTTP/"))
}

#[tauri::command]
pub fn get_dev_server(project_path: String) -> Result<Option<DevRunnerInfo>, String> {
    let project = crate::projects::ensure_path_allowed(Path::new(&project_path))?;
    let key = project.to_string_lossy().into_owned();
    let mut states = read_states();
    let info = states.get(&key).filter(|info| runner_reachable(info)).cloned();
    if info.is_none() && states.remove(&key).is_some() {
        write_states(&states)?;
    }
    Ok(info)
}

fn ensure_node_modules(cwd: &Path, project: &Path) -> Result<(), String> {
    let target = cwd.join("node_modules");
    if target.exists() {
        return Ok(());
    }
    Err(format!("dependencies missing in {}; reopen chat to copy them from {}", cwd.display(), project.display()))
}

fn detect_command(cwd: &Path) -> Result<String, String> {
    if cwd.join("package.json").exists() {
        let raw = std::fs::read_to_string(cwd.join("package.json")).map_err(|e| e.to_string())?;
        let package: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if package.pointer("/scripts/dev").and_then(|v| v.as_str()).is_none() {
            return Err("package.json has no dev script".into());
        }
        return Ok(if cwd.join("pnpm-lock.yaml").exists() { "pnpm dev" } else if cwd.join("yarn.lock").exists() { "yarn dev" } else if cwd.join("bun.lock").exists() || cwd.join("bun.lockb").exists() { "bun run dev" } else { "npm run dev" }.into());
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
pub fn start_dev_server(project_path: String, cwd: String, command: String) -> Result<DevRunnerInfo, String> {
    let project = crate::projects::ensure_path_allowed(Path::new(&project_path))?;
    crate::projects::ensure_path_allowed(Path::new(&cwd))?;
    let key = project.to_string_lossy().into_owned();
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
    stop_dev_server(project_path)?;
    let port = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?.local_addr().map_err(|e| e.to_string())?.port();
    let dev_script = std::fs::read_to_string(Path::new(&cwd).join("package.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|package| package.pointer("/scripts/dev").and_then(|value| value.as_str()).map(str::to_string));
    let next = dev_script.as_deref().is_some_and(|script| script.split_whitespace().next() == Some("next"));
    let webpack = next && !dev_script.as_deref().is_some_and(|script| script.split_whitespace().any(|arg| arg == "--webpack"));
    let separator = if command.starts_with("npm ") { " --" } else { "" };
    let run_command = if command == "cargo run" { command.clone() } else if webpack { format!("{command}{separator} --webpack --port {port}") } else { format!("{command}{separator} --port {port}") };
    let path = shell_path();
    let project_bins = project.join("node_modules/.bin");
    let log_path = crate::projects::config_path().with_file_name("dev-server.log");
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
            let output = std::fs::read_to_string(&log_path).unwrap_or_default();
            return Err(format!("dev server exited before startup ({status}): {}", output.trim()));
        }
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            ready_checks += 1;
            if ready_checks == 10 {
                let info = DevRunnerInfo { command, url: format!("http://localhost:{port}"), running: true, pid: child.id() };
                runners().lock().map_err(|_| "dev runner lock poisoned")?.insert(key.clone(), child);
                let mut states = read_states();
                states.insert(key, info.clone());
                write_states(&states)?;
                return Ok(info);
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
    let _ = Command::new("kill").args(["-TERM", &format!("-{}", child.id())]).status();
    let _ = child.wait();
}

#[tauri::command]
pub fn stop_dev_server(project_path: String) -> Result<(), String> {
    let project = crate::projects::ensure_path_allowed(Path::new(&project_path))?;
    let key = project.to_string_lossy().into_owned();
    let mut states = read_states();
    let saved = states.remove(&key);
    write_states(&states)?;
    if let Some(mut child) = runners().lock().map_err(|_| "dev runner lock poisoned")?.remove(&key) {
        kill_process_group(&mut child);
    } else if let Some(info) = saved.filter(runner_reachable) {
        let _ = Command::new("kill").args(["-TERM", &format!("-{}", info.pid)]).status();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_reachable_checks_saved_port() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 128];
            let _ = stream.read(&mut request);
            stream.write_all(b"HTTP/1.0 200 OK\r\n\r\n").unwrap();
        });
        let info = DevRunnerInfo { command: "npm run dev".into(), url: format!("http://localhost:{port}"), running: true, pid: 1 };
        assert!(runner_reachable(&info));
        server.join().unwrap();
        assert!(!runner_reachable(&info));
    }
}
