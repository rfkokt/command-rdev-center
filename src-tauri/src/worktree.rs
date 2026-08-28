#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Root where all CRC worktrees live: `<project_root>/.crc-worktrees`.
fn worktree_root(project_root: &Path) -> PathBuf {
    project_root.join(".crc-worktrees")
}

/// Sanitize repo name for path safety.
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

/// Deterministically slugify a chat id / name into a single path component.
pub fn slugify(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .take(64)
        .collect::<String>()
}

fn sync_env_files(repo_path: &Path, worktree_path: &Path) -> Result<(), String> {
    let output = Command::new("git")
        .args([
            "-C",
            &repo_path.to_string_lossy(),
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    for relative in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        let relative = Path::new(std::str::from_utf8(relative).map_err(|e| e.to_string())?);
        let name = relative
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if !(name == ".env" || name.starts_with(".env.")) {
            continue;
        }
        let source = repo_path.join(relative);
        if !source.is_file() {
            continue;
        }
        let destination = worktree_path.join(relative);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if destination.symlink_metadata().is_ok() {
            if destination.is_dir() && !destination.is_symlink() {
                std::fs::remove_dir_all(&destination).map_err(|e| e.to_string())?;
            } else {
                std::fs::remove_file(&destination).map_err(|e| e.to_string())?;
            }
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(source, destination).map_err(|e| e.to_string())?;
        #[cfg(not(unix))]
        std::fs::copy(source, destination).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn ensure_worktree_root(project_root: &Path, repo_path: &Path) -> Result<PathBuf, String> {
    let root = worktree_root(project_root);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    if std::fs::metadata(repo_path)
        .map_err(|e| e.to_string())?
        .dev()
        != std::fs::metadata(&root).map_err(|e| e.to_string())?.dev()
    {
        return Err("worktree root and repository must be on the same filesystem".to_string());
    }
    Ok(root)
}

/// Result of creating a worktree.
#[derive(Debug, Clone, serde::Serialize)]
pub struct WorktreeInfo {
    pub workspace_root: String,
    pub repository_root: String,
    pub repository_id: String,
    pub remote: Option<String>,
    pub worktree_path: String,
    pub branch: String,
    pub repo_name: String,
    pub slug: String,
    /// Parent ref used as starting point (origin/HEAD or main or master)
    pub parent_ref: String,
}

fn worktree_info(repo_path: &Path, worktree_path: String, branch: String, repo_name: String, slug: String, parent_ref: String) -> WorktreeInfo {
    let remote = Command::new("git").args(["-C", &repo_path.to_string_lossy(), "remote", "get-url", "origin"]).output().ok().filter(|output| output.status.success()).map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string()).filter(|value| !value.is_empty());
    WorktreeInfo { workspace_root: crate::projects::registered_workspace(repo_path).unwrap_or_else(|| repo_path.to_path_buf()).to_string_lossy().into(), repository_root: repo_path.to_string_lossy().into(), repository_id: repo_path.to_string_lossy().into(), remote, worktree_path, branch, repo_name, slug, parent_ref }
}

fn resolve_parent_ref(repo_path: &Path) -> Result<String, String> {
    let branch = crate::projects::project_base_branch(repo_path)?;
    let repo = repo_path.to_string_lossy().to_string();
    let upstream = Command::new("git")
        .args([
            "-C",
            &repo,
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            &format!("{branch}@{{upstream}}"),
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !upstream.status.success() {
        return Ok(branch);
    }

    let upstream = String::from_utf8_lossy(&upstream.stdout).trim().to_string();
    let (remote, remote_branch) = upstream
        .split_once('/')
        .ok_or_else(|| format!("invalid upstream ref: {upstream}"))?;
    let fetch = Command::new("git")
        .args(["-C", &repo, "fetch", "--prune", remote, remote_branch])
        .output()
        .map_err(|e| e.to_string())?;
    if !fetch.status.success() {
        return Err(format!(
            "failed to update {upstream}: {}",
            String::from_utf8_lossy(&fetch.stderr).trim()
        ));
    }
    Ok(upstream)
}

pub fn create_worktree(
    project_root: &Path,
    repo_path: &Path,
    repo_name: &str,
    slug: &str,
) -> Result<WorktreeInfo, String> {
    let repo_path_str = repo_path.to_string_lossy().to_string();
    let safe_repo = sanitize_repo_name(repo_name);
    let safe_slug = sanitize_repo_name(slug);

    // deterministic single folder per repo+slug
    let wt_root = ensure_worktree_root(project_root, repo_path)?;
    let worktree_path = wt_root.join(&safe_repo).join(&safe_slug);
    let worktree_path_str = worktree_path.to_string_lossy().to_string();

    if worktree_path.exists() {
        // already exists — treat as resume path, re-use if branch matches
        // Ensure graphify-out symlink exists even on resume
        {
            let src = repo_path.join("graphify-out");
            let dst = worktree_path.join("graphify-out");
            if src.exists() && !dst.exists() {
                #[cfg(unix)]
                {
                    let _ = std::os::unix::fs::symlink(&src, &dst);
                }
            }
        }
        sync_env_files(repo_path, &worktree_path)?;
        let branch = format!("crc/{}", safe_slug);
        let parent = resolve_parent_ref(repo_path)?;
        return Ok(worktree_info(repo_path, worktree_path_str, branch, safe_repo, safe_slug, parent));
    }

    // ensure parent dir
    if let Some(parent_dir) = worktree_path.parent() {
        std::fs::create_dir_all(parent_dir).map_err(|e| e.to_string())?;
    }

    let parent_ref = resolve_parent_ref(repo_path)?;
    let branch = format!("crc/{}", safe_slug);

    // git worktree add <worktree_path> -b <branch> <parent_ref>
    // parent_ref is relative to repo_path
    let out = Command::new("git")
        .args([
            "-C",
            &repo_path_str,
            "worktree",
            "add",
            &worktree_path_str,
            "-b",
            &branch,
            &parent_ref,
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // maybe branch already exists — try without -b (attach existing branch)
        if stderr.contains("already exists") || stderr.contains("already used") {
            let out2 = Command::new("git")
                .args([
                    "-C",
                    &repo_path_str,
                    "worktree",
                    "add",
                    &worktree_path_str,
                    &branch,
                ])
                .output()
                .map_err(|e| e.to_string())?;
            if !out2.status.success() {
                return Err(format!(
                    "git worktree add failed: {}\nstderr: {}",
                    String::from_utf8_lossy(&out2.stderr),
                    stderr
                ));
            }
        } else {
            return Err(format!("git worktree add failed: {}", stderr));
        }
    }

    // Ensure graphify-out is available in worktree (gitignored in main repo, so worktree would miss it and agent burns tokens)
    // Symlink from main repo -> worktree
    {
        let src = repo_path.join("graphify-out");
        let dst = worktree_path.join("graphify-out");
        if src.exists() && !dst.exists() {
            #[cfg(unix)]
            {
                let _ = std::os::unix::fs::symlink(&src, &dst);
            }
            #[cfg(not(unix))]
            {
                // Windows fallback: copy marker files at least
                let _ = std::fs::create_dir_all(&dst);
            }
        }
    }

    sync_env_files(repo_path, &worktree_path)?;

    Ok(worktree_info(repo_path, worktree_path_str, branch, safe_repo, safe_slug, parent_ref))
}

pub fn remove_worktree_if_empty(
    _project_root: &Path,
    repo_path: &Path,
    worktree_path_str: &str,
    parent_ref: &str,
) -> Result<bool, String> {
    let wt_path = Path::new(worktree_path_str);
    if !wt_path.exists() {
        return Ok(false);
    }
    let out = Command::new("git")
        .args(["-C", worktree_path_str, "status", "--porcelain"])
        .output()
        .map_err(|e| e.to_string())?;
    let porcelain = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !porcelain.is_empty() {
        return Ok(false);
    }
    let ahead = Command::new("git")
        .args([
            "-C",
            worktree_path_str,
            "rev-list",
            "--count",
            &format!("{}..HEAD", parent_ref),
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !ahead.status.success() || String::from_utf8_lossy(&ahead.stdout).trim() != "0" {
        return Ok(false);
    }

    // Remove worktree
    let repo_path_str = repo_path.to_string_lossy().to_string();
    // git worktree remove --force <path>
    let rm_out = Command::new("git")
        .args([
            "-C",
            &repo_path_str,
            "worktree",
            "remove",
            "--force",
            worktree_path_str,
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if !rm_out.status.success() {
        // fallback: rm dir + prune
        let _ = std::fs::remove_dir_all(wt_path);
        let _ = Command::new("git")
            .args(["-C", &repo_path_str, "worktree", "prune"])
            .output();
    }
    Ok(true)
}

pub fn get_worktree_status(worktree_path_str: &str) -> Result<String, String> {
    let out = Command::new("git")
        .args(["-C", worktree_path_str, "status", "--porcelain"])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

fn read_config_project_root() -> Result<PathBuf, String> {
    // legacy: still reads project_root for worktree base dir
    let raw = std::fs::read_to_string(crate::projects::config_path()).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if let Some(root) = v.get("project_root").and_then(|r| r.as_str()) {
        if !root.trim().is_empty() {
            return Ok(PathBuf::from(root));
        }
    }
    crate::projects::global_worktree_root().map(|p| p.parent().unwrap_or(&p).to_path_buf())
}

fn ensure_worktree_blocking(
    repo_path: String,
    repo_name: String,
    slug: String,
) -> Result<WorktreeInfo, String> {
    let project_root = read_config_project_root()?;
    let rp = crate::projects::ensure_verified_repository(Path::new(&repo_path))?;
    // A worktree is always created from its canonical owning repository, never a workspace container.
    if slug.is_empty() {
        return Err("slug must not be empty".to_string());
    }
    create_worktree(&project_root, &rp, &repo_name, &slug)
}

#[tauri::command]
pub async fn ensure_worktree(
    repo_path: String,
    repo_name: String,
    slug: String,
) -> Result<WorktreeInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_worktree_blocking(repo_path, repo_name, slug)
    })
    .await
    .map_err(|e| format!("Worktree worker failed: {e}"))?
}

#[tauri::command]
pub fn ensure_workspace_session(workspace_path: String, slug: String) -> Result<String, String> {
    let workspace = crate::projects::registered_workspace(Path::new(&workspace_path))
        .filter(|root| root == &crate::projects::canonicalize_or_original(Path::new(&workspace_path)))
        .ok_or("workspace is not registered")?;
    let repositories = crate::projects::discover_git_repositories(&workspace);
    if repositories.is_empty() { return Err("workspace has no independent Git repositories".into()); }
    let session = crate::projects::global_worktree_root()?.join("workspace-sessions").join(sanitize_repo_name(&slug));
    std::fs::create_dir_all(&session).map_err(|e| e.to_string())?;
    std::fs::write(session.join(".crc-workspace-root"), workspace.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    for repository in repositories {
        let name = repository.file_name().ok_or("invalid repository name")?;
        let link = session.join(name);
        if link.symlink_metadata().is_ok() { continue; }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&repository, &link).map_err(|e| e.to_string())?;
        #[cfg(not(unix))]
        return Err("multi-repository workspace sessions currently require symlink support".into());
    }
    Ok(session.to_string_lossy().into_owned())
}

fn remove_worktree_blocking(
    repo_path: String,
    worktree_path: String,
    parent_ref: String,
) -> Result<bool, String> {
    let project_root = read_config_project_root()?;
    let rp = crate::projects::ensure_verified_repository(Path::new(&repo_path))?;
    let wt = PathBuf::from(&worktree_path);
    let worktree_repository = crate::projects::verified_repository_root(&wt)?;
    let common = Command::new("git").args(["-C", &rp.to_string_lossy(), "rev-parse", "--path-format=absolute", "--git-common-dir"]).output().map_err(|e| e.to_string())?;
    let worktree_common = Command::new("git").args(["-C", &worktree_repository.to_string_lossy(), "rev-parse", "--path-format=absolute", "--git-common-dir"]).output().map_err(|e| e.to_string())?;
    if !common.status.success() || !worktree_common.status.success() || common.stdout != worktree_common.stdout { return Err("worktree belongs to another repository".into()); }
    let expected_prefix = worktree_root(&project_root);
    let canon_prefix = expected_prefix
        .canonicalize()
        .unwrap_or(expected_prefix.clone());
    let canon_wt = wt.canonicalize().unwrap_or(wt.clone());
    if !canon_wt.starts_with(&canon_prefix) && !expected_prefix.exists() {
        // if legacy prefix missing (fresh config), skip prefix check if path_allowed already passed
    } else if !canon_wt.starts_with(&canon_prefix) {
        return Err(format!(
            "worktree path not inside {}",
            expected_prefix.display()
        ));
    }
    remove_worktree_if_empty(&project_root, &rp, &worktree_path, &parent_ref)
}

#[tauri::command]
pub async fn remove_worktree(
    repo_path: String,
    worktree_path: String,
    parent_ref: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        remove_worktree_blocking(repo_path, worktree_path, parent_ref)
    })
    .await
    .map_err(|e| format!("Worktree worker failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_env_files_overwrites_ignored_env_only() {
        let root = std::env::temp_dir().join(format!("crc-env-test-{}", std::process::id()));
        let repo = root.join("repo");
        let worktree = root.join("worktree");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&worktree).unwrap();
        Command::new("git")
            .args(["init", repo.to_str().unwrap()])
            .output()
            .unwrap();
        std::fs::write(repo.join(".gitignore"), ".env*\n").unwrap();
        std::fs::write(repo.join(".env"), "authoritative").unwrap();
        std::fs::write(repo.join(".env.example"), "example").unwrap();
        std::fs::create_dir_all(repo.join("packages/app")).unwrap();
        std::fs::write(repo.join("packages/app/.env.local"), "nested").unwrap();
        std::fs::write(worktree.join(".env"), "old").unwrap();

        sync_env_files(&repo, &worktree).unwrap();

        assert_eq!(
            std::fs::read_to_string(worktree.join(".env")).unwrap(),
            "authoritative"
        );
        assert_eq!(
            std::fs::read_to_string(worktree.join(".env.example")).unwrap(),
            "example"
        );
        assert_eq!(
            std::fs::read_to_string(worktree.join("packages/app/.env.local")).unwrap(),
            "nested"
        );
        #[cfg(unix)]
        assert!(worktree.join(".env").is_symlink());
        std::fs::remove_dir_all(root).unwrap();
    }
}
