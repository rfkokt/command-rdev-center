use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;
use tauri::Manager;

static CONFIG_PATH: OnceLock<PathBuf> = OnceLock::new();

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
    #[serde(default)]
    project_root: String,
    default_provider: String,
    default_model: String,
    default_thinking: String,
    #[serde(default)]
    projects: Vec<String>,
}

fn sanitize_repo_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn canonicalize_or_original(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

fn detect_kinds(dir: &Path) -> (Vec<String>, bool) {
    let is_git = dir.join(".git").exists();
    let mut kinds = Vec::new();
    if is_git {
        kinds.push("git".into());
    }
    if dir.join("package.json").exists() {
        kinds.push("node".into());
    }
    if dir.join("Cargo.toml").exists() {
        kinds.push("rust".into());
    }
    if dir.join("pom.xml").exists() {
        kinds.push("java".into());
    }
    if dir.join("go.mod").exists() {
        kinds.push("go".into());
    }
    (kinds, is_git)
}

fn dir_mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64)
        .unwrap_or(0)
}

pub fn init_config(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("crc.config.json");
    if !path.exists() {
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("crc.config.json"),
            &path,
        )
        .map_err(|e| e.to_string())?;
    }
    CONFIG_PATH
        .set(path)
        .map_err(|_| "config already initialized".to_string())
}

pub fn config_path() -> PathBuf {
    CONFIG_PATH
        .get()
        .cloned()
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("crc.config.json"))
}

fn read_config() -> Result<StoredConfig, String> {
    let raw = std::fs::read_to_string(config_path()).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn all_registered_paths_uncached() -> Result<Vec<PathBuf>, String> {
    Ok(read_config()?
        .projects
        .iter()
        .map(|s| PathBuf::from(s))
        .collect())
}

pub fn project_root() -> Result<PathBuf, String> {
    let root = read_config()?.project_root;
    if root.trim().is_empty() {
        Err("project root is not configured".into())
    } else {
        Ok(PathBuf::from(root))
    }
}

pub fn global_worktree_root() -> Result<PathBuf, String> {
    let cfg = read_config()?;
    let base = if cfg.project_root.trim().is_empty() {
        all_registered_paths_uncached()?
            .first()
            .and_then(|p| p.parent().map(|par| par.to_path_buf()))
            .unwrap_or_else(std::env::temp_dir)
    } else {
        PathBuf::from(cfg.project_root)
    };
    Ok(base.join(".crc-worktrees"))
}

pub fn find_owning_project(child: &Path) -> Option<PathBuf> {
    let child_canon = canonicalize_or_original(child);
    let Ok(cfg) = read_config() else {
        return None;
    };
    for saved in cfg.projects {
        let saved_path = PathBuf::from(&saved);
        let saved_canon = canonicalize_or_original(&saved_path);
        if child_canon == saved_canon || child_canon.starts_with(&saved_canon) {
            return Some(saved_canon);
        }
    }
    None
}

fn find_owning_project_for_worktree(cwd: &Path) -> Option<PathBuf> {
    let wt_root = global_worktree_root().ok()?;
    let wt_root_canon = canonicalize_or_original(&wt_root);
    let cwd_canon = canonicalize_or_original(cwd);
    let is_under_wt = cwd_canon.starts_with(&wt_root_canon)
        || cwd.starts_with(&wt_root)
        || cwd_canon.starts_with(&wt_root);
    if !is_under_wt {
        return None;
    }
    let rel = cwd_canon
        .strip_prefix(&wt_root_canon)
        .or_else(|_| cwd.strip_prefix(&wt_root))
        .ok()?;
    let repo_dir = rel.iter().next()?.to_string_lossy().to_string();
    let Ok(cfg) = read_config() else {
        return None;
    };
    for saved in &cfg.projects {
        let p = PathBuf::from(saved);
        let fname = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if repo_dir == sanitize_repo_name(fname) || repo_dir == fname {
            return Some(canonicalize_or_original(&p));
        }
    }
    for saved in cfg.projects {
        let p = PathBuf::from(&saved);
        let fname = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if sanitize_repo_name(fname).to_lowercase() == repo_dir.to_lowercase() {
            return Some(canonicalize_or_original(&p));
        }
    }
    None
}

pub fn ensure_path_allowed(child: &Path) -> Result<PathBuf, String> {
    if let Some(owner) = find_owning_project(child) {
        return Ok(owner);
    }
    if let Some(owner) = find_owning_project_for_worktree(child) {
        return Ok(owner);
    }
    Err(format!(
        "unregistered project path: {} (not inside any imported project and not a valid worktree)",
        child.display()
    ))
}

fn project_info(path: &Path) -> Result<ProjectInfo, String> {
    if !path.is_dir() {
        return Err(format!("project directory not found: {}", path.display()));
    }
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("invalid project name")?
        .to_string();
    let (kinds, is_git) = detect_kinds(&path);
    Ok(ProjectInfo {
        name,
        path: path.to_string_lossy().to_string(),
        kinds,
        mtime_ms: dir_mtime_ms(&path),
        is_git,
    })
}

#[tauri::command]
pub fn list_projects() -> Result<Vec<ProjectInfo>, String> {
    read_config()?
        .projects
        .iter()
        .map(|path| project_info(Path::new(path)))
        .collect()
}

#[tauri::command]
pub fn add_project(path: String) -> Result<ProjectInfo, String> {
    let project = project_info(Path::new(&path))?;
    let mut config = read_config()?;
    if !config
        .projects
        .iter()
        .any(|saved| Path::new(saved) == Path::new(&project.path))
    {
        config.projects.push(project.path.clone());
        let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        std::fs::write(config_path(), format!("{json}\n")).map_err(|e| e.to_string())?;
    }
    Ok(project)
}

// legacy compat shim — prefer ensure_path_allowed
pub fn ensure_child_of_root(root: &Path, child: &Path) -> Result<(), String> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let child = child.canonicalize().unwrap_or_else(|_| child.to_path_buf());
    if child.starts_with(&root) {
        Ok(())
    } else {
        Err(format!(
            "path traversal blocked: {} not inside {}",
            child.display(),
            root.display()
        ))
    }
}

pub fn ensure_registered_project(child: &Path) -> Result<(), String> {
    ensure_path_allowed(child).map(|_| ())
}

pub fn ensure_registered_project_returning(child: &Path) -> Result<PathBuf, String> {
    ensure_path_allowed(child)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mtime_no_panic() {
        let _ = dir_mtime_ms(Path::new("/tmp"));
    }
}
