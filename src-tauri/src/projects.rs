use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Serialize)]
pub struct ProjectInfo {
    pub name: String,
    pub path: String,
    pub kinds: Vec<String>,
    pub mtime_ms: u64,
    pub is_git: bool,
}

#[derive(Deserialize, Serialize)]
struct StoredConfig {
    pi_path: String,
    project_root: String,
    default_provider: String,
    default_model: String,
    default_thinking: String,
    #[serde(default)]
    projects: Vec<String>,
}

fn detect_kinds(dir: &Path) -> (Vec<String>, bool) {
    let is_git = dir.join(".git").exists();
    let mut kinds = Vec::new();
    if is_git { kinds.push("git".to_string()); }
    if dir.join("package.json").exists() { kinds.push("node".to_string()); }
    if dir.join("Cargo.toml").exists() { kinds.push("rust".to_string()); }
    if dir.join("pom.xml").exists() { kinds.push("java".to_string()); }
    if dir.join("go.mod").exists() { kinds.push("go".to_string()); }
    (kinds, is_git)
}

fn dir_mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64)
        .unwrap_or(0)
}

fn config_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("crc.config.json")
}

fn read_config() -> Result<StoredConfig, String> {
    let raw = std::fs::read_to_string(config_path()).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn project_info(path: &Path) -> Result<ProjectInfo, String> {
    if !path.is_dir() { return Err(format!("project directory not found: {}", path.display())); }
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    let name = path.file_name().and_then(|n| n.to_str()).ok_or("invalid project name")?.to_string();
    let (kinds, is_git) = detect_kinds(&path);
    Ok(ProjectInfo { name, path: path.to_string_lossy().to_string(), kinds, mtime_ms: dir_mtime_ms(&path), is_git })
}

#[tauri::command]
pub fn list_projects() -> Result<Vec<ProjectInfo>, String> {
    read_config()?.projects.iter().map(|path| project_info(Path::new(path))).collect()
}

#[tauri::command]
pub fn add_project(path: String) -> Result<ProjectInfo, String> {
    let project = project_info(Path::new(&path))?;
    let mut config = read_config()?;
    if !config.projects.iter().any(|saved| Path::new(saved) == Path::new(&project.path)) {
        config.projects.push(project.path.clone());
        let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        std::fs::write(config_path(), format!("{json}\n")).map_err(|e| e.to_string())?;
    }
    Ok(project)
}

pub fn ensure_child_of_root(root: &Path, child: &Path) -> Result<(), String> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let child = child.canonicalize().unwrap_or_else(|_| child.to_path_buf());
    if child.starts_with(&root) {
        Ok(())
    } else {
        Err(format!("path traversal blocked: {} not inside {}", child.display(), root.display()))
    }
}

pub fn ensure_registered_project(child: &Path) -> Result<(), String> {
    let child = child.canonicalize().unwrap_or_else(|_| child.to_path_buf());
    if read_config()?.projects.iter().any(|saved| child.starts_with(Path::new(saved).canonicalize().unwrap_or_else(|_| PathBuf::from(saved)))) {
        Ok(())
    } else {
        Err(format!("unregistered project path: {}", child.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mtime_no_panic() { let _ = dir_mtime_ms(Path::new("/tmp")); }
}
