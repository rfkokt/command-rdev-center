use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;
use tauri::Manager;

static CONFIG_PATH: OnceLock<PathBuf> = OnceLock::new();
const DEFAULT_CONFIG: &str = include_str!("../crc.config.json");
const KANBAN_EXTENSION: &str = include_str!("../extensions/kanban-task.ts");
const GRAPHIFY_EXTENSION: &str = include_str!("../extensions/graphify-context.ts");

#[derive(Debug, Clone, Serialize)]
pub struct ProjectInfo {
    pub name: String,
    pub path: String,
    pub kinds: Vec<String>,
    pub mtime_ms: u64,
    pub is_git: bool,
    pub base_branch: Option<String>,
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
    #[serde(default)]
    base_branches: HashMap<String, String>,
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
        std::fs::write(&path, DEFAULT_CONFIG).map_err(|e| e.to_string())?;
    }
    let extensions = dir.join("extensions");
    std::fs::create_dir_all(&extensions).map_err(|e| e.to_string())?;
    std::fs::write(extensions.join("kanban-task.ts"), KANBAN_EXTENSION)
        .map_err(|e| e.to_string())?;
    std::fs::write(extensions.join("graphify-context.ts"), GRAPHIFY_EXTENSION)
        .map_err(|e| e.to_string())?;
    CONFIG_PATH
        .set(path)
        .map_err(|_| "config already initialized".to_string())?;
    migrate_base_branches()
}

pub fn config_path() -> PathBuf {
    CONFIG_PATH
        .get()
        .cloned()
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("crc.config.json"))
}

pub fn extensions_path() -> PathBuf {
    config_path().parent().unwrap_or_else(|| Path::new(".")).join("extensions")
}

fn read_config() -> Result<StoredConfig, String> {
    let raw = std::fs::read_to_string(config_path()).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn current_branch(path: &str) -> Option<String> {
    let output = Command::new("git")
        .args(["-C", path, "symbolic-ref", "--quiet", "--short", "HEAD"])
        .output()
        .ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string()).filter(|branch| !branch.is_empty())
}

fn migrate_base_branches() -> Result<(), String> {
    let mut config = read_config()?;
    let missing = config.projects.iter().filter_map(|path| {
        (!config.base_branches.contains_key(path)).then(|| current_branch(path).map(|branch| (path.clone(), branch))).flatten()
    }).collect::<Vec<_>>();
    if missing.is_empty() {
        return Ok(());
    }
    config.base_branches.extend(missing);
    let json = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    std::fs::write(config_path(), format!("{json}\n")).map_err(|error| error.to_string())
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

fn project_info(path: &Path, base_branch: Option<String>) -> Result<ProjectInfo, String> {
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
        base_branch,
    })
}

#[tauri::command]
pub fn list_projects() -> Result<Vec<ProjectInfo>, String> {
    let config = read_config()?;
    config
        .projects
        .iter()
        .map(|path| project_info(Path::new(path), config.base_branches.get(path).cloned()))
        .collect()
}

#[tauri::command]
pub fn list_project_branches(path: String) -> Result<Vec<String>, String> {
    let project = project_info(Path::new(&path), None)?;
    if !project.is_git {
        return Ok(Vec::new());
    }
    let output = Command::new("git")
        .args(["-C", &project.path, "for-each-ref", "--format=%(refname:short)", "refs/heads"])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let mut branches = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|branch| !branch.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    branches.sort();
    Ok(branches)
}

pub fn project_base_branch(path: &Path) -> Result<String, String> {
    let canonical = canonicalize_or_original(path).to_string_lossy().to_string();
    read_config()?
        .base_branches
        .get(&canonical)
        .cloned()
        .ok_or_else(|| format!("base branch not configured for {}", canonical))
}

#[tauri::command]
pub fn add_project(path: String, base_branch: Option<String>) -> Result<ProjectInfo, String> {
    let mut project = project_info(Path::new(&path), base_branch.clone())?;
    if project.is_git {
        let branch = base_branch.filter(|branch| !branch.trim().is_empty()).ok_or("base branch required")?;
        let exists = Command::new("git")
            .args(["-C", &project.path, "rev-parse", "--verify", &format!("refs/heads/{branch}")])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);
        if !exists {
            return Err(format!("local branch not found: {branch}"));
        }
        project.base_branch = Some(branch);
    }
    let mut config = read_config()?;
    if !config
        .projects
        .iter()
        .any(|saved| Path::new(saved) == Path::new(&project.path))
    {
        config.projects.push(project.path.clone());
    }
    if let Some(branch) = &project.base_branch {
        config.base_branches.insert(project.path.clone(), branch.clone());
    }
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(config_path(), format!("{json}\n")).map_err(|e| e.to_string())?;
    Ok(project)
}

#[tauri::command]
pub fn update_project_base_branch(path: String, base_branch: String) -> Result<ProjectInfo, String> {
    let mut project = project_info(Path::new(&path), Some(base_branch.clone()))?;
    if !project.is_git {
        return Err("base branch is only available for Git projects".into());
    }
    let exists = Command::new("git")
        .args(["-C", &project.path, "rev-parse", "--verify", &format!("refs/heads/{base_branch}")])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    if !exists {
        return Err(format!("local branch not found: {base_branch}"));
    }
    let mut config = read_config()?;
    if !config.projects.iter().any(|saved| canonicalize_or_original(Path::new(saved)) == PathBuf::from(&project.path)) {
        return Err(format!("project is not registered: {}", project.path));
    }
    config.base_branches.insert(project.path.clone(), base_branch.clone());
    let json = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    std::fs::write(config_path(), format!("{json}\n")).map_err(|error| error.to_string())?;
    project.base_branch = Some(base_branch);
    Ok(project)
}

#[tauri::command]
pub fn remove_project(path: String) -> Result<(), String> {
    let canonical = canonicalize_or_original(Path::new(&path)).to_string_lossy().to_string();
    let mut config = read_config()?;
    config.projects.retain(|saved| canonicalize_or_original(Path::new(saved)).to_string_lossy() != canonical);
    config.base_branches.remove(&canonical);
    config.base_branches.remove(&path);
    let json = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    std::fs::write(config_path(), format!("{json}\n")).map_err(|error| error.to_string())
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

    #[test]
    fn embedded_default_config_is_valid() {
        serde_json::from_str::<StoredConfig>(DEFAULT_CONFIG).unwrap();
        assert!(KANBAN_EXTENSION.contains("track_kanban_task"));
        assert!(GRAPHIFY_EXTENSION.contains("before_agent_start"));
    }
}
