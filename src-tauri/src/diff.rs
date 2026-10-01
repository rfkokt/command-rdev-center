use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Serialize)]
pub struct DiffFile {
    #[serde(default)]
    pub repository: String,
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

/// Validate a caller-supplied unified-diff patch before it is handed to
/// `git apply`. The patch must be a well-formed unified diff containing only
/// header lines (`diff --git`, `index`, `---`, `+++`, `@@`), body lines
/// (context ` `, additions `+`, removals `-`) and the `\ No newline at end
/// of file` marker. Anything else (empty patch, garbage, shell metachar
/// tricks smuggled into headers) is rejected before git ever sees it.
/// `git apply` itself is invoked via argv (no shell) with `-C <worktree>`
/// and its default `--no-unsafe-paths` behavior, so absolute or `..`-escaping
/// paths in the patch are refused by git as a second layer of defense.
fn validate_hunks_patch(patch: &str) -> Result<(), String> {
    let mut lines = patch.lines().peekable();
    let mut seen_diff_git = false;
    let mut seen_hunk = false;
    let mut any_line = false;
    while let Some(line) = lines.next() {
        if line.is_empty() {
            // Tolerate a single trailing newline at the end of the patch.
            if lines.peek().is_none() {
                break;
            }
            return Err("patch contains a blank line".to_string());
        }
        any_line = true;
        if line.starts_with("diff --git ") {
            seen_diff_git = true;
        } else if line.starts_with("index ") || line.starts_with("--- ") || line.starts_with("+++ ")
        {
            if !seen_diff_git {
                return Err("patch header out of order".to_string());
            }
        } else if line.starts_with("@@ ") {
            if !seen_diff_git {
                return Err("patch hunk before diff header".to_string());
            }
            seen_hunk = true;
        } else if line.starts_with(' ')
            || line.starts_with('+')
            || line.starts_with('-')
            || line.starts_with('\\')
        {
            if !seen_hunk {
                return Err("patch body line outside a hunk".to_string());
            }
        } else {
            return Err(format!(
                "patch contains an unexpected line: {}",
                line.chars().take(48).collect::<String>()
            ));
        }
    }
    if !any_line {
        return Err("patch is empty".to_string());
    }
    if !seen_diff_git {
        return Err("patch is missing a diff --git header".to_string());
    }
    if !seen_hunk {
        return Err("patch contains no hunks".to_string());
    }
    Ok(())
}

fn run_git_apply(worktree_path: &str, hunks_patch: &str, reverse: bool) -> Result<(), String> {
    let patch_file = std::env::temp_dir().join(format!(
        "crc-hunks-{}-{}.patch",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::write(&patch_file, hunks_patch).map_err(|e| e.to_string())?;
    let mut args: Vec<&str> = vec!["apply", "--whitespace=nowarn"];
    if reverse {
        args.push("-R");
    }
    // `git -C <worktree> apply <tmpfile>`: the patch file lives outside the
    // worktree, so it cannot collide with (or be confused for) a repo path.
    let result = Command::new("git")
        .arg("-C")
        .arg(worktree_path)
        .args(&args)
        .arg(&patch_file)
        .output()
        .map_err(|error| error.to_string())
        .and_then(|output| {
            if output.status.success() {
                Ok(())
            } else {
                Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
            }
        });
    let _ = std::fs::remove_file(&patch_file);
    result
}

fn apply_hunks_blocking(
    worktree_path: String,
    hunks_patch: String,
    reverse: bool,
) -> Result<(), String> {
    crate::projects::ensure_path_allowed(Path::new(&worktree_path))?;
    if !Path::new(&worktree_path).is_dir() {
        return Err("worktree not found".to_string());
    }
    validate_hunks_patch(&hunks_patch)?;
    run_git_apply(&worktree_path, &hunks_patch, reverse)
}

/// Frontend-controlled git ref used with `git fetch` / `rev-parse` / `merge-base`.
/// The value is passed as a argv element (no shell), so the main hazard is
/// leading-dash flag injection (e.g. `--upload-pack=...` executing a command
/// via `git fetch`). Two-dot `A..B` / three-dot `A...B` ranges are legitimate
/// git syntax used by the merge-base logic, so dots stay allowed — but the
/// value must not start with `-` and must contain no whitespace, control
/// characters, or shell metacharacters.
fn valid_parent_ref(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
}

fn get_worktree_diff_blocking(
    worktree_path: String,
    parent_ref: String,
) -> Result<WorktreeDiff, String> {
    if !valid_parent_ref(&parent_ref) {
        return Err("invalid parent_ref".to_string());
    }
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
            repository: String::new(),
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
pub async fn get_workspace_diff(
    repositories: Vec<(String, String, String)>,
) -> Result<WorktreeDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::new();
        for (name, path, parent_ref) in repositories {
            crate::projects::ensure_path_allowed(Path::new(&path))?;
            let diff = get_worktree_diff_blocking(path, parent_ref)?;
            files.extend(diff.files.into_iter().map(|mut file| {
                file.repository = name.clone();
                file
            }));
        }
        Ok(WorktreeDiff {
            merge_base: String::new(),
            files,
        })
    })
    .await
    .map_err(|error| format!("Workspace diff worker failed: {error}"))?
}

#[tauri::command]
pub async fn get_worktree_diff(
    worktree_path: String,
    parent_ref: String,
) -> Result<WorktreeDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::projects::ensure_path_allowed(Path::new(&worktree_path))?;
        get_worktree_diff_blocking(worktree_path, parent_ref)
    })
    .await
    .map_err(|e| format!("Diff worker failed: {e}"))?
}

/// Reverse-apply a caller-supplied unified-diff patch (the rejected hunks)
/// against the worktree, discarding those hunks from the working tree.
/// The patch is validated with [`validate_hunks_patch`] before git runs.
#[tauri::command]
pub async fn reject_hunks(worktree_path: String, hunks_patch: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        apply_hunks_blocking(worktree_path, hunks_patch, true)
    })
    .await
    .map_err(|e| format!("Diff worker failed: {e}"))?
}

/// Forward-apply a caller-supplied unified-diff patch (undo of a rejection),
/// restoring previously rejected hunks into the working tree.
#[tauri::command]
pub async fn apply_hunks(worktree_path: String, hunks_patch: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        apply_hunks_blocking(worktree_path, hunks_patch, false)
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
    fn accepts_legitimate_git_refs() {
        for value in [
            "main",
            "origin/main",
            "feature/my-branch_2.0",
            "v1.2.3",
            "HEAD",
            "abc123",
            "abc123...def456", // three-dot range syntax used by merge-base logic
            "abc123..def456",  // two-dot range syntax
        ] {
            assert!(valid_parent_ref(value), "should accept {value}");
        }
    }

    #[test]
    fn rejects_ref_flag_injection_and_metacharacters() {
        for value in [
            "",
            "-main",              // leading dash: parsed as a flag by git
            "--upload-pack=evil", // classic git flag-injection payload
            "main; rm -rf /",
            "main\nfoo",
            "main`id`",
            "main$(id)",
            "main|cat",
            "main && id",
            "main'quote",
            "main\"quote",
            "main\\path",
            "main foo",
            "main~1", // not in the conservative allowlist
        ] {
            assert!(!valid_parent_ref(value), "should reject {value:?}");
        }
    }

    #[test]
    fn validates_well_formed_hunk_patch() {
        // (Built line-by-line: `\` line continuations would strip the
        // leading space of context lines.)
        let patch = [
            "diff --git a/file.txt b/file.txt",
            "index 257cc56..5716ca5 100644",
            "--- a/file.txt",
            "+++ b/file.txt",
            "@@ -1,3 +1,3 @@",
            " base",
            "-old",
            "+new",
            "\\ No newline at end of file",
        ]
        .join("\n")
            + "\n";
        assert!(validate_hunks_patch(&patch).is_ok());
    }

    #[test]
    fn rejects_malformed_hunk_patches() {
        let cases = [
            "",                                                // empty
            "just some text\n",                                // garbage
            "@@ -1,3 +1,3 @@\n-old\n+new\n",                   // hunk before diff header
            "diff --git a/f b/f\n--- a/f\n+++ b/f\n",          // no hunks
            "diff --git a/f b/f\n@@ -1 +1 @@\n? weird\n",      // unexpected line
            "; rm -rf /\n",                                    // shell metachar line
            "diff --git a/f b/f\n\n@@ -1 +1 @@\n-old\n+new\n", // blank line
            "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n",     // missing diff --git
            "diff --git a/f b/f\n-old\n+new\n",                // body outside hunk
        ];
        for patch in cases {
            assert!(
                validate_hunks_patch(patch).is_err(),
                "should reject {patch:?}"
            );
        }
    }

    fn temp_repo() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "crc-hunks-{}",
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
        dir
    }

    #[test]
    fn reject_then_undo_hunk_roundtrip() {
        let dir = temp_repo();
        let cwd = dir.to_str().unwrap().to_string();
        let run = |args: &[&str]| git(&cwd, args).unwrap();
        let base: String = (1..=12)
            .map(|n| format!("line{n}"))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(dir.join("file.txt"), &base).unwrap();
        run(&["add", "file.txt"]);
        run(&["commit", "-qm", "base"]);
        let changed = base
            .replace("line2\n", "LINE2\n")
            .replace("line10\n", "LINE10\n");
        std::fs::write(dir.join("file.txt"), &changed).unwrap();

        // -U1 keeps the two edits in separate hunks.
        let full = git(&cwd, &["diff", "--no-ext-diff", "-U1", "--", "file.txt"]).unwrap();
        let header: Vec<&str> = full.lines().take_while(|l| !l.starts_with("@@")).collect();
        let hunks: Vec<Vec<&str>> = {
            let mut out: Vec<Vec<&str>> = vec![];
            for line in full.lines().skip(header.len()) {
                if line.starts_with("@@") {
                    out.push(vec![]);
                }
                out.last_mut().unwrap().push(line);
            }
            out
        };
        assert_eq!(hunks.len(), 2, "expected two hunks, got:\n{full}");
        let hunk: String = header
            .iter()
            .chain(hunks[0].iter())
            .copied()
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        assert!(validate_hunks_patch(&hunk).is_ok());

        // Reject: reverse-apply the first hunk, discarding "LINE2".
        run_git_apply(&cwd, &hunk, true).unwrap();
        let after_reject = std::fs::read_to_string(dir.join("file.txt")).unwrap();
        assert!(after_reject.contains("line2\n"), "got:\n{after_reject}");
        assert!(after_reject.contains("LINE10\n"), "got:\n{after_reject}");

        // Undo: forward-apply the same patch, restoring "LINE2".
        run_git_apply(&cwd, &hunk, false).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("file.txt")).unwrap(),
            changed
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn apply_hunks_rejects_unregistered_path() {
        let patch = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n";
        let err = apply_hunks_blocking("/tmp/definitely-not-a-project".into(), patch.into(), true)
            .unwrap_err();
        assert!(err.contains("unregistered project path"), "got: {err}");
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

        let diff =
            get_worktree_diff_blocking(dir.to_string_lossy().to_string(), "main".into()).unwrap();
        assert!(diff.files.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
