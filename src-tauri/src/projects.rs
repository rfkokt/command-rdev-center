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
const PIPELINE_EXTENSION: &str = include_str!("../extensions/pipeline-runner.ts");
const TERMINAL_EXTENSION: &str = include_str!("../extensions/terminal-context.ts");
const WORKSPACE_EXTENSION: &str = include_str!("../extensions/workspace-repositories.ts");

#[derive(Debug, Clone, Serialize)]
pub struct ProjectInfo {
    pub name: String,
    pub path: String,
    pub kinds: Vec<String>,
    pub mtime_ms: u64,
    pub is_git: bool,
    pub base_branch: Option<String>,
    pub pipeline_type: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub tracking_branch: Option<String>,
    #[serde(default)]
    pub remote_url: Option<String>,
    #[serde(default)]
    pub ahead: u32,
    #[serde(default)]
    pub behind: u32,
    #[serde(default)]
    pub dirty_files: Vec<String>,
    pub repositories: Vec<ProjectInfo>,
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
    #[serde(default)]
    pipeline_types: HashMap<String, String>,
    #[serde(default)]
    task_sources: HashMap<String, TaskSource>,
    #[serde(default)]
    backlog_dir: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TaskSource {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub sheet: String,
    #[serde(default)]
    pub sheets: Vec<String>,
    #[serde(default)]
    pub pics: Vec<String>,
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

pub(crate) fn canonicalize_or_original(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

fn git_output(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git").arg("-C").arg(dir).args(args).output().map_err(|e| e.to_string())?;
    if output.status.success() { Ok(String::from_utf8_lossy(&output.stdout).trim().to_string()) }
    else { Err(String::from_utf8_lossy(&output.stderr).trim().to_string()) }
}

/// A repository is valid only when its own `.git` entry resolves to this exact canonical root.
pub(crate) fn verified_repository_root(candidate: &Path) -> Result<PathBuf, String> {
    if !candidate.join(".git").exists() {
        return Err(format!("not a Git repository root: {}", candidate.display()));
    }
    let root = PathBuf::from(git_output(candidate, &["rev-parse", "--show-toplevel"])?);
    let root = canonicalize_or_original(&root);
    let candidate = canonicalize_or_original(candidate);
    if root != candidate {
        return Err(format!("Git root mismatch: {} resolves to {}", candidate.display(), root.display()));
    }
    Ok(root)
}

fn detect_kinds(dir: &Path) -> (Vec<String>, bool) {
    let is_git = verified_repository_root(dir).is_ok();
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

pub(crate) fn discover_git_repositories(root: &Path) -> Vec<PathBuf> {
    let mut repositories = ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .parents(true)
        .require_git(false)
        .filter_entry(|entry| entry.file_name() != ".git")
        .build()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_some_and(|kind| kind.is_dir()))
        .map(|entry| entry.into_path())
        .filter_map(|path| verified_repository_root(&path).ok())
        .collect::<Vec<_>>();
    if let Ok(root_repository) = verified_repository_root(root) {
        repositories.push(root_repository);
    }
    repositories.sort();
    repositories.dedup();
    repositories
}

fn repository_metadata(path: &Path) -> (Option<String>, Option<String>, Option<String>, u32, u32, Vec<String>) {
    let branch = git_output(path, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok().filter(|v| !v.is_empty());
    let tracking_branch = git_output(path, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).ok().filter(|v| !v.is_empty());
    let remote_url = tracking_branch.as_deref().and_then(|upstream| upstream.split_once('/').map(|(remote, _)| remote)).and_then(|remote| git_output(path, &["remote", "get-url", remote]).ok());
    let (ahead, behind) = tracking_branch.as_deref().and_then(|upstream| git_output(path, &["rev-list", "--left-right", "--count", &format!("HEAD...{upstream}")]).ok()).and_then(|value| { let mut n = value.split_whitespace(); Some((n.next()?.parse().ok()?, n.next()?.parse().ok()?)) }).unwrap_or((0, 0));
    let dirty_files = git_output(path, &["status", "--porcelain", "--untracked-files=all"]).unwrap_or_default().lines().filter_map(|line| line.get(3..).map(str::to_string)).collect();
    (branch, tracking_branch, remote_url, ahead, behind, dirty_files)
}

fn dir_mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64)
        .unwrap_or(0)
}

fn install_extensions(extensions: &Path) -> Result<(), String> {
    std::fs::create_dir_all(extensions).map_err(|e| e.to_string())?;
    for (name, content) in [
        ("kanban-task.ts", KANBAN_EXTENSION),
        ("graphify-context.ts", GRAPHIFY_EXTENSION),
        ("pipeline-runner.ts", PIPELINE_EXTENSION),
        ("terminal-context.ts", TERMINAL_EXTENSION),
        ("workspace-repositories.ts", WORKSPACE_EXTENSION),
    ] {
        std::fs::write(extensions.join(name), content).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn ensure_extensions() -> Result<PathBuf, String> {
    let extensions = extensions_path();
    install_extensions(&extensions)?;
    Ok(extensions)
}

pub fn init_config(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("crc.config.json");
    if !path.exists() {
        std::fs::write(&path, DEFAULT_CONFIG).map_err(|e| e.to_string())?;
    }
    install_extensions(&dir.join("extensions"))?;
    CONFIG_PATH
        .set(path)
        .map_err(|_| "config already initialized".to_string())
}

pub fn backlog_dir() -> Result<PathBuf, String> {
    let config = read_config()?;
    if let Some(path) = config.backlog_dir.filter(|path| !path.trim().is_empty()) {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err("backlog storage must be an absolute path".into());
        }
        return Ok(path);
    }
    Ok(config_path()
        .parent()
        .ok_or("app config has no parent")?
        .join("backlog"))
}

#[tauri::command]
pub fn get_backlog_dir() -> Result<String, String> {
    Ok(backlog_dir()?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn save_backlog_dir(path: String) -> Result<String, String> {
    let path = PathBuf::from(path.trim());
    if !path.is_absolute() || !path.is_dir() {
        return Err("backlog storage must be an existing absolute directory".into());
    }
    let mut config = read_config()?;
    config.backlog_dir = Some(path.to_string_lossy().into_owned());
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(config_path(), format!("{json}\n")).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

pub fn config_path() -> PathBuf {
    CONFIG_PATH
        .get()
        .cloned()
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("crc.config.json"))
}

pub fn extensions_path() -> PathBuf {
    config_path()
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("extensions")
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
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|branch| !branch.is_empty())
}

pub(crate) fn migrate_base_branches() -> Result<(), String> {
    let mut config = read_config()?;
    let missing = config
        .projects
        .iter()
        .filter_map(|path| {
            (!config.base_branches.contains_key(path))
                .then(|| current_branch(path).map(|branch| (path.clone(), branch)))
                .flatten()
        })
        .collect::<Vec<_>>();
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
        let saved_canon = canonicalize_or_original(Path::new(&saved));
        if child_canon == saved_canon || child_canon.starts_with(&saved_canon) {
            let repositories = discover_git_repositories(&saved_canon);
            if let Ok(root) = git_output(&child_canon, &["rev-parse", "--show-toplevel"]).map(PathBuf::from) {
                let root = canonicalize_or_original(&root);
                if repositories.contains(&root) { return Some(root); }
            }
            return None;
        }
    }
    None
}

fn find_owning_project_for_worktree(cwd: &Path) -> Option<PathBuf> {
    let wt_root = global_worktree_root().ok()?;
    if let Some(session) = canonicalize_or_original(cwd).ancestors().find(|path| path.join(".crc-workspace-root").is_file()) {
        let workspace = std::fs::read_to_string(session.join(".crc-workspace-root")).ok()?;
        let workspace = canonicalize_or_original(Path::new(workspace.trim()));
        if registered_workspace(&workspace).as_ref() == Some(&workspace) { return Some(workspace); }
    }
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
    for saved in cfg.projects {
        let root = canonicalize_or_original(Path::new(&saved));
        let mut repositories = discover_git_repositories(&root);
        if root.join(".git").exists() && !repositories.contains(&root) {
            repositories.push(root.clone());
        }
        if let Some(repository) = repositories.into_iter().find(|repository| {
            let name = repository
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            repo_dir == name || repo_dir == sanitize_repo_name(name)
        }) {
            return Some(repository);
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
    if let Some(workspace) = registered_workspace(child) {
        return Ok(workspace);
    }
    Err(format!(
        "unregistered project path: {} (not inside any imported project and not a valid worktree)",
        child.display()
    ))
}

/// The sole backend boundary for mutations: a registered, independently verified repository.
pub(crate) fn ensure_verified_repository(path: &Path) -> Result<PathBuf, String> {
    let root = verified_repository_root(path)?;
    let allowed = ensure_path_allowed(&root)?;
    if root != allowed { return Err("repository target is not the registered canonical repository root".into()); }
    Ok(root)
}

#[tauri::command]
pub fn open_vscode(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    let allowed = ensure_path_allowed(&path)?;
    let status = if cfg!(target_os = "macos") {
        Command::new("open").args(["-a", "Visual Studio Code"]).arg(&allowed).status()
    } else {
        Command::new("code").arg(&allowed).status()
    }
    .map_err(|error| format!("Could not open VS Code: {error}"))?;
    status.success().then_some(()).ok_or_else(|| "VS Code could not open the project".into())
}

pub fn ensure_pipeline_cwd(project: &Path, cwd: &Path) -> Result<PathBuf, String> {
    let project = project
        .canonicalize()
        .map_err(|e| format!("pipeline project: {e}"))?;
    let cwd = cwd
        .canonicalize()
        .map_err(|e| format!("pipeline cwd: {e}"))?;
    if cwd == project || cwd.starts_with(&project) {
        return Ok(cwd);
    }
    ensure_path_allowed(&cwd)?;
    let expected = git_output(&project, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
    let actual = git_output(&cwd, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
    if expected != actual { return Err("pipeline cwd belongs to another repository".into()); }
    Ok(cwd)
}

fn project_info(
    path: &Path,
    base_branch: Option<String>,
    pipeline_type: Option<String>,
) -> Result<ProjectInfo, String> {
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
    let (branch, tracking_branch, remote_url, ahead, behind, dirty_files) = if is_git { repository_metadata(&path) } else { (None, None, None, 0, 0, Vec::new()) };
    Ok(ProjectInfo {
        name,
        path: path.to_string_lossy().to_string(),
        kinds,
        mtime_ms: dir_mtime_ms(&path),
        is_git,
        base_branch,
        pipeline_type,
        branch,
        tracking_branch,
        remote_url,
        ahead,
        behind,
        dirty_files,
        repositories: Vec::new(),
    })
}

fn list_projects_blocking() -> Result<Vec<ProjectInfo>, String> {
    let config = read_config()?;
    config
        .projects
        .iter()
        .map(|path| {
            let canonical = canonicalize_or_original(Path::new(path))
                .to_string_lossy()
                .to_string();
            let mut project = project_info(
                Path::new(path),
                config
                    .base_branches
                    .get(path)
                    .or_else(|| config.base_branches.get(&canonical))
                    .cloned(),
                config
                    .pipeline_types
                    .get(path)
                    .or_else(|| config.pipeline_types.get(&canonical))
                    .cloned(),
            )?;
            let repositories = discover_git_repositories(Path::new(&project.path));
            if repositories.len() > 1 {
                project.repositories = repositories
                    .into_iter()
                    .map(|repository| {
                        let canonical = canonicalize_or_original(&repository)
                            .to_string_lossy()
                            .to_string();
                        project_info(
                            &repository,
                            config.base_branches.get(&canonical).cloned(),
                            config.pipeline_types.get(&canonical).cloned(),
                        )
                    })
                    .collect::<Result<Vec<_>, _>>()?;
            }
            Ok(project)
        })
        .collect()
}

#[tauri::command]
pub async fn list_projects() -> Result<Vec<ProjectInfo>, String> {
    tauri::async_runtime::spawn_blocking(list_projects_blocking)
        .await
        .map_err(|error| format!("Project discovery worker failed: {error}"))?
}

#[tauri::command]
pub async fn fetch_project_branches(path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repository = ensure_verified_repository(Path::new(&path))?;
        let output = Command::new("git")
            .args(["-C", &repository.to_string_lossy(), "fetch", "--all", "--prune"])
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        list_project_branches(repository.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("Branch fetch worker failed: {error}"))?
}

#[tauri::command]
pub fn list_project_branches(path: String) -> Result<Vec<String>, String> {
    let project = project_info(Path::new(&path), None, None)?;
    if !project.is_git {
        return Ok(Vec::new());
    }
    let output = Command::new("git")
        .args([
            "-C",
            &project.path,
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads",
            "refs/remotes",
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let mut branches = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|branch| !branch.is_empty() && !branch.ends_with("/HEAD"))
        .map(str::to_string)
        .collect::<Vec<_>>();
    branches.sort();
    Ok(branches)
}

#[tauri::command]
pub fn get_project_task_source(path: String) -> Result<TaskSource, String> {
    let canonical = canonicalize_or_original(Path::new(&path))
        .to_string_lossy()
        .to_string();
    let config = read_config()?;
    Ok(config
        .task_sources
        .get(&canonical)
        .or_else(|| config.task_sources.get(&path))
        .cloned()
        .unwrap_or(TaskSource {
            kind: "local".into(),
            url: String::new(),
            sheet: String::new(),
            sheets: Vec::new(),
            pics: Vec::new(),
        }))
}

#[tauri::command]
pub fn save_project_task_source(path: String, source: TaskSource) -> Result<TaskSource, String> {
    let canonical = canonicalize_or_original(Path::new(&path))
        .to_string_lossy()
        .to_string();
    let mut config = read_config()?;
    if !config
        .projects
        .iter()
        .any(|saved| canonicalize_or_original(Path::new(saved)).to_string_lossy() == canonical)
    {
        return Err(format!("project is not registered: {canonical}"));
    }
    if source.kind != "local" && source.kind != "google_sheets" {
        return Err("task source must be local or google_sheets".into());
    }
    let source = TaskSource {
        kind: source.kind,
        url: source.url.trim().to_string(),
        sheet: String::new(),
        sheets: if source.sheets.is_empty() { vec![source.sheet] } else { source.sheets }
            .into_iter()
            .map(|sheet| sheet.trim().to_string())
            .filter(|sheet| !sheet.is_empty())
            .collect(),
        pics: source
            .pics
            .into_iter()
            .map(|pic| pic.trim().to_string())
            .filter(|pic| !pic.is_empty())
            .collect(),
    };
    if source.kind == "google_sheets" {
        crate::kanban::google_sheet_csv_url(&source.url, source.sheets.first().map(String::as_str).unwrap_or_default())?;
        config.task_sources.insert(canonical, source.clone());
    } else {
        config.task_sources.remove(&canonical);
        config.task_sources.remove(&path);
    }
    let json = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    std::fs::write(config_path(), format!("{json}\n")).map_err(|error| error.to_string())?;
    Ok(source)
}

pub fn task_sources() -> Result<HashMap<String, TaskSource>, String> {
    Ok(read_config()?.task_sources)
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
pub fn discover_projects(path: String) -> Result<Vec<ProjectInfo>, String> {
    let root = PathBuf::from(path);
    if !root.is_dir() {
        return Err(format!("project directory not found: {}", root.display()));
    }
    let repositories = discover_git_repositories(&root);
    if repositories.is_empty() {
        return Ok(vec![project_info(&root, None, None)?]);
    }
    repositories
        .into_iter()
        .map(|repository| {
            let branch =
                current_branch(repository.to_string_lossy().as_ref()).ok_or_else(|| {
                    format!(
                        "Git repository has no active branch: {}",
                        repository.display()
                    )
                })?;
            project_info(&repository, Some(branch), None)
        })
        .collect()
}

#[tauri::command]
pub fn add_workspace(path: String) -> Result<ProjectInfo, String> {
    let root = canonicalize_or_original(Path::new(&path));
    if !root.is_dir() {
        return Err(format!("project directory not found: {}", root.display()));
    }
    let repositories = discover_git_repositories(&root);
    if repositories.len() == 1 && repositories.first() == Some(&root) {
        let branch = current_branch(root.to_string_lossy().as_ref());
        return add_project(root.to_string_lossy().into_owned(), branch);
    }
    let mut config = read_config()?;
    let root_string = root.to_string_lossy().into_owned();
    config.projects.retain(|saved| {
        let saved = canonicalize_or_original(Path::new(saved));
        saved == root || !saved.starts_with(&root)
    });
    if !config
        .projects
        .iter()
        .any(|saved| canonicalize_or_original(Path::new(saved)) == root)
    {
        config.projects.push(root_string.clone());
    }
    for repository in repositories {
        let repository = canonicalize_or_original(&repository)
            .to_string_lossy()
            .into_owned();
        let branch = current_branch(&repository)
            .ok_or_else(|| format!("Git repository has no active branch: {repository}"))?;
        config.base_branches.insert(repository, branch);
    }
    let json = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    std::fs::write(config_path(), format!("{json}\n")).map_err(|error| error.to_string())?;
    list_projects_blocking()?
        .into_iter()
        .find(|project| project.path == root_string)
        .ok_or("workspace registration failed".into())
}

#[tauri::command]
pub fn add_project(path: String, base_branch: Option<String>) -> Result<ProjectInfo, String> {
    let mut project = project_info(Path::new(&path), base_branch.clone(), None)?;
    if project.is_git {
        let branch = base_branch
            .filter(|branch| !branch.trim().is_empty())
            .ok_or("base branch required")?;
        let exists = Command::new("git")
            .args([
                "-C",
                &project.path,
                "rev-parse",
                "--verify",
                &format!("refs/heads/{branch}"),
            ])
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
        config
            .base_branches
            .insert(project.path.clone(), branch.clone());
    }
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(config_path(), format!("{json}\n")).map_err(|e| e.to_string())?;
    Ok(project)
}

#[tauri::command]
pub fn update_project_base_branch(
    path: String,
    base_branch: String,
) -> Result<ProjectInfo, String> {
    let mut project = project_info(Path::new(&path), Some(base_branch.clone()), None)?;
    if !project.is_git {
        return Err("base branch is only available for Git projects".into());
    }
    let reference = if base_branch.contains('/') {
        format!("refs/remotes/{base_branch}")
    } else {
        format!("refs/heads/{base_branch}")
    };
    let exists = Command::new("git")
        .args(["-C", &project.path, "rev-parse", "--verify", &reference])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    if !exists {
        return Err(format!("branch not found: {base_branch}"));
    }
    let mut config = read_config()?;
    let registered = config.projects.iter().any(|saved| {
        let root = canonicalize_or_original(Path::new(saved));
        root == PathBuf::from(&project.path)
            || discover_git_repositories(&root).contains(&PathBuf::from(&project.path))
    });
    if !registered {
        return Err(format!("project is not registered: {}", project.path));
    }
    config
        .base_branches
        .insert(project.path.clone(), base_branch.clone());
    let json = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    std::fs::write(config_path(), format!("{json}\n")).map_err(|error| error.to_string())?;
    project.base_branch = Some(base_branch);
    project.pipeline_type = config.pipeline_types.get(&project.path).cloned();
    Ok(project)
}

#[tauri::command]
pub fn update_project_pipeline_type(
    path: String,
    pipeline_type: String,
) -> Result<ProjectInfo, String> {
    let pipeline_type = pipeline_type.trim().to_string();
    if !matches!(pipeline_type.as_str(), "Personal" | "MBI" | "KAI") {
        return Err("pipeline type must be Personal, MBI, or KAI".into());
    }
    let mut config = read_config()?;
    let canonical = canonicalize_or_original(Path::new(&path))
        .to_string_lossy()
        .to_string();
    if !config
        .projects
        .iter()
        .any(|saved| canonicalize_or_original(Path::new(saved)).to_string_lossy() == canonical)
    {
        return Err(format!("project is not registered: {canonical}"));
    }
    config
        .pipeline_types
        .insert(canonical.clone(), pipeline_type.clone());
    let json = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    std::fs::write(config_path(), format!("{json}\n")).map_err(|error| error.to_string())?;
    let base_branch = config.base_branches.get(&canonical).cloned();
    project_info(Path::new(&canonical), base_branch, Some(pipeline_type))
}

#[tauri::command]
pub fn remove_project(path: String) -> Result<(), String> {
    let canonical = canonicalize_or_original(Path::new(&path))
        .to_string_lossy()
        .to_string();
    let mut config = read_config()?;
    config
        .projects
        .retain(|saved| canonicalize_or_original(Path::new(saved)).to_string_lossy() != canonical);
    config.base_branches.remove(&canonical);
    config.base_branches.remove(&path);
    config.pipeline_types.remove(&canonical);
    config.pipeline_types.remove(&path);
    config.task_sources.remove(&canonical);
    config.task_sources.remove(&path);
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

pub(crate) fn registered_workspace(child: &Path) -> Option<PathBuf> {
    let child = canonicalize_or_original(child);
    read_config().ok()?.projects.into_iter().find_map(|saved| {
        let saved = canonicalize_or_original(Path::new(&saved));
        child.starts_with(&saved).then_some(saved)
    })
}

pub(crate) fn graph_repositories(project: &Path) -> Vec<PathBuf> {
    discover_git_repositories(project)
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

    fn init_repo(path: &Path) {
        std::fs::create_dir_all(path).unwrap();
        assert!(Command::new("git").args(["init", "-q", path.to_str().unwrap()]).status().unwrap().success());
    }

    #[test]
    fn discovers_only_independent_nested_git_repositories() {
        let root = std::env::temp_dir().join(format!("crc-project-discovery-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        init_repo(&root.join("backend"));
        init_repo(&root.join("frontend"));
        std::fs::create_dir_all(root.join("inherited")).unwrap();

        assert_eq!(discover_git_repositories(&root), vec![canonicalize_or_original(&root.join("backend")), canonicalize_or_original(&root.join("frontend"))]);
        assert!(verified_repository_root(&root.join("inherited")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn discovers_git_worktree_with_git_file() {
        let root = std::env::temp_dir().join(format!("crc-worktree-discovery-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        init_repo(&repo);
        assert!(Command::new("git").args(["-C", repo.to_str().unwrap(), "config", "user.email", "test@example.com"]).status().unwrap().success());
        std::fs::write(repo.join("file"), "x").unwrap();
        assert!(Command::new("git").args(["-C", repo.to_str().unwrap(), "add", "."]).status().unwrap().success());
        assert!(Command::new("git").args(["-C", repo.to_str().unwrap(), "commit", "-qm", "init"]).status().unwrap().success());
        let worktree = root.join("worktree");
        assert!(Command::new("git").args(["-C", repo.to_str().unwrap(), "worktree", "add", "-q", "-b", "feature", worktree.to_str().unwrap()]).status().unwrap().success());
        assert!(worktree.join(".git").is_file());
        assert_eq!(verified_repository_root(&worktree).unwrap(), canonicalize_or_original(&worktree));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_graphs_include_parent_and_independent_children() {
        let root = std::env::temp_dir().join(format!("crc-workspace-graphs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        init_repo(&root);
        init_repo(&root.join("backend"));
        init_repo(&root.join("frontend"));
        assert_eq!(graph_repositories(&root), vec![canonicalize_or_original(&root), canonicalize_or_original(&root.join("backend")), canonicalize_or_original(&root.join("frontend"))]);
        std::fs::remove_dir_all(root).unwrap();
    }
}
