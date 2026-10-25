use serde::Deserialize;
use std::path::{Component, Path};

#[derive(Debug, Deserialize, serde::Serialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Setup {
    #[serde(default)]
    copy: Vec<String>,
    #[serde(default)]
    commands: Vec<String>,
}
fn safe_relative(path: &str) -> bool {
    !path.is_empty() && Path::new(path).components().all(|part| matches!(part, Component::Normal(_)))
}
fn config(root: &Path) -> Result<Setup, String> {
    let path = root.join("kern.yaml");
    if !path.exists() { return Ok(Setup::default()); }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > 65_536 { return Err("kern.yaml exceeds 64 KB".into()); }
    let setup: Setup = serde_yaml::from_slice(&bytes).map_err(|e| format!("kern.yaml: {e}"))?;
    if setup.copy.len() > 100 || setup.commands.len() > 20 || setup.copy.iter().any(|path| !safe_relative(path)) || setup.commands.iter().any(|command| command.trim().is_empty() || command.len() > 8000) {
        return Err("Invalid kern.yaml setup: relative file paths only, max 100 copies / 20 commands".into());
    }
    Ok(setup)
}
fn roots(project: &str, worktree: &str) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let project = Path::new(project).canonicalize().map_err(|e| e.to_string())?;
    let worktree = Path::new(worktree).canonicalize().map_err(|e| e.to_string())?;
    crate::projects::ensure_path_allowed(&project)?;
    crate::projects::ensure_path_allowed(&worktree)?;
    if project == worktree { return Err("Setup requires a separate worktree".into()); }
    Ok((project, worktree))
}
#[tauri::command]
pub async fn inspect_worktree_setup(project: String, worktree: String) -> Result<Setup, String> {
    tauri::async_runtime::spawn_blocking(move || { let (root, _) = roots(&project, &worktree)?; config(&root) }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn run_worktree_setup(project: String, worktree: String, approved_setup: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, target) = roots(&project, &worktree)?;
        let setup = config(&root)?;
        if serde_json::to_string(&setup).map_err(|e| e.to_string())? != approved_setup { return Err("kern.yaml changed; review setup again".into()); }
        let common = |path: &Path| -> Result<std::path::PathBuf, String> {
            let result = std::process::Command::new("git").arg("-C").arg(path).args(["rev-parse", "--path-format=absolute", "--git-common-dir"]).output().map_err(|e| e.to_string())?;
            if !result.status.success() { return Err("Setup requires related Git worktrees".into()); }
            Path::new(String::from_utf8_lossy(&result.stdout).trim()).canonicalize().map_err(|e| e.to_string())
        };
        if common(&root)? != common(&target)? { return Err("Worktree does not belong to this project".into()); }
        let mut output = String::new();
        for file in setup.copy {
            let source = root.join(&file).canonicalize().map_err(|e| e.to_string())?;
            if !source.starts_with(&root) || !source.is_file() { return Err("Setup copy source must be a file inside the project".into()); }
            let destination = target.join(&file);
            // Do not follow a destination symlink or overwrite any existing file.
            if destination.symlink_metadata().is_ok() { output.push_str(&format!("Skipped existing {file}\n")); continue; }
            let parent = destination.parent().ok_or("Missing parent")?;
            let mut ancestor = parent;
            while !ancestor.exists() { ancestor = ancestor.parent().ok_or("Invalid setup destination")?; }
            if !ancestor.canonicalize().map_err(|e| e.to_string())?.starts_with(&target) { return Err("Setup destination escapes worktree".into()); }
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            if !parent.canonicalize().map_err(|e| e.to_string())?.starts_with(&target) { return Err("Setup destination escapes worktree".into()); }
            use std::io::Write;
            let bytes = std::fs::read(source).map_err(|e| e.to_string())?;
            let mut saved = std::fs::OpenOptions::new().write(true).create_new(true).open(destination).map_err(|e| e.to_string())?;
            saved.write_all(&bytes).map_err(|e| e.to_string())?;
            output.push_str(&format!("Copied {file}\n"));
        }
        // Commands require an explicit UI run action; project files never authorize execution.
        for command in setup.commands {
            output.push_str(&format!("$ {command}\n"));
            use std::io::{Read, Seek};
            let log_path = std::env::temp_dir().join(format!("kern-setup-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos()));
            let mut options = std::fs::OpenOptions::new(); options.read(true).write(true).create_new(true);
            #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
            let mut log = options.open(&log_path).map_err(|e| e.to_string())?;
            // Unlink immediately: the private open handle survives until the worker ends.
            std::fs::remove_file(&log_path).map_err(|e| e.to_string())?;
            let mut process = std::process::Command::new("sh");
            process.args(["-lc", &command]).current_dir(&target)
                .stdout(log.try_clone().map_err(|e| e.to_string())?)
                .stderr(log.try_clone().map_err(|e| e.to_string())?);
            #[cfg(unix)] {
                use std::os::unix::process::CommandExt;
                process.process_group(0);
            }
            let mut child = process.spawn().map_err(|e| e.to_string())?;
            let started = std::time::Instant::now();
            let status = loop {
                if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { break status; }
                if started.elapsed().as_secs() > 120 || log.metadata().map_err(|e| e.to_string())?.len() > 1_000_000 {
                    #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
                    let _ = child.kill(); let _ = child.wait();
                    output.push_str("\nSetup stopped: exceeded 120 seconds or 1 MB output. Chat remains available.");
                    return Ok(output);
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            };
            log.rewind().map_err(|e| e.to_string())?;
            let mut bytes = Vec::new(); log.take(100_000).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            output.push_str(&String::from_utf8_lossy(&bytes));
            if output.len() > 100_000 { let mut end = 100_000; while !output.is_char_boundary(end) { end -= 1; } output.truncate(end); }
            if !status.success() { output.push_str("\nSetup failed; chat remains available."); break; }
        }
        Ok(output)
    }).await.map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_escaping_copy_paths() {
        assert!(safe_relative(".env")); assert!(safe_relative("config/local.env"));
        assert!(!safe_relative("../.env")); assert!(!safe_relative("/tmp/env")); assert!(!safe_relative(""));
    }
}
