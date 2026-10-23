//! Agent harness registry.
//!
//! A *harness* is the coding-agent program a Chat runs: pi (native RPC, the
//! default) or any ACP-speaking agent (OpenCode, Claude Code, oh-my-pi, Codex,
//! Gemini CLI, Hermes Agent, or a user-defined command). ACP harnesses are bridged to the
//! UI's pi protocol by `acp_bridge` — see ADR-0007.
//!
//! Settings live in `<app config>/harnesses.json`, separate from
//! `crc.config.json`, because that file is rewritten through a typed struct
//! that would drop unknown keys.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const PI: &str = "pi";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HarnessSpec {
    pub id: String,
    pub label: String,
    /// Executable name or absolute path. Ignored for pi (uses `pi_path`).
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub install_hint: String,
    /// Older binary names that also speak the same protocol, tried after
    /// `command` (e.g. the pre-rename Claude Code adapter).
    #[serde(default)]
    pub alternates: Vec<String>,
    /// npm packages that provide this harness. Empty means Kern cannot
    /// install it and only shows `install_hint`.
    #[serde(default)]
    pub npm_packages: Vec<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct HarnessSettings {
    /// Harness for new chats. `None` or `"pi"` = pi.
    pub default: Option<String>,
    /// Extra ACP agents, e.g. `{ "id": "kimi", "label": "Kimi CLI", "command": "kimi", "args": ["--acp"] }`.
    pub custom: Vec<HarnessSpec>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarnessInfo {
    pub id: String,
    pub label: String,
    /// `"native"` (pi RPC) or `"acp"`.
    pub protocol: &'static str,
    pub command: String,
    pub resolved_path: Option<String>,
    pub available: bool,
    pub install_hint: String,
    pub is_default: bool,
    pub custom: bool,
    /// Kern can install it with one click (npm).
    pub installable: bool,
}

fn spec(id: &str, label: &str, command: &str, args: &[&str], install_hint: &str) -> HarnessSpec {
    HarnessSpec {
        id: id.into(),
        label: label.into(),
        command: command.into(),
        args: args.iter().map(|arg| arg.to_string()).collect(),
        install_hint: install_hint.into(),
        alternates: Vec::new(),
        npm_packages: Vec::new(),
    }
}

fn npm(mut spec: HarnessSpec, package: &str) -> HarnessSpec {
    spec.npm_packages = vec![package.into()];
    spec
}

/// Built-in ACP harnesses. Commands and package `bin` names verified against
/// the npm registry (Oct 2026).
pub fn builtin_acp() -> Vec<HarnessSpec> {
    let mut claude = npm(
        spec(
            "claude-code",
            "Claude Code",
            "claude-agent-acp",
            &[],
            "npm i -g @agentclientprotocol/claude-agent-acp. This is the ACP adapter; it uses your Claude Code login or ANTHROPIC_* env.",
        ),
        "@agentclientprotocol/claude-agent-acp",
    );
    // Same adapter before the package moved to @agentclientprotocol.
    claude.alternates = vec!["claude-code-acp".into()];
    vec![
        npm(
            spec("opencode", "OpenCode", "opencode", &["acp"], "npm i -g opencode-ai"),
            "opencode-ai",
        ),
        claude,
        npm(
            spec("oh-my-pi", "oh-my-pi", "omp", &["--mode", "acp"], "npm i -g @oh-my-pi/pi-coding-agent"),
            "@oh-my-pi/pi-coding-agent",
        ),
        npm(
            spec("codex", "Codex", "codex-acp", &[], "npm i -g @zed-industries/codex-acp"),
            "@zed-industries/codex-acp",
        ),
        npm(
            spec("gemini", "Gemini CLI", "gemini", &["--acp"], "npm i -g @google/gemini-cli"),
            "@google/gemini-cli",
        ),
        spec(
            "hermes",
            "Hermes Agent",
            "hermes",
            &["acp"],
            "Install Hermes Agent, then enable ACP: cd ~/.hermes/hermes-agent && python -c \"import pm; pm.sync_venv(['acp'], explicit=True)\" (model setup: hermes acp --setup)",
        ),
    ]
}

/// First binary of the spec found on the search path: `command`, then any
/// older names in `alternates`.
pub fn resolve_spec(spec: &HarnessSpec) -> Option<PathBuf> {
    std::iter::once(&spec.command)
        .chain(spec.alternates.iter())
        .find_map(|command| resolve_binary(command))
}

fn settings_path() -> PathBuf {
    crate::projects::config_path()
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("harnesses.json")
}

pub fn read_settings() -> HarnessSettings {
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_settings(settings: &HarnessSettings) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = path.with_extension("json.tmp");
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&temp, format!("{raw}\n")).map_err(|e| e.to_string())?;
    std::fs::rename(temp, path).map_err(|e| e.to_string())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// All ACP harnesses: built-ins first, then valid custom entries that do not
/// shadow a built-in id.
pub fn all_acp(settings: &HarnessSettings) -> Vec<HarnessSpec> {
    let mut all = builtin_acp();
    for custom in &settings.custom {
        if valid_id(&custom.id)
            && custom.id != PI
            && !custom.command.trim().is_empty()
            && !all.iter().any(|existing| existing.id == custom.id)
        {
            all.push(custom.clone());
        }
    }
    all
}

/// Resolve an executable against the same search path pi spawns use, so GUI
/// launches (minimal PATH) still find npm/bun/brew installs.
pub fn resolve_binary(command: &str) -> Option<PathBuf> {
    let candidate = Path::new(command);
    if candidate.is_absolute() {
        return candidate.is_file().then(|| candidate.to_path_buf());
    }
    if command.contains(std::path::MAIN_SEPARATOR) {
        return None;
    }
    std::env::split_paths(&crate::pi_rpc::search_path(command))
        .map(|dir| dir.join(command))
        .find(|path| path.is_file())
}

/// Which harness a spawn should use. Returns `None` for pi.
///
/// Priority: a saved ACP session (`acp:<harness>:<id>`) always reopens in its
/// own harness; a saved pi session stays on pi; otherwise the explicit
/// request, then the configured default. Deep Research is always pi because it
/// depends on pi's `--tools` allowlist.
pub fn select(
    explicit: Option<&str>,
    session_file: Option<&str>,
    session_id: &str,
    settings: &HarnessSettings,
) -> Result<Option<(HarnessSpec, Option<String>)>, String> {
    if session_id.starts_with("research-") {
        return Ok(None);
    }
    let lookup = |id: &str| {
        all_acp(settings)
            .into_iter()
            .find(|spec| spec.id == id)
            .ok_or_else(|| {
                format!("Unknown agent harness `{id}`. Add it in Settings → Agent harness.")
            })
    };
    if let Some(file) = session_file.filter(|file| !file.is_empty()) {
        if let Some((harness, acp_session)) = crate::acp_bridge::parse_session_file(file) {
            return Ok(Some((lookup(harness)?, Some(acp_session.to_string()))));
        }
        return Ok(None);
    }
    let chosen = explicit
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .or_else(|| settings.default.clone())
        .unwrap_or_else(|| PI.into());
    if chosen == PI {
        return Ok(None);
    }
    Ok(Some((lookup(&chosen)?, None)))
}

fn harness_list() -> Result<Vec<HarnessInfo>, String> {
    let settings = read_settings();
    let default = settings.default.clone().unwrap_or_else(|| PI.into());
    let builtin_ids: Vec<String> = builtin_acp().into_iter().map(|spec| spec.id).collect();
    let pi_path = crate::pi_rpc::configured_pi_path().unwrap_or_else(|_| "pi".into());
    let pi_resolved = resolve_binary(&pi_path);
    let mut out = vec![HarnessInfo {
        id: PI.into(),
        label: "pi".into(),
        protocol: "native",
        command: pi_path,
        available: pi_resolved.is_some(),
        resolved_path: pi_resolved.map(|path| path.to_string_lossy().into_owned()),
        install_hint: "Installed automatically by Kern".into(),
        is_default: default == PI,
        custom: false,
        installable: false,
    }];
    for spec in all_acp(&settings) {
        let resolved = resolve_spec(&spec);
        out.push(HarnessInfo {
            is_default: default == spec.id,
            custom: !builtin_ids.contains(&spec.id),
            installable: !spec.npm_packages.is_empty(),
            id: spec.id,
            label: spec.label,
            protocol: "acp",
            available: resolved.is_some(),
            resolved_path: resolved.map(|path| path.to_string_lossy().into_owned()),
            command: spec.command,
            install_hint: spec.install_hint,
        });
    }
    Ok(out)
}

/// Runs off the main thread: resolving binaries may read the login shell's
/// PATH the first time, which can take a moment.
#[tauri::command]
pub async fn list_harnesses() -> Result<Vec<HarnessInfo>, String> {
    crate::pi_rpc::off_main_thread(harness_list).await
}

/// Install a built-in harness with npm, then return the refreshed list.
/// Only runs from an explicit Install click in Settings, and only for the
/// fixed package names in `builtin_acp`, never user-supplied commands.
#[tauri::command]
pub async fn install_harness(id: String) -> Result<Vec<HarnessInfo>, String> {
    crate::pi_rpc::off_main_thread(move || {
        let spec = builtin_acp()
            .into_iter()
            .find(|spec| spec.id == id)
            .ok_or_else(|| format!("Unknown agent harness `{id}`"))?;
        if spec.npm_packages.is_empty() {
            return Err(format!(
                "{} can't be installed from Kern. {}",
                spec.label, spec.install_hint
            ));
        }
        let npm = resolve_binary("npm").ok_or_else(|| {
            "npm was not found. Install Node.js (nodejs.org or Homebrew), then try again."
                .to_string()
        })?;
        let output = std::process::Command::new(&npm)
            .args(["install", "--global"])
            .args(&spec.npm_packages)
            .env("PATH", crate::pi_rpc::search_path(&npm.to_string_lossy()))
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("Couldn't run npm: {e}"))?;
        if !output.status.success() {
            let log = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            let tail: Vec<&str> = log.lines().rev().take(12).collect();
            let tail: Vec<&str> = tail.into_iter().rev().collect();
            return Err(format!(
                "npm install {} failed:\n{}",
                spec.npm_packages.join(" "),
                tail.join("\n")
            ));
        }
        crate::pi_rpc::forget_login_path();
        let list = harness_list()?;
        if !list.iter().any(|item| item.id == spec.id && item.available) {
            return Err(format!(
                "npm finished, but `{}` is still not on the search path. Check `npm prefix -g` and add its bin folder to your shell PATH.",
                spec.command
            ));
        }
        Ok(list)
    })
    .await
}

#[tauri::command]
pub fn set_default_harness(id: String) -> Result<(), String> {
    let mut settings = read_settings();
    if id != PI && !all_acp(&settings).iter().any(|spec| spec.id == id) {
        return Err(format!("Unknown agent harness `{id}`"));
    }
    settings.default = (id != PI).then_some(id);
    write_settings(&settings)
}

#[tauri::command]
pub fn save_custom_harness(harness: HarnessSpec) -> Result<(), String> {
    if !valid_id(&harness.id) || harness.id == PI {
        return Err("Harness id must be lowercase letters, digits or dashes".into());
    }
    if builtin_acp().iter().any(|spec| spec.id == harness.id) {
        return Err(format!("`{}` is a built-in harness", harness.id));
    }
    if harness.command.trim().is_empty() {
        return Err("Harness command is required".into());
    }
    let mut settings = read_settings();
    settings.custom.retain(|existing| existing.id != harness.id);
    settings.custom.push(harness);
    write_settings(&settings)
}

#[tauri::command]
pub fn delete_custom_harness(id: String) -> Result<(), String> {
    let mut settings = read_settings();
    settings.custom.retain(|existing| existing.id != id);
    if settings.default.as_deref() == Some(id.as_str()) {
        settings.default = None;
    }
    write_settings(&settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(default: Option<&str>) -> HarnessSettings {
        HarnessSettings {
            default: default.map(str::to_string),
            custom: vec![spec("kimi", "Kimi", "kimi", &["--acp"], "")],
        }
    }

    fn picked(result: Option<(HarnessSpec, Option<String>)>) -> Option<(String, Option<String>)> {
        result.map(|(spec, resume)| (spec.id, resume))
    }

    #[test]
    fn default_is_pi() {
        assert_eq!(
            picked(select(None, None, "chat-1", &HarnessSettings::default()).unwrap()),
            None
        );
    }

    #[test]
    fn explicit_and_default_choose_acp() {
        let s = settings(Some("opencode"));
        assert_eq!(
            picked(select(None, None, "chat-1", &s).unwrap()),
            Some(("opencode".into(), None))
        );
        assert_eq!(
            picked(select(Some("kimi"), None, "chat-1", &s).unwrap()),
            Some(("kimi".into(), None))
        );
        assert_eq!(
            picked(select(Some("pi"), None, "chat-1", &s).unwrap()),
            None
        );
    }

    #[test]
    fn saved_sessions_reopen_in_their_own_harness() {
        let s = settings(Some("opencode"));
        assert_eq!(
            picked(select(Some("opencode"), Some("acp:claude-code:abc"), "chat-1", &s).unwrap()),
            Some(("claude-code".into(), Some("abc".into())))
        );
        // A pi session file keeps the chat on pi even when the default changed.
        assert_eq!(
            picked(select(None, Some("/h/.pi/agent/sessions/x.jsonl"), "chat-1", &s).unwrap()),
            None
        );
    }

    #[test]
    fn research_is_always_pi_and_unknown_ids_error() {
        let s = settings(Some("opencode"));
        assert_eq!(
            picked(select(Some("opencode"), None, "research-1", &s).unwrap()),
            None
        );
        assert!(select(Some("nope"), None, "chat-1", &s).is_err());
    }

    #[test]
    fn custom_entries_cannot_shadow_builtins_or_use_bad_ids() {
        let s = HarnessSettings {
            default: None,
            custom: vec![
                spec("opencode", "Evil", "evil", &[], ""),
                spec("Bad Id", "Bad", "bad", &[], ""),
                spec("ok-1", "Ok", "ok", &[], ""),
            ],
        };
        let all = all_acp(&s);
        assert_eq!(all.iter().filter(|h| h.id == "opencode").count(), 1);
        assert_eq!(
            all.iter().find(|h| h.id == "opencode").unwrap().command,
            "opencode"
        );
        assert!(all.iter().any(|h| h.id == "ok-1"));
        assert!(!all.iter().any(|h| h.id == "Bad Id"));
    }

    #[test]
    fn resolve_spec_falls_back_to_alternate_names() {
        let dir = std::env::temp_dir().join(format!("kern-harness-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("claude-code-acp");
        std::fs::write(&old, "").unwrap();
        let mut spec = builtin_acp()
            .into_iter()
            .find(|spec| spec.id == "claude-code")
            .unwrap();
        spec.command = dir.join("claude-agent-acp").to_string_lossy().into_owned();
        spec.alternates = vec![old.to_string_lossy().into_owned()];
        assert_eq!(resolve_spec(&spec), Some(old));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn npm_harnesses_are_installable_and_hermes_is_not() {
        for spec in builtin_acp() {
            assert_eq!(
                spec.npm_packages.is_empty(),
                spec.id == "hermes",
                "{}",
                spec.id
            );
        }
    }
}
