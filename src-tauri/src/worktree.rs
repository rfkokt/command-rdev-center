#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Root where all CRC worktrees live: /Volumes/ExternalM4/Project/.crc-worktrees
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
    pub worktree_path: String,
    pub branch: String,
    pub repo_name: String,
    pub slug: String,
    /// Parent ref used as starting point (origin/HEAD or main or master)
    pub parent_ref: String,
}

fn resolve_parent_ref(repo_path: &Path) -> Result<String, String> {
    crate::projects::project_base_branch(repo_path)
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
        let branch = format!("crc/{}", safe_slug);
        let parent = resolve_parent_ref(repo_path)?;
        return Ok(WorktreeInfo {
            worktree_path: worktree_path_str,
            branch,
            repo_name: safe_repo,
            slug: safe_slug,
            parent_ref: parent,
        });
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

    Ok(WorktreeInfo {
        worktree_path: worktree_path_str,
        branch,
        repo_name: safe_repo,
        slug: safe_slug,
        parent_ref,
    })
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
    let cfg_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("crc.config.json");
    let raw = std::fs::read_to_string(&cfg_path).map_err(|e| e.to_string())?;
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
    let rp = PathBuf::from(&repo_path);
    // Strict per-registered-project check — not just child of legacy root
    let _owner = crate::projects::ensure_path_allowed(&rp)?;
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

fn remove_worktree_blocking(
    repo_path: String,
    worktree_path: String,
    parent_ref: String,
) -> Result<bool, String> {
    let project_root = read_config_project_root()?;
    let rp = PathBuf::from(&repo_path);
    let _owner = crate::projects::ensure_path_allowed(&rp)?;
    let wt = PathBuf::from(&worktree_path);
    // also ensure worktree path belongs to same owning project
    crate::projects::ensure_path_allowed(&wt)?;
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
