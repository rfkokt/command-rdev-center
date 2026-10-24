//! Update checks for the agents Kern drives: npm-installed ACP adapters,
//! OpenCode's native binary, Hermes, the pi runtime and pi's own packages.
//!
//! Agents ship their own engines (codex-acp bundles Codex, claude-agent-acp
//! bundles the Claude SDK), so a stale install breaks on new models or
//! settings long before the app itself changes. Kern checks once at startup
//! and either notifies or, with `auto_update`, installs.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::harness::{self, HarnessSpec};

const PI_EXTENSIONS: &str = "pi-extensions";
const CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AgentUpdate {
    /// Harness id, `"pi"` or `"pi-extensions"`.
    pub id: String,
    pub label: String,
    pub installed: Option<String>,
    pub latest: Option<String>,
    pub available: bool,
    /// The installed package is deprecated or superseded; updating replaces it.
    pub notice: Option<String>,
    /// Extra context, e.g. which pi packages are behind.
    pub detail: Option<String>,
}

static CACHE: Mutex<Option<(Instant, Vec<AgentUpdate>)>> = Mutex::new(None);

/// True when `latest` is a strictly higher dotted version than `installed`.
/// Pre-release suffixes and a leading `v` are ignored.
fn newer(latest: &str, installed: &str) -> bool {
    fn parts(version: &str) -> Vec<u64> {
        version
            .trim()
            .trim_start_matches('v')
            .split(['-', '+', ' '])
            .next()
            .unwrap_or("")
            .split('.')
            .map(|part| part.parse().unwrap_or(0))
            .collect()
    }
    let (a, b) = (parts(latest), parts(installed));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    false
}

fn run(program: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .env(
            "PATH",
            crate::pi_rpc::search_path(&program.to_string_lossy()),
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .current_dir(
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir),
        )
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Couldn't run {}: {e}", program.display()))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if output.status.success() {
        Ok(text)
    } else {
        let tail: Vec<&str> = text.lines().rev().take(12).collect();
        let tail: Vec<&str> = tail.into_iter().rev().collect();
        Err(format!(
            "`{} {}` failed:\n{}",
            program.display(),
            args.join(" "),
            tail.join("\n")
        ))
    }
}

/// `GET registry.npmjs.org/<pkg>/latest` (includes `deprecated` when set).
fn npm_latest(package: &str) -> Option<Value> {
    let url = format!(
        "https://registry.npmjs.org/{}/latest",
        package.replacen('/', "%2F", 1)
    );
    let output = Command::new("curl")
        .args(["-fsSL", "--max-time", "6", &url])
        .output()
        .ok()?;
    serde_json::from_slice(&output.stdout).ok()
}

fn npm_latest_version(package: &str) -> (Option<String>, Option<String>) {
    let Some(value) = npm_latest(package) else {
        return (None, None);
    };
    let version = value
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_string);
    let deprecated = value
        .get("deprecated")
        .and_then(Value::as_str)
        .map(str::to_string);
    (version, deprecated)
}

/// npm package that owns an installed bin: follow the symlink into
/// `.../node_modules/<pkg>/...` and read the nearest `package.json`.
/// Returns `(name, version, npm prefix)`.
fn npm_package_of(binary: &Path) -> Option<(String, String, PathBuf)> {
    let real = std::fs::canonicalize(binary).ok()?;
    let text = real.to_string_lossy();
    let marker = "/lib/node_modules/";
    let prefix = PathBuf::from(&text[..text.find(marker)?]);
    let mut dir = real.parent();
    while let Some(current) = dir {
        if current == prefix {
            break;
        }
        if let Ok(raw) = std::fs::read_to_string(current.join("package.json")) {
            if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                if let (Some(name), Some(version)) = (
                    value.get("name").and_then(Value::as_str),
                    value.get("version").and_then(Value::as_str),
                ) {
                    return Some((name.to_string(), version.to_string(), prefix));
                }
            }
        }
        dir = current.parent();
    }
    None
}

fn npm_for_prefix(prefix: &Path) -> Option<PathBuf> {
    let local = prefix.join("bin/npm");
    if local.is_file() {
        Some(local)
    } else {
        harness::resolve_binary("npm")
    }
}

// ------------------------------------------------------------------ checks

fn check_harness(spec: &HarnessSpec) -> Option<AgentUpdate> {
    let binary = harness::resolve_spec(spec)?;
    let mut update = AgentUpdate {
        id: spec.id.clone(),
        label: spec.label.clone(),
        installed: None,
        latest: None,
        available: false,
        notice: None,
        detail: None,
    };
    if let (Some(wanted), Some((name, version, _))) =
        (spec.npm_packages.first(), npm_package_of(&binary))
    {
        let (latest, deprecated) = npm_latest_version(wanted);
        update.installed = Some(version.clone());
        update.latest = latest.clone();
        if &name != wanted {
            update.notice = Some(format!("{name} is superseded by {wanted}"));
            update.available = true;
        } else {
            update.available = latest.as_deref().is_some_and(|l| newer(l, &version));
            update.notice = deprecated.map(|message| format!("{name} is deprecated: {message}"));
        }
        return Some(update);
    }
    match spec.id.as_str() {
        // Native installer (~/.opencode/bin); upgrades itself.
        "opencode" => {
            let installed = run(&binary, &["--version"]).ok()?.trim().to_string();
            let (latest, _) = npm_latest_version("opencode-ai");
            update.available = latest.as_deref().is_some_and(|l| newer(l, &installed));
            update.installed = Some(installed);
            update.latest = latest;
            Some(update)
        }
        // git checkout; `hermes update --check` fetches and compares.
        "hermes" => {
            let version = run(&binary, &["--version"]).ok()?;
            update.installed = version
                .split_whitespace()
                .find(|word| {
                    word.starts_with('v') && word[1..].starts_with(|c: char| c.is_ascii_digit())
                })
                .map(str::to_string);
            let check = run(&binary, &["update", "--check"]).ok()?;
            update.available = check.contains("Update available");
            if update.available {
                update.detail = check
                    .lines()
                    .find(|line| line.contains("Update available"))
                    .map(|line| {
                        line.trim_start_matches(|c: char| !c.is_alphanumeric())
                            .trim()
                            .to_string()
                    });
            }
            Some(update)
        }
        _ => None,
    }
}

fn check_pi() -> Option<AgentUpdate> {
    let status = crate::pi_rpc::runtime_status(true).ok()?;
    let installed = status.installed_version?;
    let available = status
        .latest_version
        .as_deref()
        .is_some_and(|latest| newer(latest, &installed));
    Some(AgentUpdate {
        id: harness::PI.into(),
        label: "pi".into(),
        installed: Some(installed),
        latest: status.latest_version,
        available,
        notice: None,
        detail: None,
    })
}

fn pi_agent_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".pi/agent"))
}

/// `npm:name[@version]` → `name` when unpinned.
fn unpinned_npm(source: &str) -> Option<&str> {
    let spec = source.strip_prefix("npm:")?;
    match spec.rfind('@') {
        Some(at) if at > 0 => None,
        _ => Some(spec),
    }
}

/// `git:host/owner/repo` (no `@ref` pin) → `host/owner/repo`.
fn unpinned_git(source: &str) -> Option<&str> {
    let spec = source.strip_prefix("git:")?;
    (!spec.contains('@')).then_some(spec)
}

fn package_outdated(agent_dir: &Path, source: &str) -> bool {
    if let Some(name) = unpinned_npm(source) {
        let manifest = agent_dir
            .join("npm/node_modules")
            .join(name)
            .join("package.json");
        let installed = std::fs::read_to_string(manifest)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|value| value.get("version")?.as_str().map(str::to_string));
        let (latest, _) = npm_latest_version(name);
        return matches!((latest, installed), (Some(l), Some(i)) if newer(&l, &i));
    }
    if let Some(repo) = unpinned_git(source) {
        let dir = agent_dir.join("git").join(repo);
        let Some(git) = harness::resolve_binary("git") else {
            return false;
        };
        let dir_arg = dir.to_string_lossy();
        let local = run(&git, &["-C", &dir_arg, "rev-parse", "HEAD"]);
        let remote = run(&git, &["-C", &dir_arg, "ls-remote", "origin", "HEAD"]);
        return match (local, remote) {
            (Ok(local), Ok(remote)) => remote
                .split_whitespace()
                .next()
                .is_some_and(|head| head != local.trim()),
            _ => false,
        };
    }
    false
}

fn check_pi_extensions() -> Option<AgentUpdate> {
    let agent_dir = pi_agent_dir()?;
    let raw = std::fs::read_to_string(agent_dir.join("settings.json")).ok()?;
    let settings: Value = serde_json::from_str(&raw).ok()?;
    let sources: Vec<String> = settings
        .get("packages")?
        .as_array()?
        .iter()
        .filter_map(|item| {
            // Entries are a source string or `{ "source": ... }`.
            item.as_str()
                .or_else(|| item.get("source").and_then(Value::as_str))
                .map(str::to_string)
        })
        .collect();
    if sources.is_empty() {
        return None;
    }
    let outdated: Vec<String> = std::thread::scope(|scope| {
        let jobs: Vec<_> = sources
            .iter()
            .map(|source| {
                let dir = &agent_dir;
                (source, scope.spawn(move || package_outdated(dir, source)))
            })
            .collect();
        jobs.into_iter()
            .filter_map(|(source, job)| job.join().ok().filter(|o| *o).map(|_| source.clone()))
            .collect()
    });
    Some(AgentUpdate {
        id: PI_EXTENSIONS.into(),
        label: "pi extensions".into(),
        installed: Some(format!("{} packages", sources.len())),
        latest: None,
        available: !outdated.is_empty(),
        notice: None,
        detail: (!outdated.is_empty()).then(|| {
            format!(
                "{} outdated: {}",
                outdated.len(),
                outdated
                    .iter()
                    .map(|source| source
                        .split_once(':')
                        .map_or(source.as_str(), |(_, rest)| rest))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }),
    })
}

fn check_one(id: &str) -> Option<AgentUpdate> {
    match id {
        harness::PI => check_pi(),
        PI_EXTENSIONS => check_pi_extensions(),
        _ => harness::builtin_acp()
            .into_iter()
            .find(|spec| spec.id == id)
            .and_then(|spec| check_harness(&spec)),
    }
}

fn check_all() -> Vec<AgentUpdate> {
    let mut ids: Vec<String> = vec![harness::PI.into(), PI_EXTENSIONS.into()];
    ids.extend(harness::builtin_acp().into_iter().map(|spec| spec.id));
    std::thread::scope(|scope| {
        let jobs: Vec<_> = ids
            .iter()
            .map(|id| scope.spawn(move || check_one(id)))
            .collect();
        jobs.into_iter()
            .filter_map(|job| job.join().ok().flatten())
            .collect()
    })
}

// ----------------------------------------------------------------- updates

fn apply(id: &str) -> Result<(), String> {
    match id {
        harness::PI => crate::pi_rpc::install_pi_via_curl(),
        PI_EXTENSIONS => {
            let status = crate::pi_rpc::runtime_status(false)?;
            let pi = status.path.ok_or("pi is not installed")?;
            run(Path::new(&pi), &["update", "--extensions", "--no-approve"]).map(|_| ())
        }
        _ => {
            let spec = harness::builtin_acp()
                .into_iter()
                .find(|spec| spec.id == id)
                .ok_or_else(|| format!("Unknown agent `{id}`"))?;
            let binary = harness::resolve_spec(&spec)
                .ok_or_else(|| format!("{} is not installed", spec.label))?;
            if let (Some(wanted), Some((name, _, prefix))) =
                (spec.npm_packages.first(), npm_package_of(&binary))
            {
                let npm = npm_for_prefix(&prefix).ok_or("npm was not found")?;
                if &name != wanted {
                    // Same bin name; npm refuses to overwrite another package's bin.
                    run(&npm, &["uninstall", "--global", &name])?;
                }
                run(&npm, &["install", "--global", &format!("{wanted}@latest")])?;
                crate::pi_rpc::forget_login_path();
                return Ok(());
            }
            match spec.id.as_str() {
                "opencode" => run(&binary, &["upgrade"]).map(|_| ()),
                "hermes" => run(&binary, &["update", "--yes"]).map(|_| ()),
                _ => Err(format!("{} can't be updated from Kern", spec.label)),
            }
        }
    }
}

fn cached() -> Option<Vec<AgentUpdate>> {
    let guard = CACHE.lock().ok()?;
    let (at, list) = guard.as_ref()?;
    (at.elapsed() < CACHE_TTL).then(|| list.clone())
}

fn store(list: &[AgentUpdate]) {
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some((Instant::now(), list.to_vec()));
    }
}

/// Installed vs latest for every installed agent. Cached for a few hours;
/// `refresh` forces a new lookup (Settings "Check now").
#[tauri::command]
pub async fn check_agent_updates(refresh: Option<bool>) -> Result<Vec<AgentUpdate>, String> {
    crate::pi_rpc::off_main_thread(move || {
        if !refresh.unwrap_or(false) {
            if let Some(list) = cached() {
                return Ok(list);
            }
        }
        let list = check_all();
        store(&list);
        Ok(list)
    })
    .await
}

/// Update one agent, then re-check it. Runs only from an explicit Update
/// click or with the user's "Auto-install updates" setting on.
#[tauri::command]
pub async fn apply_agent_update(id: String) -> Result<Vec<AgentUpdate>, String> {
    crate::pi_rpc::off_main_thread(move || {
        apply(&id)?;
        let mut list = cached().unwrap_or_default();
        list.retain(|item| item.id != id);
        if let Some(fresh) = check_one(&id) {
            if fresh.available {
                return Err(format!(
                    "{} updated, but a newer version is still reported ({} → {})",
                    fresh.label,
                    fresh.installed.as_deref().unwrap_or("?"),
                    fresh.latest.as_deref().unwrap_or("?")
                ));
            }
            list.push(fresh);
        }
        store(&list);
        Ok(list)
    })
    .await
}

#[tauri::command(async)]
pub fn get_auto_update() -> bool {
    harness::read_settings().auto_update
}

#[tauri::command(async)]
pub fn set_auto_update(enabled: bool) -> Result<(), String> {
    let _serial = crate::config_guard();
    let mut settings = harness::read_settings();
    settings.auto_update = enabled;
    harness::write_settings(&settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_compares_dotted_versions() {
        assert!(newer("2.2.2", "0.16.0"));
        assert!(newer("1.10.0", "1.9.9"));
        assert!(newer("v0.19.0", "v0.18.0"));
        assert!(!newer("1.4.0", "1.4.0"));
        assert!(!newer("1.4.0", "1.5.0-beta.1"));
        assert!(!newer("1.4", "1.4.0"));
    }

    #[test]
    fn pinned_pi_packages_are_skipped() {
        assert_eq!(unpinned_npm("npm:pi-web-access"), Some("pi-web-access"));
        assert_eq!(
            unpinned_npm("npm:@devkade/pi-plan"),
            Some("@devkade/pi-plan")
        );
        assert_eq!(unpinned_npm("npm:@devkade/pi-plan@1.2.0"), None);
        assert_eq!(unpinned_npm("npm:pi-web-access@1.0.0"), None);
        assert_eq!(unpinned_npm("git:github.com/a/b"), None);
        assert_eq!(unpinned_git("git:github.com/a/b"), Some("github.com/a/b"));
        assert_eq!(unpinned_git("git:github.com/a/b@v1"), None);
    }

    #[test]
    fn npm_package_of_reads_the_owning_package() {
        let root = std::env::temp_dir().join(format!("kern-npm-{}", std::process::id()));
        let package = root.join("lib/node_modules/@scope/agent");
        std::fs::create_dir_all(package.join("dist")).unwrap();
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@scope/agent","version":"1.2.3"}"#,
        )
        .unwrap();
        std::fs::write(package.join("dist/index.js"), "").unwrap();
        let bin = root.join("bin/agent");
        let _ = std::fs::remove_file(&bin);
        std::os::unix::fs::symlink(package.join("dist/index.js"), &bin).unwrap();

        let (name, version, prefix) = npm_package_of(&bin).unwrap();
        assert_eq!((name.as_str(), version.as_str()), ("@scope/agent", "1.2.3"));
        assert_eq!(prefix, std::fs::canonicalize(&root).unwrap());
        // Not inside node_modules → not an npm install.
        assert_eq!(npm_package_of(&root.join("lib")), None);
        let _ = std::fs::remove_dir_all(root);
    }
}
