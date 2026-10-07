#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;

// Stable across restarts; unlike DefaultHasher this also defines our on-disk keys.
fn local_path_key(path: &Path) -> String {
    let hash = path
        .to_string_lossy()
        .bytes()
        .fold(0xcbf29ce484222325u64, |h, b| {
            (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
        });
    format!("{hash:016x}")
}

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

/// Per-worktree agent memory file (munder-difflin pattern).
const WORKTREE_MEMORY_FILE: &str = "memory.md";

/// YYYY-MM-DD (UTC) for a unix timestamp — Howard Hinnant's civil-from-days.
fn unix_date_yyyymmdd(unix_secs: u64) -> String {
    let z = (unix_secs / 86_400) as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}

fn worktree_memory_template(project_name: &str, created: &str) -> String {
    format!(
        "# memory.md — {project_name}\n\
         \n\
         Per-worktree agent memory (munder-difflin pattern).\n\
         Local-only: this file is excluded from git via the repository's `.git/info/exclude` — it never appears in diffs and is never committed.\n\
         \n\
         Created: {created}\n\
         \n\
         ## Instructions\n\
         - Read this file at session start.\n\
         - Append durable learnings here as short bullets: decisions made, gotchas found, user preferences, tool quirks worth remembering.\n\
         - Keep bullets short and session-transcending; this is not a task log.\n\
         \n\
         ## Learnings\n"
    )
}

/// Absolute common git dir for a worktree (the main checkout's `.git`).
/// Linked worktrees read `info/exclude` from the common dir — the
/// worktree-local `info/exclude` is NOT honored by git (verified on
/// git 2.43), so the exclusion must live there to take effect.
fn worktree_common_git_dir(worktree_path: &Path) -> Option<PathBuf> {
    let out = Command::new("git")
        .arg("-C")
        .arg(worktree_path)
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!dir.is_empty()).then_some(PathBuf::from(dir))
}

/// Keep `memory.md` out of git entirely: append it to the repository's
/// `.git/info/exclude` (local-only, never committed; the pattern is
/// root-anchored so nested `memory.md` files are unaffected). Git reads
/// excludes for linked worktrees from the common dir, so this keeps
/// `memory.md` out of `git status`/diffs — and, critically, it never
/// blocks the "worktree clean → auto-remove" check in
/// `remove_worktree_if_empty`.
fn exclude_worktree_memory(worktree_path: &Path) {
    let Some(git_dir) = worktree_common_git_dir(worktree_path) else {
        return;
    };
    let info_dir = git_dir.join("info");
    if std::fs::create_dir_all(&info_dir).is_err() {
        return;
    }
    let exclude = info_dir.join("exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if existing
        .lines()
        .any(|line| line.trim() == "/memory.md" || line.trim() == "memory.md")
    {
        return;
    }
    let mut contents = existing;
    if !contents.is_empty() && !contents.ends_with('\n') {
        contents.push('\n');
    }
    contents.push_str(
        "# per-worktree agent memory (munder-difflin): local-only, never commit\n/memory.md\n",
    );
    let _ = std::fs::write(&exclude, contents);
}

/// Create `<worktree>/memory.md` from template when absent and keep it
/// git-local via `.git/info/exclude`. Best-effort: worktree creation must
/// never fail because memory setup did.
fn ensure_worktree_memory(worktree_path: &Path, project_name: &str) {
    if let Err(error) = anchor_worktree_memory(worktree_path, project_name) {
        eprintln!("Worktree memory could not be anchored: {error}");
    }
}

/// Git metadata survives ephemeral checkout removal and is already scoped to this repository.
/// Each chat keeps its own memory; migrating an old regular file preserves its contents.
fn anchor_worktree_memory(worktree_path: &Path, project_name: &str) -> Result<(), String> {
    let common = worktree_common_git_dir(worktree_path).ok_or("memory repository unavailable")?;
    let durable = common
        .join("kern/memory")
        .join(format!("{}.md", local_path_key(worktree_path)));
    std::fs::create_dir_all(durable.parent().unwrap()).map_err(|e| e.to_string())?;
    let memory = worktree_path.join(WORKTREE_MEMORY_FILE);
    if memory.is_symlink()
        && memory.canonicalize().ok() == durable.canonicalize().ok()
        && durable.exists()
    {
        exclude_worktree_memory(worktree_path);
        return Ok(());
    }
    if memory.is_file() {
        let legacy = std::fs::read_to_string(&memory).map_err(|e| e.to_string())?;
        let existing = std::fs::read_to_string(&durable).unwrap_or_default();
        if existing != legacy {
            let contents = if existing.is_empty() || legacy.starts_with(&existing) {
                legacy
            } else {
                format!("{existing}\n\n## Recovered checkout memory\n{legacy}")
            };
            std::fs::write(&durable, contents).map_err(|e| e.to_string())?;
        }
    } else if !durable.exists() {
        let created = unix_date_yyyymmdd(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        );
        std::fs::write(&durable, worktree_memory_template(project_name, &created))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(unix)]
    {
        if memory.symlink_metadata().is_ok() {
            std::fs::remove_file(&memory).map_err(|e| e.to_string())?;
        }
        std::os::unix::fs::symlink(&durable, &memory).map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    std::fs::copy(&durable, &memory).map_err(|e| e.to_string())?;
    exclude_worktree_memory(worktree_path);
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

fn worktree_info(
    repo_path: &Path,
    worktree_path: String,
    branch: String,
    repo_name: String,
    slug: String,
    parent_ref: String,
) -> WorktreeInfo {
    let remote = Command::new("git")
        .args([
            "-C",
            &repo_path.to_string_lossy(),
            "remote",
            "get-url",
            "origin",
        ])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty());
    WorktreeInfo {
        workspace_root: crate::projects::registered_workspace(repo_path)
            .unwrap_or_else(|| repo_path.to_path_buf())
            .to_string_lossy()
            .into(),
        repository_root: repo_path.to_string_lossy().into(),
        repository_id: repo_path.to_string_lossy().into(),
        remote,
        worktree_path,
        branch,
        repo_name,
        slug,
        parent_ref,
    }
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
        ensure_worktree_memory(&worktree_path, &safe_repo);
        let branch = format!("crc/{}", safe_slug);
        let parent = resolve_parent_ref(repo_path)?;
        return Ok(worktree_info(
            repo_path,
            worktree_path_str,
            branch,
            safe_repo,
            safe_slug,
            parent,
        ));
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
    ensure_worktree_memory(&worktree_path, &safe_repo);

    Ok(worktree_info(
        repo_path,
        worktree_path_str,
        branch,
        safe_repo,
        safe_slug,
        parent_ref,
    ))
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

    // Never discard the only copy of legacy memory if migration fails.
    if wt_path
        .join(WORKTREE_MEMORY_FILE)
        .symlink_metadata()
        .is_ok()
    {
        anchor_worktree_memory(wt_path, "session")?;
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
        .filter(|root| {
            root == &crate::projects::canonicalize_or_original(Path::new(&workspace_path))
        })
        .ok_or("workspace is not registered")?;
    let repositories = crate::projects::discover_git_repositories(&workspace);
    if repositories.is_empty() {
        return Err("workspace has no independent Git repositories".into());
    }
    let session = crate::projects::global_worktree_root()?
        .join("workspace-sessions")
        .join(sanitize_repo_name(&slug));
    std::fs::create_dir_all(&session).map_err(|e| e.to_string())?;
    std::fs::write(
        session.join(".crc-workspace-root"),
        workspace.to_string_lossy().as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    let repository_paths = repositories
        .iter()
        .map(|path| crate::projects::canonicalize_or_original(path))
        .collect::<Vec<_>>();
    for entry in std::fs::read_dir(&workspace)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
    {
        let source = entry.path();
        let name = entry.file_name();
        if name == ".crc-worktrees"
            || repository_paths.contains(&crate::projects::canonicalize_or_original(&source))
        {
            continue;
        }
        let link = session.join(&name);
        if link.symlink_metadata().is_ok() {
            if link.read_link().ok().as_ref() == Some(&source) {
                continue;
            }
            if link.is_dir() && !link.is_symlink() {
                std::fs::remove_dir_all(&link).map_err(|e| e.to_string())?;
            } else {
                std::fs::remove_file(&link).map_err(|e| e.to_string())?;
            }
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(source, link).map_err(|e| e.to_string())?;
        #[cfg(not(unix))]
        return Err("multi-repository workspace sessions currently require symlink support".into());
    }
    for repository in repositories {
        let name = repository
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("invalid repository name")?;
        let worktree = create_worktree(&workspace, &repository, name, &slug)?;
        let target = PathBuf::from(worktree.worktree_path);
        let link = session.join(name);
        if link.symlink_metadata().is_ok() {
            if link.read_link().ok().as_ref() == Some(&target) {
                continue;
            }
            std::fs::remove_file(&link).map_err(|e| e.to_string())?;
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).map_err(|e| e.to_string())?;
        #[cfg(not(unix))]
        return Err("multi-repository workspace sessions currently require symlink support".into());
    }
    Ok(session.to_string_lossy().into_owned())
}

fn verified_worktree(repo_path: &str, worktree_path: &str) -> Result<(PathBuf, PathBuf), String> {
    let project_root = read_config_project_root()?;
    let rp = crate::projects::ensure_verified_repository(Path::new(repo_path))?;
    let wt = PathBuf::from(worktree_path);
    let worktree_repository = crate::projects::verified_repository_root(&wt)?;
    let common = Command::new("git")
        .args([
            "-C",
            &rp.to_string_lossy(),
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    let worktree_common = Command::new("git")
        .args([
            "-C",
            &worktree_repository.to_string_lossy(),
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !common.status.success()
        || !worktree_common.status.success()
        || common.stdout != worktree_common.stdout
    {
        return Err("worktree belongs to another repository".into());
    }
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
    Ok((project_root, rp))
}

fn remove_worktree_blocking(
    repo_path: String,
    worktree_path: String,
    parent_ref: String,
) -> Result<bool, String> {
    let (project_root, rp) = verified_worktree(&repo_path, &worktree_path)?;
    remove_worktree_if_empty(&project_root, &rp, &worktree_path, &parent_ref)
}

fn force_remove_registered_worktree(rp: &Path, worktree_path: &str) -> Result<(), String> {
    let branch = Command::new("git")
        .args(["-C", worktree_path, "branch", "--show-current"])
        .output()
        .map_err(|e| e.to_string())?;
    if !branch.status.success() {
        return Err(String::from_utf8_lossy(&branch.stderr).trim().to_string());
    }
    let branch = String::from_utf8_lossy(&branch.stdout).trim().to_string();
    if !branch.starts_with("crc/") {
        return Err("refusing to delete a non-CRC branch".into());
    }
    let memory = Path::new(worktree_path).join(WORKTREE_MEMORY_FILE);
    if memory.symlink_metadata().is_ok() {
        anchor_worktree_memory(Path::new(worktree_path), "session")?;
    }
    let repo = rp.to_string_lossy();
    let removed = Command::new("git")
        .args(["-C", &repo, "worktree", "remove", "--force", worktree_path])
        .output()
        .map_err(|e| e.to_string())?;
    if !removed.status.success() {
        return Err(String::from_utf8_lossy(&removed.stderr).trim().to_string());
    }
    let deleted = Command::new("git")
        .args(["-C", &repo, "branch", "-D", &branch])
        .output()
        .map_err(|e| e.to_string())?;
    if !deleted.status.success() {
        return Err(String::from_utf8_lossy(&deleted.stderr).trim().to_string());
    }
    Ok(())
}

fn force_remove_worktree_blocking(repo_path: String, worktree_path: String) -> Result<(), String> {
    let (_, rp) = verified_worktree(&repo_path, &worktree_path)?;
    force_remove_registered_worktree(&rp, &worktree_path)
}

fn cleanup_orphaned_worktrees_blocking(active_slugs: Vec<String>) -> Result<usize, String> {
    let root = crate::projects::global_worktree_root()?;
    if !root.exists() {
        return Ok(0);
    }
    let active = active_slugs
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    let mut removed = 0;
    for repository_dir in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
        let repository_dir = repository_dir.map_err(|e| e.to_string())?.path();
        if !repository_dir.is_dir()
            || repository_dir.file_name().and_then(|name| name.to_str())
                == Some("workspace-sessions")
        {
            continue;
        }
        for entry in std::fs::read_dir(repository_dir).map_err(|e| e.to_string())? {
            let worktree = entry.map_err(|e| e.to_string())?.path();
            let slug = worktree
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            if active.contains(slug) || !worktree.is_dir() {
                continue;
            }
            // ponytail: plain `git worktree remove` (no --force) — dirty or
            // in-use worktrees make git itself refuse, so uncommitted work and
            // live sessions survive cleanup. Force removal stays an explicit
            // user action (force_remove_worktree).
            let wt = worktree.to_string_lossy().to_string();
            let branch = String::from_utf8_lossy(
                &Command::new("git")
                    .args(["-C", &wt, "branch", "--show-current"])
                    .output()
                    .map_err(|e| e.to_string())?
                    .stdout,
            )
            .trim()
            .to_string();
            if !branch.starts_with("crc/") {
                continue;
            }
            let common = Command::new("git")
                .args([
                    "-C",
                    &worktree.to_string_lossy(),
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-common-dir",
                ])
                .output()
                .map_err(|e| e.to_string())?;
            if !common.status.success() {
                continue;
            }
            let common = PathBuf::from(String::from_utf8_lossy(&common.stdout).trim());
            let Some(repository) = common.parent() else {
                continue;
            };
            let removed_wt = Command::new("git")
                .args([
                    "-C",
                    &repository.to_string_lossy(),
                    "worktree",
                    "remove",
                    &wt,
                ])
                .output()
                .map_err(|e| e.to_string())?;
            if !removed_wt.status.success() {
                continue; // dirty, locked, or live — never force here
            }
            let _ = Command::new("git")
                .args(["-C", &repository.to_string_lossy(), "branch", "-D", &branch])
                .output();
            removed += 1;
        }
    }
    // ponytail: workspace-sessions dirs are no longer auto-deleted here —
    // local tabs cannot prove another instance's session is dead.
    Ok(removed)
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

#[tauri::command]
pub async fn cleanup_orphaned_worktrees(active_slugs: Vec<String>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || cleanup_orphaned_worktrees_blocking(active_slugs))
        .await
        .map_err(|e| format!("Worktree worker failed: {e}"))?
}

#[tauri::command]
pub async fn force_remove_worktree(repo_path: String, worktree_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        force_remove_worktree_blocking(repo_path, worktree_path)
    })
    .await
    .map_err(|e| format!("Worktree worker failed: {e}"))?
}

// ── Checkpoints (Cursor-style: snapshot per user message) ────────────────────

/// A git commit created by `create_checkpoint` (subject prefixed `checkpoint: `).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Checkpoint {
    pub sha: String,
    pub timestamp: i64,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CheckpointResult {
    /// "committed" for a new internal snapshot, "unchanged" for a duplicate, or "clean".
    pub status: String,
    pub sha: Option<String>,
}

/// Keep the checkpoint subject on a single line (git log filtering depends on the prefix).
fn sanitize_checkpoint_message(message: &str) -> String {
    message
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .chars()
        .take(160)
        .collect()
}

fn is_valid_checkpoint_sha(sha: &str) -> bool {
    let len = sha.len();
    (7..=40).contains(&len) && sha.chars().all(|c| c.is_ascii_hexdigit())
}

fn checkpoint_repo(worktree_path: &str) -> Result<String, String> {
    let path = crate::projects::ensure_path_allowed(Path::new(worktree_path))?;
    let path_str = path.to_string_lossy().to_string();
    let probe = Command::new("git")
        .args(["-C", &path_str, "rev-parse", "--git-dir"])
        .output()
        .map_err(|e| e.to_string())?;
    if !probe.status.success() {
        return Err(format!("not a git worktree: {worktree_path}"));
    }
    Ok(path_str)
}

#[tauri::command]
pub fn create_checkpoint(
    worktree_path: String,
    message: String,
) -> Result<CheckpointResult, String> {
    let path_str = checkpoint_repo(&worktree_path)?;
    create_checkpoint_in_repo(&path_str, &message)
}

static CHECKPOINT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct TemporaryIndex(PathBuf);
impl Drop for TemporaryIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let _ = std::fs::remove_file(format!("{}.lock", self.0.display()));
    }
}

fn checkpoint_ref(path: &str) -> String {
    format!("refs/kern/checkpoints/{}", local_path_key(Path::new(path)))
}

fn checkpoint_git(path: &str, args: &[&str], index: Option<&Path>) -> Result<String, String> {
    let mut command = Command::new("git");
    command.args(["-C", path]).args(args);
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    let out = command.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn create_checkpoint_in_repo(path_str: &str, message: &str) -> Result<CheckpointResult, String> {
    let _guard = CHECKPOINT_LOCK
        .lock()
        .map_err(|_| "checkpoint lock poisoned")?;
    if checkpoint_git(path_str, &["status", "--porcelain"], None)?.is_empty() {
        return Ok(CheckpointResult {
            status: "clean".into(),
            sha: None,
        });
    }
    let common =
        worktree_common_git_dir(Path::new(path_str)).ok_or("checkpoint repository unavailable")?;
    let folder = common.join("kern/indexes");
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let index = TemporaryIndex(folder.join(format!("{}-{nonce}.index", std::process::id())));
    checkpoint_git(path_str, &["read-tree", "HEAD"], Some(&index.0))?;
    checkpoint_git(path_str, &["add", "-A", "--", "."], Some(&index.0))?;
    let tree = checkpoint_git(path_str, &["write-tree"], Some(&index.0))?;
    let reference = checkpoint_ref(path_str);
    let previous = checkpoint_git(path_str, &["rev-parse", "--verify", &reference], None).ok();
    if let Some(previous) = &previous {
        if checkpoint_git(
            path_str,
            &["rev-parse", &format!("{previous}^{{tree}}")],
            None,
        )? == tree
        {
            return Ok(CheckpointResult {
                status: "unchanged".into(),
                sha: Some(previous.clone()),
            });
        }
    }
    let parent = previous.unwrap_or(checkpoint_git(path_str, &["rev-parse", "HEAD"], None)?);
    let subject = format!("checkpoint: {}", sanitize_checkpoint_message(message));
    // A snapshot is an internal object, not an authored commit on the delivery branch.
    let sha = checkpoint_git(
        path_str,
        &[
            "-c",
            "user.name=Kern Studio",
            "-c",
            "user.email=kern@localhost",
            "commit-tree",
            &tree,
            "-p",
            &parent,
            "-m",
            &subject,
        ],
        None,
    )?;
    checkpoint_git(path_str, &["update-ref", &reference, &sha], None)?;
    Ok(CheckpointResult {
        status: "committed".into(),
        sha: Some(sha),
    })
}

#[tauri::command]
pub fn list_checkpoints(worktree_path: String) -> Result<Vec<Checkpoint>, String> {
    let path_str = checkpoint_repo(&worktree_path)?;
    list_checkpoints_in_repo(&path_str)
}

fn list_checkpoints_in_repo(path_str: &str) -> Result<Vec<Checkpoint>, String> {
    let reference = checkpoint_ref(path_str);
    let mut refs = vec!["HEAD".to_string()];
    if checkpoint_git(path_str, &["rev-parse", "--verify", &reference], None).is_ok() {
        refs.push(reference);
    }
    let mut args = vec![
        "log",
        "--grep=^checkpoint:",
        "--format=%H%x00%ct%x00%s%x1e",
        "-n",
        "100",
    ];
    args.extend(refs.iter().map(String::as_str));
    let output = checkpoint_git(path_str, &args, None)?;
    let mut checkpoints = Vec::new();
    for record in output.split('\u{1e}') {
        let mut parts = record.trim().splitn(3, '\0');
        let (Some(sha), Some(timestamp), Some(subject)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        checkpoints.push(Checkpoint {
            sha: sha.to_string(),
            timestamp: timestamp.parse::<i64>().unwrap_or(0),
            message: subject
                .strip_prefix("checkpoint:")
                .map(str::trim)
                .unwrap_or(subject)
                .to_string(),
        });
    }
    Ok(checkpoints)
}

/// Restore tracked files to a checkpoint commit.
///
/// Uses `git restore --source {sha} --staged --worktree -- .`: tracked files
/// added after the snapshot are removed as well. Untracked
/// files created after the checkpoint are left alone, and the conversation is
/// untouched (it lives in the pi session file, not in git).
#[tauri::command]
pub fn restore_checkpoint(worktree_path: String, sha: String) -> Result<String, String> {
    if !is_valid_checkpoint_sha(&sha) {
        return Err("invalid checkpoint sha".to_string());
    }
    let path_str = checkpoint_repo(&worktree_path)?;
    restore_checkpoint_in_repo(&path_str, &sha)
}

fn restore_checkpoint_in_repo(path_str: &str, sha: &str) -> Result<String, String> {
    let _guard = CHECKPOINT_LOCK
        .lock()
        .map_err(|_| "checkpoint lock poisoned")?;
    let kind = Command::new("git")
        .args(["-C", &path_str, "cat-file", "-t", &sha])
        .output()
        .map_err(|e| e.to_string())?;
    if !kind.status.success() || String::from_utf8_lossy(&kind.stdout).trim() != "commit" {
        return Err("sha does not resolve to a commit".to_string());
    }
    let out = Command::new("git")
        .args([
            "-C",
            path_str,
            "restore",
            "--source",
            sha,
            "--staged",
            "--worktree",
            "--",
            ".",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "restore failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(sha.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn force_remove_deletes_dirty_worktree_and_crc_branch() {
        let root = std::env::temp_dir().join(format!("crc-force-remove-{}", std::process::id()));
        let repo = root.join("repo");
        let worktree = root.join("worktree");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&repo).unwrap();
        Command::new("git")
            .args(["init", repo.to_str().unwrap()])
            .output()
            .unwrap();
        Command::new("git")
            .args([
                "-C",
                repo.to_str().unwrap(),
                "config",
                "user.email",
                "test@example.com",
            ])
            .output()
            .unwrap();
        Command::new("git")
            .args(["-C", repo.to_str().unwrap(), "config", "user.name", "Test"])
            .output()
            .unwrap();
        std::fs::write(repo.join("tracked"), "base").unwrap();
        Command::new("git")
            .args(["-C", repo.to_str().unwrap(), "add", "tracked"])
            .output()
            .unwrap();
        Command::new("git")
            .args(["-C", repo.to_str().unwrap(), "commit", "-m", "base"])
            .output()
            .unwrap();
        Command::new("git")
            .args([
                "-C",
                repo.to_str().unwrap(),
                "worktree",
                "add",
                worktree.to_str().unwrap(),
                "-b",
                "crc/test-close",
            ])
            .output()
            .unwrap();
        std::fs::write(worktree.join("dirty"), "discard me").unwrap();
        std::fs::write(
            worktree.join(WORKTREE_MEMORY_FILE),
            "prefers focused checks",
        )
        .unwrap();

        force_remove_registered_worktree(&repo, worktree.to_str().unwrap()).unwrap();

        assert!(!worktree.exists());
        let memories = std::fs::read_dir(repo.join(".git/kern/memory"))
            .unwrap()
            .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(memories, vec!["prefers focused checks"]);
        let branch = Command::new("git")
            .args([
                "-C",
                repo.to_str().unwrap(),
                "branch",
                "--list",
                "crc/test-close",
            ])
            .output()
            .unwrap();
        assert!(branch.stdout.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn force_remove_refuses_non_crc_branch() {
        let root = std::env::temp_dir().join(format!("crc-force-guard-{}", std::process::id()));
        let repo = root.join("repo");
        let worktree = root.join("worktree");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&repo).unwrap();
        Command::new("git")
            .args(["init", repo.to_str().unwrap()])
            .output()
            .unwrap();
        Command::new("git")
            .args([
                "-C",
                repo.to_str().unwrap(),
                "config",
                "user.email",
                "test@example.com",
            ])
            .output()
            .unwrap();
        Command::new("git")
            .args(["-C", repo.to_str().unwrap(), "config", "user.name", "Test"])
            .output()
            .unwrap();
        std::fs::write(repo.join("tracked"), "base").unwrap();
        Command::new("git")
            .args(["-C", repo.to_str().unwrap(), "add", "tracked"])
            .output()
            .unwrap();
        Command::new("git")
            .args(["-C", repo.to_str().unwrap(), "commit", "-m", "base"])
            .output()
            .unwrap();
        Command::new("git")
            .args([
                "-C",
                repo.to_str().unwrap(),
                "worktree",
                "add",
                worktree.to_str().unwrap(),
                "-b",
                "keep-me",
            ])
            .output()
            .unwrap();

        assert_eq!(
            force_remove_registered_worktree(&repo, worktree.to_str().unwrap()).unwrap_err(),
            "refusing to delete a non-CRC branch"
        );
        assert!(worktree.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

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

    #[test]
    fn unix_date_yyyymmdd_matches_known_dates() {
        // 2026-10-01 00:00:00 UTC
        assert_eq!(unix_date_yyyymmdd(1790812800), "2026-10-01");
        // 1970-01-01 00:00:00 UTC (epoch)
        assert_eq!(unix_date_yyyymmdd(0), "1970-01-01");
    }

    #[test]
    fn worktree_memory_created_with_template_and_excluded_from_git() {
        let root = std::env::temp_dir().join(format!("crc-mem-test-{}", std::process::id()));
        let repo = root.join("repo");
        let worktree = root.join("worktree");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&repo).unwrap();
        Command::new("git")
            .args(["init", repo.to_str().unwrap()])
            .output()
            .unwrap();
        Command::new("git")
            .args([
                "-C",
                repo.to_str().unwrap(),
                "config",
                "user.email",
                "test@example.com",
            ])
            .output()
            .unwrap();
        Command::new("git")
            .args(["-C", repo.to_str().unwrap(), "config", "user.name", "Test"])
            .output()
            .unwrap();
        Command::new("git")
            .args(["-C", repo.to_str().unwrap(), "branch", "-M", "main"])
            .output()
            .unwrap();
        std::fs::write(repo.join("tracked"), "base").unwrap();
        Command::new("git")
            .args(["-C", repo.to_str().unwrap(), "add", "tracked"])
            .output()
            .unwrap();
        Command::new("git")
            .args(["-C", repo.to_str().unwrap(), "commit", "-m", "base"])
            .output()
            .unwrap();
        Command::new("git")
            .args([
                "-C",
                repo.to_str().unwrap(),
                "worktree",
                "add",
                worktree.to_str().unwrap(),
                "-b",
                "crc/mem-test",
            ])
            .output()
            .unwrap();

        ensure_worktree_memory(&worktree, "demo-repo");
        let memory = std::fs::read_to_string(worktree.join("memory.md")).unwrap();
        assert!(memory.contains("# memory.md — demo-repo"));
        assert!(memory.contains("Read this file at session start"));
        assert!(memory.contains("Append durable learnings"));

        // Exclude entry is idempotent across re-ensures (resume path).
        ensure_worktree_memory(&worktree, "demo-repo");
        let exclude = std::fs::read_to_string(
            worktree_common_git_dir(&worktree)
                .unwrap()
                .join("info/exclude"),
        )
        .unwrap();
        assert_eq!(
            exclude
                .lines()
                .filter(|line| line.trim() == "/memory.md")
                .count(),
            1
        );

        // User-written learnings are preserved on re-ensure (resume path).
        std::fs::write(
            worktree.join("memory.md"),
            format!("{memory}\n- prefers tabs\n"),
        )
        .unwrap();
        ensure_worktree_memory(&worktree, "demo-repo");
        assert!(std::fs::read_to_string(worktree.join("memory.md"))
            .unwrap()
            .contains("prefers tabs"));

        // Excluded from git: status porcelain stays empty, so the clean →
        // auto-remove check is unaffected even with a populated memory.md.
        let status = Command::new("git")
            .args(["-C", worktree.to_str().unwrap(), "status", "--porcelain"])
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&status.stdout).trim().is_empty());
        let removed =
            remove_worktree_if_empty(&root, &repo, worktree.to_str().unwrap(), "main").unwrap();
        assert!(removed);
        assert!(!worktree.exists());
        // Recreate the ephemeral checkout: durable memory returns, not a fresh template.
        let out = Command::new("git")
            .args([
                "-C",
                repo.to_str().unwrap(),
                "worktree",
                "add",
                worktree.to_str().unwrap(),
                "crc/mem-test",
            ])
            .output()
            .unwrap();
        assert!(out.status.success());
        ensure_worktree_memory(&worktree, "demo-repo");
        assert!(std::fs::read_to_string(worktree.join("memory.md"))
            .unwrap()
            .contains("prefers tabs"));
        #[cfg(unix)]
        assert!(worktree.join("memory.md").is_symlink());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn checkpoint_sanitize_keeps_single_line() {
        assert_eq!(
            sanitize_checkpoint_message("  fix login  \nsecond line"),
            "fix login"
        );
        assert_eq!(sanitize_checkpoint_message(""), "");
        assert_eq!(sanitize_checkpoint_message("checkpoint"), "checkpoint");
        assert!(!is_valid_checkpoint_sha("zzzzzzz"));
        assert!(!is_valid_checkpoint_sha("../escape"));
        assert!(!is_valid_checkpoint_sha("abc"));
        assert!(is_valid_checkpoint_sha("abcdef1"));
        assert!(is_valid_checkpoint_sha(
            "0123456789abcdef0123456789abcdef01234567"
        ));
    }

    /// Minimal temp git repo for checkpoint tests (plain dir, not a worktree).
    fn init_checkpoint_repo(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let root =
            std::env::temp_dir().join(format!("crc-checkpoint-{tag}-{}", std::process::id()));
        let repo = root.join("repo");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&repo).unwrap();
        let repo_str = repo.to_str().unwrap().to_string();
        for args in [
            vec!["init".to_string(), repo_str.clone()],
            vec![
                "-C".to_string(),
                repo_str.clone(),
                "config".to_string(),
                "user.email".to_string(),
                "test@example.com".to_string(),
            ],
            vec![
                "-C".to_string(),
                repo_str.clone(),
                "config".to_string(),
                "user.name".to_string(),
                "Test".to_string(),
            ],
        ] {
            let out = Command::new("git").args(&args).output().unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        std::fs::write(repo.join("tracked.txt"), "base").unwrap();
        for args in [
            vec!["-C", repo.to_str().unwrap(), "add", "tracked.txt"],
            vec!["-C", repo.to_str().unwrap(), "commit", "-m", "base"],
        ] {
            let out = Command::new("git").args(&args).output().unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        (root, repo)
    }

    #[test]
    fn checkpoint_round_trip() {
        let (root, repo) = init_checkpoint_repo("roundtrip");
        let path = repo.to_str().unwrap().to_string();

        // Clean tree -> "clean", no sha.
        let clean = create_checkpoint_in_repo(&path, "nothing to save").unwrap();
        assert_eq!(clean.status, "clean");
        assert!(clean.sha.is_none());

        // Snapshot objects must leave the branch and staging byte-for-byte unchanged.
        let head_before = checkpoint_git(&path, &["rev-parse", "HEAD"], None).unwrap();
        std::fs::write(repo.join("staged.txt"), "staged content").unwrap();
        checkpoint_git(&path, &["add", "staged.txt"], None).unwrap();
        let index_path = repo.join(".git/index");
        let index_before = std::fs::read(&index_path).unwrap();
        // Dirty tree -> snapshot with sanitized single-line subject.
        std::fs::write(repo.join("tracked.txt"), "changed").unwrap();
        let made = create_checkpoint_in_repo(&path, "  user asked to tweak login\nmalicious\nline")
            .unwrap();
        assert_eq!(made.status, "committed");
        let sha = made.sha.clone().unwrap();
        assert!(is_valid_checkpoint_sha(&sha));
        assert_eq!(
            checkpoint_git(&path, &["rev-parse", "HEAD"], None).unwrap(),
            head_before
        );
        assert_eq!(std::fs::read(&index_path).unwrap(), index_before);
        let unchanged = create_checkpoint_in_repo(&path, "same contents").unwrap();
        assert_eq!(unchanged.status, "unchanged");
        assert_eq!(unchanged.sha.as_deref(), Some(sha.as_str()));
        assert_eq!(std::fs::read(&index_path).unwrap(), index_before);

        // A non-checkpoint commit is filtered out of the listing.
        std::fs::write(repo.join("other.txt"), "x").unwrap();
        Command::new("git")
            .args(["-C", &path, "add", "other.txt"])
            .output()
            .unwrap();
        Command::new("git")
            .args(["-C", &path, "commit", "-m", "regular commit"])
            .output()
            .unwrap();

        let list = list_checkpoints_in_repo(&path).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].sha, sha);
        assert!(list[0].timestamp > 0);
        assert_eq!(list[0].message, "user asked to tweak login");

        // Restore: tracked file reverts, untracked file created later is left alone.
        std::fs::write(repo.join("tracked.txt"), "even newer").unwrap();
        std::fs::write(repo.join("untracked.txt"), "keep me").unwrap();
        let restored = restore_checkpoint_in_repo(&path, &sha).unwrap();
        assert_eq!(restored, sha);
        assert!(!repo.join("other.txt").exists());
        assert_eq!(
            std::fs::read_to_string(repo.join("tracked.txt")).unwrap(),
            "changed"
        );
        assert_eq!(
            std::fs::read_to_string(repo.join("untracked.txt")).unwrap(),
            "keep me"
        );

        // Invalid sha rejected before any git runs.
        assert!(restore_checkpoint(path.clone(), "../evil".into()).is_err());
        assert!(restore_checkpoint(path.clone(), "abc".into()).is_err());
        assert!(restore_checkpoint(path.clone(), "0000000".into()).is_err());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn checkpoint_commands_reject_unregistered_paths() {
        let (root, repo) = init_checkpoint_repo("unregistered");
        let path = repo.to_string_lossy().to_string();
        assert!(create_checkpoint(path.clone(), "test".into())
            .unwrap_err()
            .contains("unregistered"));
        assert!(list_checkpoints(path.clone())
            .unwrap_err()
            .contains("unregistered"));
        let sha = Command::new("git")
            .args(["-C", &path, "rev-parse", "HEAD"])
            .output()
            .unwrap();
        assert!(restore_checkpoint(
            path,
            String::from_utf8_lossy(&sha.stdout).trim().to_string()
        )
        .unwrap_err()
        .contains("unregistered"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
