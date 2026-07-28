use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Serialize)]
pub struct DiffFile {
    pub path: String,
    pub status: String,
    pub added: u32,
    pub removed: u32,
    pub patch: String,
}

#[derive(Debug, Serialize)]
pub struct WorktreeDiff {
    pub merge_base: String,
    pub files: Vec<DiffFile>,
}

fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn parse_status(raw: &str) -> Vec<(String, String)> {
    raw.lines()
        .filter_map(|line| {
            if line.len() < 4 {
                return None;
            }
            let status = line[..2].trim().to_string();
            let path = line[3..].split(" -> ").last()?.to_string();
            Some((path, status))
        })
        .collect()
}

fn parse_name_status(raw: &str) -> Vec<(String, String)> {
    raw.lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let status = parts.next()?.to_string();
            let path = parts.last()?.to_string();
            Some((path, status))
        })
        .collect()
}

fn count_lines(patch: &str) -> (u32, u32) {
    patch.lines().fold((0, 0), |(added, removed), line| {
        if line.starts_with('+') && !line.starts_with("+++") {
            (added + 1, removed)
        } else if line.starts_with('-') && !line.starts_with("---") {
            (added, removed + 1)
        } else {
            (added, removed)
        }
    })
}

fn untracked_patch(cwd: &str, path: &str) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["diff", "--no-index", "--", "/dev/null", path])
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() || output.status.code() == Some(1) {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn file_patch(cwd: &str, merge_base: &str, path: &str) -> Result<String, String> {
    let committed = git(
        cwd,
        &[
            "diff",
            "--no-ext-diff",
            &format!("{}...HEAD", merge_base),
            "--",
            path,
        ],
    )?;
    let staged = git(cwd, &["diff", "--no-ext-diff", "--staged", "--", path])?;
    let unstaged = git(cwd, &["diff", "--no-ext-diff", "--", path])?;
    Ok([committed, staged, unstaged]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n"))
}

fn get_worktree_diff_blocking(
    worktree_path: String,
    parent_ref: String,
) -> Result<WorktreeDiff, String> {
    if !Path::new(&worktree_path).is_dir() {
        return Err("worktree not found".to_string());
    }
    let _ = git(&worktree_path, &["fetch", "--quiet", "origin", &parent_ref]);
    let upstream = format!("origin/{}", parent_ref);
    let effective_ref = if git(&worktree_path, &["rev-parse", "--verify", &upstream]).is_ok() {
        upstream
    } else {
        parent_ref
    };
    let merge_base = git(&worktree_path, &["merge-base", "HEAD", &effective_ref])?
        .trim()
        .to_string();
    let mut statuses: BTreeMap<String, String> = parse_name_status(&git(
        &worktree_path,
        &["diff", "--name-status", &format!("{}...HEAD", merge_base)],
    )?)
    .into_iter()
    .filter(|(path, _)| {
        !git(
            &worktree_path,
            &["diff", "--quiet", "HEAD", &effective_ref, "--", path],
        )
        .is_ok()
    })
    .collect();
    statuses.extend(parse_status(&git(
        &worktree_path,
        &["status", "--porcelain", "--untracked-files=all"],
    )?));
    statuses.remove("graphify-out");
    let mut files = Vec::with_capacity(statuses.len());
    for (path, status) in statuses {
        let untracked = status == "??";
        let patch = if untracked {
            untracked_patch(&worktree_path, &path)?
        } else {
            file_patch(&worktree_path, &merge_base, &path)?
        };
        let (added, removed) = count_lines(&patch);
        files.push(DiffFile {
            path,
            status: if untracked { "A".into() } else { status },
            added,
            removed,
            patch,
        });
    }
    Ok(WorktreeDiff { merge_base, files })
}

#[tauri::command]
pub async fn get_worktree_diff(
    worktree_path: String,
    parent_ref: String,
) -> Result<WorktreeDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        get_worktree_diff_blocking(worktree_path, parent_ref)
    })
    .await
    .map_err(|e| format!("Diff worker failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_renamed_status_path() {
        assert_eq!(
            parse_status("R  old.rs -> new.rs\n?? note.md\n"),
            vec![
                ("new.rs".into(), "R".into()),
                ("note.md".into(), "??".into())
            ]
        );
    }

    #[test]
    fn counts_only_changed_lines() {
        assert_eq!(
            count_lines("--- a/x\n+++ b/x\n-old\n+new\n context\n"),
            (1, 1)
        );
    }

    #[test]
    fn parses_committed_name_status() {
        assert_eq!(
            parse_name_status("M\tsrc/a.rs\nR100\told.rs\tnew.rs\n"),
            vec![
                ("src/a.rs".into(), "M".into()),
                ("new.rs".into(), "R100".into())
            ]
        );
    }

    #[test]
    fn hides_squash_merged_committed_files() {
        let dir = std::env::temp_dir().join(format!(
            "crc-diff-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| git(dir.to_str().unwrap(), args).unwrap();
        run(&["init", "-q"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        std::fs::write(dir.join("file.txt"), "base\n").unwrap();
        run(&["add", "file.txt"]);
        run(&["commit", "-qm", "base"]);
        run(&["branch", "-M", "main"]);
        run(&["checkout", "-qb", "feature"]);
        std::fs::write(dir.join("file.txt"), "feature\n").unwrap();
        run(&["add", "file.txt"]);
        run(&["commit", "-qm", "feature"]);
        run(&["checkout", "-q", "main"]);
        run(&["merge", "--squash", "feature"]);
        run(&["commit", "-qm", "squash"]);
        run(&["update-ref", "refs/remotes/origin/main", "main"]);
        run(&["checkout", "-q", "feature"]);

        let diff = get_worktree_diff_blocking(
            dir.to_string_lossy().to_string(),
            "main".into(),
        )
        .unwrap();
        assert!(diff.files.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
