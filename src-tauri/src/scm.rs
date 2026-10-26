use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Accounts `gh` is signed in to on github.com, from `gh auth status`
/// ("Logged in to github.com account NAME" or, on older gh, "as NAME").
pub fn parse_gh_accounts(status: &str) -> Vec<String> {
    let mut accounts = Vec::new();
    for line in status.lines() {
        let Some(rest) = line.split("Logged in to github.com").nth(1) else {
            continue;
        };
        let rest = rest.trim_start();
        let rest = rest
            .strip_prefix("account ")
            .or_else(|| rest.strip_prefix("as "))
            .unwrap_or("");
        let name: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect();
        if !name.is_empty() && !accounts.contains(&name) {
            accounts.push(name);
        }
    }
    accounts
}

pub fn github_accounts() -> Result<Vec<String>, String> {
    let out = Command::new("gh")
        .args(["auth", "status", "--hostname", "github.com"])
        .env("GH_PROMPT_DISABLED", "1")
        .output()
        .map_err(|_| "GitHub CLI (gh) is not installed".to_string())?;
    // gh prints status on stdout (new) or stderr (old).
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(parse_gh_accounts(&text))
}

#[tauri::command]
pub async fn scm_github_accounts() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(github_accounts)
        .await
        .map_err(|e| e.to_string())?
}

pub fn valid_github_account(account: &str) -> bool {
    !account.is_empty()
        && account.len() <= 39
        && account
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Repository-local helper key. Its first, empty value drops inherited helpers
/// (osxkeychain, a global gh) so only the pinned account answers for github.com.
const GITHUB_CREDENTIAL_HELPER: &str = "credential.https://github.com.helper";

/// Shell helper git runs for github.com: hands out `account`'s gh token. gh is
/// referenced by absolute path so GUI git clients without Homebrew's PATH work.
fn github_credential_helper(gh: &str, account: &str) -> String {
    format!(
        "!f() {{ test \"$1\" = get || exit 0; echo username={account}; \
         echo \"password=$('{gh}' auth token --hostname github.com --user {account})\"; }}; f"
    )
}

fn gh_executable() -> String {
    Command::new("/bin/sh")
        .args(["-c", "command -v gh"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|path| path.starts_with('/') && !path.contains('\''))
        .unwrap_or_else(|| "gh".into())
}

/// The gh account the repository's git credentials are pinned to, if any.
/// Also recognizes hand-written helpers of the same `gh auth token --user` shape.
pub fn pinned_github_account(repo: &Path) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["config", "--get-all", GITHUB_CREDENTIAL_HELPER])
        .output()
        .ok()
        .filter(|out| out.status.success())?;
    let helper = String::from_utf8_lossy(&out.stdout)
        .lines()
        .last()?
        .to_string();
    let account: String = helper
        .split("--user ")
        .nth(1)?
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    valid_github_account(&account).then_some(account)
}

/// Pinned account for a registered repository or chat worktree.
#[tauri::command]
pub async fn scm_pinned_github_account(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let requested = Path::new(&path).canonicalize().map_err(|e| e.to_string())?;
        crate::projects::ensure_path_allowed(&requested)?;
        Ok(pinned_github_account(&requested))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Pin (or with `None`, unpin) the repository's github.com git credentials to
/// a gh account. Lives in the shared `.git/config`, so every chat worktree,
/// agent and terminal git command in this repository uses it.
pub fn pin_github_account(repo: &Path, account: Option<&str>) -> Result<(), String> {
    let config = |args: &[&str]| {
        Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["config", "--local"])
            .args(args)
            .output()
            .map_err(|e| e.to_string())
    };
    let cleared = config(&["--unset-all", GITHUB_CREDENTIAL_HELPER])?;
    // Exit 5: nothing was set.
    if !cleared.status.success() && cleared.status.code() != Some(5) {
        return Err(String::from_utf8_lossy(&cleared.stderr).trim().to_string());
    }
    let Some(account) = account else {
        return Ok(());
    };
    if !valid_github_account(account) {
        return Err("Choose a valid GitHub account".into());
    }
    let helper = github_credential_helper(&gh_executable(), account);
    for value in ["", helper.as_str()] {
        let out = config(&["--add", GITHUB_CREDENTIAL_HELPER, value])?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn scm_pull_request(
    repository_path: String,
    account: String,
    title: Option<String>,
    body: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = repository(&repository_path)?;
        if account.is_empty() || account.len() > 39 || !account.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err("Choose a valid GitHub account".into());
        }
        let token = Command::new("gh").args(["auth", "token", "--hostname", "github.com", "--user", &account]).output().map_err(|e| e.to_string())?;
        if !token.status.success() { return Err("Could not load GitHub account token; sign in with gh first".into()); }
        let token = String::from_utf8(token.stdout).map_err(|_| "Invalid token encoding")?;
        let mut cmd = Command::new("gh");
        cmd.current_dir(repo).env("GH_TOKEN", token.trim()).env("GH_HOST", "github.com").env("GH_PROMPT_DISABLED", "1");
        if let Some(title) = title {
            if title.trim().is_empty() || title.len() > 256 { return Err("PR title must contain 1–256 bytes".into()); }
            let body = body.unwrap_or_default();
            if body.len() > 65_536 { return Err("PR body too large".into()); }
            // Explicit head prevents gh from offering to push an unpublished branch.
            let branch = run(cmd.get_current_dir().unwrap(), &["branch", "--show-current"])?;
            if branch.trim().is_empty() { return Err("PR creation requires a branch".into()); }
            cmd.args(["pr", "create", "--head", branch.trim(), "--title", &title, "--body", &body]);
        } else {
            cmd.args(["pr", "view", "--json", "url,title,state,statusCheckRollup"]);
        }
        let out = cmd.output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            let error = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if error.contains("must first push") || error.contains("No commits between") || error.contains("not found on remote") {
                return Err(format!("Push the branch first (Push in Source Control), then create the PR. gh: {error}"));
            }
            if error.contains("no pull requests found") {
                return Err("No pull request for this branch yet.".into());
            }
            return Err(error);
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }).await.map_err(|e| e.to_string())?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScmFile {
    pub path: String,
    pub index_status: String,
    pub worktree_status: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScmStatus {
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<ScmFile>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    pub hash: String,
    pub short_hash: String,
    pub parents: Vec<String>,
    pub lane: usize,
    pub subject: String,
    pub author: String,
    pub relative_time: String,
    pub refs: Vec<String>,
}

fn repository(path: &str) -> Result<PathBuf, String> {
    let requested = Path::new(path).canonicalize().map_err(|e| e.to_string())?;
    crate::projects::ensure_path_allowed(&requested)?;
    let root = crate::projects::verified_repository_root(&requested)?;
    if root != requested || !root.join(".git").is_file() {
        return Err("SCM path must be a registered chat worktree root".into());
    }
    Ok(root)
}

fn run(path: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn status(path: &Path) -> Result<ScmStatus, String> {
    let raw = run(
        path,
        &[
            "status",
            "--porcelain=v1",
            "--branch",
            "--untracked-files=all",
        ],
    )?;
    let mut lines = raw.lines();
    let header = lines.next().unwrap_or("## HEAD").trim_start_matches("## ");
    let (tracking, counts) = header
        .split_once(" [")
        .map(|(a, b)| (a, b.trim_end_matches(']')))
        .unwrap_or((header, ""));
    let (branch, upstream) = tracking
        .split_once("...")
        .map(|(a, b)| (a.to_string(), Some(b.to_string())))
        .unwrap_or((tracking.to_string(), None));
    let mut ahead = 0;
    let mut behind = 0;
    for count in counts.split(", ") {
        if let Some(n) = count.strip_prefix("ahead ") {
            ahead = n.parse().unwrap_or(0);
        }
        if let Some(n) = count.strip_prefix("behind ") {
            behind = n.parse().unwrap_or(0);
        }
    }
    let files = lines
        .filter_map(|line| {
            let bytes = line.as_bytes();
            if bytes.len() < 4 {
                return None;
            }
            let path = line[3..].split(" -> ").last()?.to_string();
            Some(ScmFile {
                path,
                index_status: (bytes[0] as char).to_string(),
                worktree_status: (bytes[1] as char).to_string(),
            })
        })
        .collect();
    Ok(ScmStatus {
        branch,
        upstream,
        ahead,
        behind,
        files,
    })
}

fn mutate_paths(path: &Path, action: &str, paths: &[String]) -> Result<(), String> {
    if paths.iter().any(|p| {
        p.is_empty() || Path::new(p).is_absolute() || p.split('/').any(|part| part == "..")
    }) {
        return Err("invalid repository-relative path".into());
    }
    match action {
        "stage" => {
            let mut c = Command::new("git");
            c.arg("-C").arg(path).args(["add", "--"]);
            c.args(paths);
            command(c)?;
        }
        "unstage" => {
            let mut c = Command::new("git");
            c.arg("-C").arg(path).args(["restore", "--staged", "--"]);
            c.args(paths);
            command(c)?;
        }
        "discard" => {
            let current = status(path)?;
            let tracked = paths
                .iter()
                .filter(|p| {
                    current
                        .files
                        .iter()
                        .any(|f| &f.path == *p && f.worktree_status != "?")
                })
                .collect::<Vec<_>>();
            if !tracked.is_empty() {
                let mut c = Command::new("git");
                c.arg("-C").arg(path).args(["restore", "--worktree", "--"]);
                c.args(tracked);
                command(c)?;
            }
            for p in paths.iter().filter(|p| {
                current
                    .files
                    .iter()
                    .any(|f| &f.path == *p && f.worktree_status == "?")
            }) {
                let target = path.join(p);
                if target.is_dir() {
                    std::fs::remove_dir_all(target).map_err(|e| e.to_string())?
                } else if target.exists() {
                    std::fs::remove_file(target).map_err(|e| e.to_string())?
                }
            }
        }
        _ => return Err("unsupported SCM path action".into()),
    }
    Ok(())
}
fn command(mut command: Command) -> Result<(), String> {
    let out = command.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[tauri::command]
pub async fn scm_status(repository_path: String) -> Result<ScmStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status(&repository(&repository_path)?))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn scm_paths(
    repository_path: String,
    action: String,
    paths: Vec<String>,
) -> Result<ScmStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = repository(&repository_path)?;
        mutate_paths(&p, &action, &paths)?;
        status(&p)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn scm_all(repository_path: String, action: String) -> Result<ScmStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = repository(&repository_path)?;
        match action.as_str() {
            "stage" => {
                run(&p, &["add", "--all"])?;
            }
            "unstage" => {
                run(&p, &["restore", "--staged", "."])?;
            }
            _ => return Err("unsupported SCM all action".into()),
        };
        status(&p)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn scm_commit(repository_path: String, message: String) -> Result<ScmStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if message.trim().is_empty() {
            return Err("commit message is required".into());
        }
        let p = repository(&repository_path)?;
        run(&p, &["commit", "-m", message.trim()])?;
        status(&p)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn scm_remote(repository_path: String, action: String) -> Result<ScmStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = repository(&repository_path)?;
        match action.as_str() {
            "fetch" => run(&p, &["fetch", "--prune"]),
            "pull" => run(&p, &["pull", "--ff-only"]),
            "push" => run(&p, &["push"]),
            "sync" => {
                run(&p, &["pull", "--ff-only"])?;
                run(&p, &["push"])
            }
            _ => Err("unsupported remote action".into()),
        }?;
        status(&p)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn scm_branches(repository_path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = repository(&repository_path)?;
        Ok(run(
            &p,
            &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        )?
        .lines()
        .map(str::to_string)
        .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn scm_checkout(
    repository_path: String,
    branch: String,
    create: bool,
) -> Result<ScmStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if branch.trim().is_empty() || branch.starts_with('-') {
            return Err("invalid branch name".into());
        }
        let p = repository(&repository_path)?;
        if create {
            run(&p, &["check-ref-format", "--branch", &branch])?;
            run(&p, &["switch", "-c", &branch])?;
        } else {
            run(&p, &["switch", &branch])?;
        }
        status(&p)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn scm_graph(
    repository_path: String,
    limit: Option<usize>,
) -> Result<Vec<GraphCommit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = repository(&repository_path)?;
        let n = limit.unwrap_or(80).clamp(1, 200).to_string();
        let raw = run(
            &p,
            &[
                "log",
                "--all",
                "--date-order",
                "--format=%H%x1f%h%x1f%P%x1f%s%x1f%an%x1f%ar%x1f%D",
                "-n",
                &n,
            ],
        )?;
        let mut lanes: Vec<String> = Vec::new();
        Ok(raw
            .lines()
            .filter_map(|line| {
                let f = line.split('\x1f').collect::<Vec<_>>();
                if f.len() != 7 {
                    return None;
                }
                let hash = f[0].to_string();
                let lane = lanes.iter().position(|h| h == &hash).unwrap_or_else(|| {
                    lanes.push(hash.clone());
                    lanes.len() - 1
                });
                let parents = f[2]
                    .split_whitespace()
                    .map(str::to_string)
                    .collect::<Vec<_>>();
                lanes.remove(lane);
                for parent in parents.iter().rev() {
                    if !lanes.contains(parent) {
                        lanes.insert(lane, parent.clone())
                    }
                }
                Some(GraphCommit {
                    hash,
                    short_hash: f[1].into(),
                    parents,
                    lane,
                    subject: f[3].into(),
                    author: f[4].into(),
                    relative_time: f[5].into(),
                    refs: f[6]
                        .split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .collect(),
                })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn scm_commit_details(repository_path: String, hash: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if hash.len() != 40 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid commit hash".into());
        }
        let p = repository(&repository_path)?;
        run(
            &p,
            &[
                "show",
                "--stat",
                "--format=fuller",
                "--no-renames",
                "--no-color",
                &hash,
            ],
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn scm_commit_files(
    repository_path: String,
    hash: String,
) -> Result<Vec<crate::diff::DiffFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if hash.len() != 40 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid commit hash".into());
        }
        let p = repository(&repository_path)?;
        let names = run(
            &p,
            &[
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--name-status",
                "-r",
                "--no-renames",
                &hash,
            ],
        )?;
        names
            .lines()
            .filter_map(|line| {
                let (status, path) = line.split_once('\t')?;
                Some((status.to_string(), path.to_string()))
            })
            .map(|(status, file)| {
                let patch = run(
                    &p,
                    &[
                        "show",
                        "--format=",
                        "--no-ext-diff",
                        "--no-renames",
                        &hash,
                        "--",
                        &file,
                    ],
                )?;
                let added = patch
                    .lines()
                    .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
                    .count() as u32;
                let removed = patch
                    .lines()
                    .filter(|line| line.starts_with('-') && !line.starts_with("---"))
                    .count() as u32;
                Ok(crate::diff::DiffFile {
                    repository: String::new(),
                    path: file,
                    status,
                    added,
                    removed,
                    patch,
                })
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo(tag: &str) -> PathBuf {
        let repo = std::env::temp_dir().join(format!("crc-scm-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo);
        std::fs::create_dir_all(&repo).unwrap();
        assert!(Command::new("git")
            .arg("init")
            .arg(&repo)
            .output()
            .unwrap()
            .status
            .success());
        repo
    }

    fn helpers(repo: &Path) -> Vec<String> {
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["config", "--get-all", GITHUB_CREDENTIAL_HELPER])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn pinning_replaces_and_clears_the_github_helper() {
        let repo = temp_repo("pin");
        assert_eq!(pinned_github_account(&repo), None);
        pin_github_account(&repo, Some("rdev-nashta")).unwrap();
        pin_github_account(&repo, Some("rfkokt")).unwrap();
        let values = helpers(&repo);
        assert_eq!(values.len(), 2);
        assert_eq!(values[0], "");
        assert_eq!(pinned_github_account(&repo).as_deref(), Some("rfkokt"));
        assert!(pin_github_account(&repo, Some("bad name")).is_err());
        pin_github_account(&repo, None).unwrap();
        assert!(helpers(&repo).is_empty());
        pin_github_account(&repo, None).unwrap();
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn recognizes_hand_written_gh_helper() {
        let repo = temp_repo("manual");
        let manual =
            r#"!f() { echo username=rfkokt; echo "password=$(gh auth token --user rfkokt)"; }; f"#;
        for value in ["", manual] {
            Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(["config", "--add", GITHUB_CREDENTIAL_HELPER, value])
                .output()
                .unwrap();
        }
        assert_eq!(pinned_github_account(&repo).as_deref(), Some("rfkokt"));
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn pinned_helper_hands_git_the_accounts_token() {
        let repo = temp_repo("fill");
        let fake_gh = repo.join("fake gh");
        std::fs::write(&fake_gh, "#!/bin/sh\necho \"token-for-$6\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake_gh, std::fs::Permissions::from_mode(0o755)).unwrap();
        let helper = github_credential_helper(fake_gh.to_str().unwrap(), "rfkokt");
        for value in ["", helper.as_str()] {
            Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(["config", "--add", GITHUB_CREDENTIAL_HELPER, value])
                .output()
                .unwrap();
        }
        let mut fill = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["credential", "fill"])
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        fill.stdin
            .take()
            .unwrap()
            .write_all(b"protocol=https\nhost=github.com\n\n")
            .unwrap();
        let out = String::from_utf8(fill.wait_with_output().unwrap().stdout).unwrap();
        assert!(out.contains("username=rfkokt\n"), "{out}");
        assert!(out.contains("password=token-for-rfkokt\n"), "{out}");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn parses_gh_auth_status_accounts() {
        let status = "github.com\n  ✓ Logged in to github.com account rfkokt (keyring)\n  - Active account: true\n  ✓ Logged in to github.com account rdev-nashta (keyring)\n  - Active account: false\n";
        assert_eq!(parse_gh_accounts(status), vec!["rfkokt", "rdev-nashta"]);
        assert_eq!(
            parse_gh_accounts("  ✓ Logged in to github.com as octo-cat (oauth_token)"),
            vec!["octo-cat"]
        );
        assert!(parse_gh_accounts("You are not logged into any GitHub hosts.").is_empty());
    }
    #[test]
    fn parses_status_groups() {
        let dir = std::env::temp_dir().join(format!("crc-scm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        run(&dir, &["init", "-q"]).unwrap();
        run(&dir, &["config", "user.email", "x@y.z"]).unwrap();
        run(&dir, &["config", "user.name", "X"]).unwrap();
        std::fs::write(dir.join("a"), "a").unwrap();
        run(&dir, &["add", "a"]).unwrap();
        run(&dir, &["commit", "-qm", "init"]).unwrap();
        std::fs::write(dir.join("a"), "b").unwrap();
        std::fs::write(dir.join("b"), "b").unwrap();
        let s = status(&dir).unwrap();
        assert!(s
            .files
            .iter()
            .any(|f| f.path == "a" && f.worktree_status == "M"));
        assert!(s
            .files
            .iter()
            .any(|f| f.path == "b" && f.worktree_status == "?"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
