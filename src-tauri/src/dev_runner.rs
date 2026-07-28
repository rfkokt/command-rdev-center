use serde::Serialize;
use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::io::Read;
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

#[derive(Serialize)]
pub struct DevRunnerInfo {
    pub command: String,
    pub url: String,
    pub running: bool,
}

fn ensure_node_modules(cwd: &Path, project: &Path) -> Result<(), String> {
    let target = cwd.join("node_modules");
    let source = project.join("node_modules");
    if target.exists() {
        return Ok(());
    }
    if !source.exists() {
        return Err(format!("dependencies missing: run install once in {}", project.display()));
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(source, target).map_err(|e| e.to_string())?;
    Ok(())
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
pub fn start_dev_server(chat_id: String, cwd: String, command: String) -> Result<DevRunnerInfo, String> {
    let project = crate::projects::ensure_path_allowed(Path::new(&cwd))?;
    if command != detect_command(Path::new(&cwd))? {
        return Err("dev command does not match detected project command".into());
    }
    ensure_node_modules(Path::new(&cwd), &project)?;
    stop_dev_server(chat_id.clone())?;
    let port = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?.local_addr().map_err(|e| e.to_string())?.port();
    let dev_script = std::fs::read_to_string(Path::new(&cwd).join("package.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|package| package.pointer("/scripts/dev").and_then(|value| value.as_str()).map(str::to_string));
    let next = dev_script.as_deref().is_some_and(|script| script.split_whitespace().next() == Some("next"));
    let webpack = next && !dev_script.as_deref().is_some_and(|script| script.split_whitespace().any(|arg| arg == "--webpack"));
    let separator = if command.starts_with("npm ") { " --" } else { "" };
    let run_command = if command == "cargo run" { command.clone() } else if webpack { format!("{command}{separator} --webpack --port {port}") } else { format!("{command}{separator} --port {port}") };
    let path = std::env::var("PATH").unwrap_or_default();
    let project_bins = project.join("node_modules/.bin");
    let mut child = Command::new("sh")
        .args(["-lc", &run_command])
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
            if let Some(mut stderr) = child.stderr.take() { let _ = stderr.read_to_string(&mut output); }
            if output.trim().is_empty() { if let Some(mut stdout) = child.stdout.take() { let _ = stdout.read_to_string(&mut output); } }
            return Err(format!("dev server exited before startup ({status}): {}", output.trim()));
        }
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            ready_checks += 1;
            if ready_checks == 10 {
                runners().lock().map_err(|_| "dev runner lock poisoned")?.insert(chat_id, child);
                return Ok(DevRunnerInfo { command, url: format!("http://localhost:{port}"), running: true });
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
pub fn stop_dev_server(chat_id: String) -> Result<(), String> {
    if let Some(mut child) = runners().lock().map_err(|_| "dev runner lock poisoned")?.remove(&chat_id) {
        kill_process_group(&mut child);
    }
    Ok(())
}
