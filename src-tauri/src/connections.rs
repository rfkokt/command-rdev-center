//! Model connection profiles.
//!
//! One place to configure an LLM endpoint (base URL + protocol + key + models)
//! and have every harness use it:
//!
//! | Harness      | How a profile is applied                                             |
//! |--------------|----------------------------------------------------------------------|
//! | pi           | `kern-<id>` provider in `~/.pi/agent/models.json` (all profiles)     |
//! | oh-my-pi     | `kern-<id>` provider in `~/.omp/agent/models.yml` (all profiles)     |
//! | OpenCode     | `kern-<id>` provider via `OPENCODE_CONFIG_CONTENT` (all profiles)    |
//! | Claude Code  | `ANTHROPIC_*` env for the assigned Anthropic-protocol profile        |
//! | Codex        | `OPENAI_BASE_URL`/`OPENAI_API_KEY` for the assigned Responses profile|
//!
//! API keys live only in the macOS Keychain. Config files reference an env var
//! name (`KERN_CONNECTION_<ID>_API_KEY`) that Kern sets when it spawns an agent,
//! so no key is ever written to disk. Model ids are `kern-<id>/<model>` in pi,
//! oh-my-pi and OpenCode alike, so a model picked once resolves in all three.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const KEYCHAIN_SERVICE: &str = "command-rdev-center.connections";
pub const PROVIDER_PREFIX: &str = "kern-";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Protocol {
    /// OpenAI Chat Completions (most gateways: OpenRouter, DeepSeek, Ollama, vLLM, LiteLLM, …)
    OpenaiChat,
    /// OpenAI Responses API
    OpenaiResponses,
    /// Anthropic Messages API (Anthropic, and gateways exposing an Anthropic-compatible endpoint)
    Anthropic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub protocol: Protocol,
    pub base_url: String,
    /// First entry is the profile's default model.
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default, skip_deserializing)]
    pub has_api_key: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ConnectionsFile {
    pub profiles: Vec<ConnectionProfile>,
    /// harness id → profile id. Required to route Claude Code and Codex
    /// (single-endpoint agents); for OpenCode it picks the default model.
    pub assignments: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionsView {
    pub profiles: Vec<ConnectionProfile>,
    pub assignments: HashMap<String, String>,
    /// harness id → protocols it can use.
    pub compatibility: HashMap<String, Vec<Protocol>>,
    /// Harnesses that only use a profile when one is assigned to them.
    pub assignment_required: Vec<String>,
}

/// Which protocols each harness can be pointed at.
pub fn supported_protocols(harness: &str) -> &'static [Protocol] {
    use Protocol::*;
    match harness {
        "pi" | "oh-my-pi" | "opencode" => &[OpenaiChat, OpenaiResponses, Anthropic],
        "claude-code" => &[Anthropic],
        "codex" => &[OpenaiResponses],
        _ => &[],
    }
}

/// Harnesses that take exactly one assigned profile (env-routed).
fn needs_assignment(harness: &str) -> bool {
    matches!(harness, "claude-code" | "codex")
}

pub fn provider_name(id: &str) -> String {
    format!("{PROVIDER_PREFIX}{id}")
}

pub fn key_env_name(id: &str) -> String {
    let upper: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect();
    format!("KERN_CONNECTION_{upper}_API_KEY")
}

// ------------------------------------------------------------------ storage

fn file_path() -> PathBuf {
    crate::projects::config_path()
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("connections.json")
}

pub fn read_file() -> ConnectionsFile {
    std::fs::read_to_string(file_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = path.with_extension("kern-tmp");
    std::fs::write(&temp, contents).map_err(|e| e.to_string())?;
    std::fs::rename(temp, path).map_err(|e| e.to_string())
}

fn write_file(file: &ConnectionsFile) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    write_atomic(&file_path(), &format!("{raw}\n"))
}

fn read_key(id: &str) -> Option<String> {
    security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, id)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .filter(|key| !key.is_empty())
}

// --------------------------------------------------------------- validation

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !id.starts_with('-')
}

/// Normalises the base URL: no trailing slash; Anthropic profiles are stored
/// at the API root (no `/v1`) because that is what Anthropic SDK clients
/// (pi, Claude Code) expect.
pub fn normalize_base_url(protocol: Protocol, url: &str) -> String {
    let mut url = url.trim().trim_end_matches('/').to_string();
    if protocol == Protocol::Anthropic {
        if let Some(stripped) = url.strip_suffix("/v1") {
            url = stripped.to_string();
        }
    }
    url
}

pub fn validate_profile(profile: &ConnectionProfile) -> Result<(), String> {
    if !valid_id(&profile.id) {
        return Err("Connection id must be lowercase letters, digits or dashes (max 32)".into());
    }
    if profile.name.trim().is_empty() {
        return Err("Connection name is required".into());
    }
    let parsed = url::Url::parse(&profile.base_url).map_err(|_| "Base URL is not a valid URL")?;
    let local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && local) {
        return Err("Base URL must use HTTPS (HTTP allowed only for localhost)".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.query().is_some() {
        return Err("Base URL must not contain credentials or a query string".into());
    }
    if profile
        .models
        .iter()
        .any(|model| model.trim().is_empty() || model.chars().any(char::is_whitespace))
    {
        return Err("Model ids must be non-empty and contain no spaces".into());
    }
    Ok(())
}

// ------------------------------------------------- pi / oh-my-pi model files

fn pi_api(protocol: Protocol) -> &'static str {
    match protocol {
        Protocol::OpenaiChat => "openai-completions",
        Protocol::OpenaiResponses => "openai-responses",
        Protocol::Anthropic => "anthropic-messages",
    }
}

fn pi_provider_entry(profile: &ConnectionProfile) -> Value {
    json!({
        "baseUrl": profile.base_url,
        "api": pi_api(profile.protocol),
        "apiKey": key_env_name(&profile.id),
        "models": profile.models.iter().map(|id| json!({ "id": id, "name": id })).collect::<Vec<_>>(),
    })
}

/// Replace every `kern-*` provider in a pi-style `{providers:{…}}` document
/// with the current profiles; user-defined providers are left untouched.
pub fn merge_managed_providers(
    document: &mut Value,
    profiles: &[ConnectionProfile],
) -> Result<(), String> {
    if document.is_null() {
        *document = json!({});
    }
    let root = document
        .as_object_mut()
        .ok_or("models file root must be an object")?;
    let providers = root
        .entry("providers")
        .or_insert_with(|| Value::Object(Map::new()));
    if providers.is_null() {
        *providers = Value::Object(Map::new());
    }
    let providers = providers
        .as_object_mut()
        .ok_or("`providers` must be an object")?;
    providers.retain(|name, _| !name.starts_with(PROVIDER_PREFIX));
    for profile in profiles.iter().filter(|profile| !profile.models.is_empty()) {
        providers.insert(provider_name(&profile.id), pi_provider_entry(profile));
    }
    Ok(())
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set".to_string())
}

/// Keep a one-time copy of a user file before Kern first edits it.
fn backup_once(path: &Path) {
    let backup = path.with_extension(format!(
        "{}.kern-backup",
        path.extension().and_then(|e| e.to_str()).unwrap_or("bak")
    ));
    if path.exists() && !backup.exists() {
        let _ = std::fs::copy(path, backup);
    }
}

fn sync_pi_models(path: &Path, profiles: &[ConnectionProfile]) -> Result<(), String> {
    let existed = path.exists();
    let mut document: Value = if existed {
        let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        if raw.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&raw)
                .map_err(|e| format!("{} is not valid JSON ({e}); fix it first", path.display()))?
        }
    } else {
        json!({})
    };
    let before = document.clone();
    merge_managed_providers(&mut document, profiles)?;
    if existed && document == before {
        return Ok(());
    }
    if !existed && profiles.iter().all(|p| p.models.is_empty()) {
        return Ok(());
    }
    backup_once(path);
    let raw = serde_json::to_string_pretty(&document).map_err(|e| e.to_string())?;
    write_atomic(path, &format!("{raw}\n"))
}

fn sync_omp_models(path: &Path, profiles: &[ConnectionProfile]) -> Result<(), String> {
    let existed = path.exists();
    let mut document: Value = if existed {
        let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        if raw.trim().is_empty() {
            json!({})
        } else {
            serde_yaml::from_str(&raw)
                .map_err(|e| format!("{} is not valid YAML ({e}); fix it first", path.display()))?
        }
    } else {
        json!({})
    };
    let before = document.clone();
    merge_managed_providers(&mut document, profiles)?;
    if existed && document == before {
        return Ok(());
    }
    if !existed && profiles.iter().all(|p| p.models.is_empty()) {
        return Ok(());
    }
    backup_once(path);
    let raw = serde_yaml::to_string(&document).map_err(|e| e.to_string())?;
    write_atomic(
        path,
        &format!("# kern-* providers are managed by Kern Studio (Settings → Connections).\n{raw}"),
    )
}

/// Write managed providers into pi's and oh-my-pi's model files. oh-my-pi is
/// only touched when it is installed (its agent dir exists).
pub fn sync_agent_model_files(profiles: &[ConnectionProfile]) -> Result<(), String> {
    let home = home()?;
    sync_pi_models(&home.join(".pi/agent/models.json"), profiles)?;
    let omp_dir = home.join(".omp/agent");
    if omp_dir.is_dir() {
        sync_omp_models(&omp_dir.join("models.yml"), profiles)?;
    }
    Ok(())
}

// ------------------------------------------------------------ spawn-time env

fn opencode_provider(profile: &ConnectionProfile) -> Value {
    let (npm, base_url) = match profile.protocol {
        Protocol::OpenaiChat => ("@ai-sdk/openai-compatible", profile.base_url.clone()),
        Protocol::OpenaiResponses => ("@ai-sdk/openai", profile.base_url.clone()),
        // @ai-sdk/anthropic's baseURL includes the /v1 segment.
        Protocol::Anthropic => ("@ai-sdk/anthropic", format!("{}/v1", profile.base_url)),
    };
    let models: Map<String, Value> = profile
        .models
        .iter()
        .map(|id| (id.clone(), json!({ "name": id })))
        .collect();
    json!({
        "npm": npm,
        "name": profile.name,
        "options": {
            "baseURL": base_url,
            "apiKey": format!("{{env:{}}}", key_env_name(&profile.id)),
        },
        "models": models,
    })
}

/// Environment for one agent spawn. Pure: keys are passed in.
pub fn env_for_harness(
    harness: &str,
    file: &ConnectionsFile,
    keys: &HashMap<String, String>,
) -> Vec<(String, String)> {
    let supported = supported_protocols(harness);
    let usable: Vec<&ConnectionProfile> = file
        .profiles
        .iter()
        .filter(|profile| supported.contains(&profile.protocol) && keys.contains_key(&profile.id))
        .collect();
    let mut env: Vec<(String, String)> = usable
        .iter()
        .map(|profile| (key_env_name(&profile.id), keys[&profile.id].clone()))
        .collect();
    let assigned = file
        .assignments
        .get(harness)
        .and_then(|id| usable.iter().find(|profile| &profile.id == id).copied());

    match harness {
        "opencode" => {
            let providers: Map<String, Value> = usable
                .iter()
                .filter(|profile| !profile.models.is_empty())
                .map(|profile| (provider_name(&profile.id), opencode_provider(profile)))
                .collect();
            if !providers.is_empty() {
                let mut config = json!({ "provider": providers });
                if let Some(profile) = assigned {
                    if let Some(model) = profile.models.first() {
                        config["model"] = json!(format!("{}/{model}", provider_name(&profile.id)));
                    }
                }
                env.push(("OPENCODE_CONFIG_CONTENT".into(), config.to_string()));
            }
        }
        "claude-code" => {
            if let Some(profile) = assigned {
                env.push(("ANTHROPIC_BASE_URL".into(), profile.base_url.clone()));
                env.push(("ANTHROPIC_AUTH_TOKEN".into(), keys[&profile.id].clone()));
                // Prevent a stale real key from being sent to the gateway.
                env.push(("ANTHROPIC_API_KEY".into(), String::new()));
                if let Some(main) = profile.models.first() {
                    // Claude Code's aliases (sonnet/opus/haiku) and background
                    // tasks must not ask the gateway for models it lacks.
                    let small = profile.models.get(1).unwrap_or(main);
                    env.push(("ANTHROPIC_MODEL".into(), main.clone()));
                    env.push(("ANTHROPIC_DEFAULT_OPUS_MODEL".into(), main.clone()));
                    env.push(("ANTHROPIC_DEFAULT_SONNET_MODEL".into(), main.clone()));
                    env.push(("ANTHROPIC_DEFAULT_HAIKU_MODEL".into(), small.clone()));
                    env.push(("ANTHROPIC_SMALL_FAST_MODEL".into(), small.clone()));
                }
            }
        }
        "codex" => {
            if let Some(profile) = assigned {
                env.push(("OPENAI_BASE_URL".into(), profile.base_url.clone()));
                env.push(("OPENAI_API_KEY".into(), keys[&profile.id].clone()));
            }
        }
        _ => {}
    }
    env
}

/// Apply connection env to an agent command. Never fails a spawn: a missing
/// key just means that profile is not offered.
pub fn apply_env(command: &mut Command, harness: &str) {
    let file = read_file();
    if file.profiles.is_empty() {
        return;
    }
    let keys: HashMap<String, String> = file
        .profiles
        .iter()
        .filter_map(|profile| read_key(&profile.id).map(|key| (profile.id.clone(), key)))
        .collect();
    for (name, value) in env_for_harness(harness, &file, &keys) {
        command.env(name, value);
    }
}

/// OpenAI-compatible connection for Graphify (base URL, key).
pub fn openai_endpoint(id: &str) -> Option<(String, String)> {
    let file = read_file();
    let profile = file.profiles.iter().find(|profile| profile.id == id)?;
    if profile.protocol == Protocol::Anthropic {
        return None;
    }
    Some((profile.base_url.clone(), read_key(id)?))
}

// ---------------------------------------------------------------- commands

fn view(file: ConnectionsFile) -> ConnectionsView {
    let mut profiles = file.profiles;
    for profile in &mut profiles {
        profile.has_api_key = read_key(&profile.id).is_some();
    }
    let compatibility = ["pi", "oh-my-pi", "opencode", "claude-code", "codex"]
        .iter()
        .map(|harness| (harness.to_string(), supported_protocols(harness).to_vec()))
        .collect();
    ConnectionsView {
        profiles,
        assignments: file.assignments,
        assignment_required: ["claude-code", "codex"]
            .iter()
            .filter(|harness| needs_assignment(harness))
            .map(|harness| harness.to_string())
            .collect(),
        compatibility,
    }
}

#[tauri::command]
pub fn list_connections() -> Result<ConnectionsView, String> {
    Ok(view(read_file()))
}

fn save_connection_blocking(
    mut profile: ConnectionProfile,
    api_key: Option<String>,
) -> Result<ConnectionsView, String> {
    profile.base_url = normalize_base_url(profile.protocol, &profile.base_url);
    profile.name = profile.name.trim().to_string();
    profile.models = profile
        .models
        .iter()
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty())
        .collect();
    profile.models.dedup();
    profile.has_api_key = false;
    validate_profile(&profile)?;
    let mut file = read_file();
    let key = api_key
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty());
    if let Some(key) = &key {
        if key.contains(['\r', '\n']) {
            return Err("Invalid API key".into());
        }
    } else if read_key(&profile.id).is_none() {
        return Err("API key is required for a new connection".into());
    }
    if let Some(key) = key {
        security_framework::passwords::set_generic_password(
            KEYCHAIN_SERVICE,
            &profile.id,
            key.as_bytes(),
        )
        .map_err(|e| format!("Keychain: {e}"))?;
    }
    match file
        .profiles
        .iter_mut()
        .find(|existing| existing.id == profile.id)
    {
        Some(existing) => *existing = profile,
        None => file.profiles.push(profile),
    }
    // Drop assignments the (possibly changed) protocol can no longer serve.
    let profiles = file.profiles.clone();
    file.assignments.retain(|harness, id| {
        profiles
            .iter()
            .any(|p| &p.id == id && supported_protocols(harness).contains(&p.protocol))
    });
    write_file(&file)?;
    sync_agent_model_files(&file.profiles)?;
    Ok(view(file))
}

#[tauri::command]
pub async fn save_connection(
    profile: ConnectionProfile,
    api_key: Option<String>,
) -> Result<ConnectionsView, String> {
    tauri::async_runtime::spawn_blocking(move || save_connection_blocking(profile, api_key))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn delete_connection(id: String) -> Result<ConnectionsView, String> {
    let mut file = read_file();
    file.profiles.retain(|profile| profile.id != id);
    file.assignments.retain(|_, profile| profile != &id);
    let _ = security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, &id);
    write_file(&file)?;
    sync_agent_model_files(&file.profiles)?;
    Ok(view(file))
}

#[tauri::command]
pub fn set_connection_assignment(
    harness: String,
    profile_id: Option<String>,
) -> Result<ConnectionsView, String> {
    let mut file = read_file();
    match profile_id.filter(|id| !id.is_empty()) {
        Some(id) => {
            let profile = file
                .profiles
                .iter()
                .find(|profile| profile.id == id)
                .ok_or_else(|| format!("Unknown connection `{id}`"))?;
            if !supported_protocols(&harness).contains(&profile.protocol) {
                return Err(format!(
                    "{} cannot use a {:?} connection",
                    harness, profile.protocol
                ));
            }
            file.assignments.insert(harness, id);
        }
        None => {
            file.assignments.remove(&harness);
        }
    }
    write_file(&file)?;
    Ok(view(file))
}

/// Parse an OpenAI- or Anthropic-style `/models` response.
pub fn parse_models_response(value: &Value) -> Result<Vec<String>, String> {
    let mut models: Vec<String> = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or("Models response has no `data` array")?
        .iter()
        .filter_map(|item| item.get("id")?.as_str().map(String::from))
        .collect();
    models.sort();
    models.dedup();
    Ok(models)
}

fn fetch_models_blocking(
    protocol: Protocol,
    base_url: String,
    api_key: Option<String>,
    id: Option<String>,
) -> Result<Vec<String>, String> {
    let base_url = normalize_base_url(protocol, &base_url);
    validate_profile(&ConnectionProfile {
        id: "probe".into(),
        name: "probe".into(),
        protocol,
        base_url: base_url.clone(),
        models: vec![],
        has_api_key: false,
    })?;
    let key = api_key
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .or_else(|| id.as_deref().and_then(read_key))
        .ok_or("Enter the API key first")?;
    if key.contains(['\r', '\n', '"']) {
        return Err("Invalid API key".into());
    }
    let config = match protocol {
        Protocol::Anthropic => format!(
            "url = \"{base_url}/v1/models?limit=1000\"\nheader = \"x-api-key: {key}\"\nheader = \"Authorization: Bearer {key}\"\nheader = \"anthropic-version: 2023-06-01\"\n"
        ),
        _ => format!("url = \"{base_url}/models\"\nheader = \"Authorization: Bearer {key}\"\n"),
    };
    let mut child = Command::new("curl")
        .args([
            "--silent",
            "--show-error",
            "--fail-with-body",
            "--max-time",
            "20",
            "--config",
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    std::io::Write::write_all(
        child.stdin.as_mut().ok_or("curl stdin unavailable")?,
        config.as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        let body = String::from_utf8_lossy(&output.stdout);
        let error = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "{} {}",
            error.trim(),
            body.chars().take(300).collect::<String>()
        )
        .trim()
        .to_string());
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Invalid models response: {e}"))?;
    parse_models_response(&value)
}

#[tauri::command]
pub async fn fetch_connection_models(
    protocol: Protocol,
    base_url: String,
    api_key: Option<String>,
    id: Option<String>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fetch_models_blocking(protocol, base_url, api_key, id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str, protocol: Protocol, models: &[&str]) -> ConnectionProfile {
        ConnectionProfile {
            id: id.into(),
            name: id.to_uppercase(),
            protocol,
            base_url: match protocol {
                Protocol::Anthropic => "https://api.z.ai/api/anthropic".into(),
                _ => "https://openrouter.ai/api/v1".into(),
            },
            models: models.iter().map(|m| m.to_string()).collect(),
            has_api_key: false,
        }
    }

    fn file(profiles: Vec<ConnectionProfile>, assignments: &[(&str, &str)]) -> ConnectionsFile {
        ConnectionsFile {
            profiles,
            assignments: assignments
                .iter()
                .map(|(h, p)| (h.to_string(), p.to_string()))
                .collect(),
        }
    }

    fn keys(ids: &[&str]) -> HashMap<String, String> {
        ids.iter()
            .map(|id| (id.to_string(), format!("sk-{id}")))
            .collect()
    }

    fn get<'a>(env: &'a [(String, String)], name: &str) -> Option<&'a str> {
        env.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    #[test]
    fn key_env_names_are_shell_safe() {
        assert_eq!(
            key_env_name("open-router"),
            "KERN_CONNECTION_OPEN_ROUTER_API_KEY"
        );
    }

    #[test]
    fn normalizes_and_validates_urls() {
        assert_eq!(
            normalize_base_url(Protocol::Anthropic, "https://api.anthropic.com/v1/"),
            "https://api.anthropic.com"
        );
        assert_eq!(
            normalize_base_url(Protocol::OpenaiChat, "https://x.ai/v1/"),
            "https://x.ai/v1"
        );
        let mut p = profile("ok", Protocol::OpenaiChat, &["m"]);
        assert!(validate_profile(&p).is_ok());
        p.base_url = "http://10.0.0.5:8000/v1".into();
        assert!(validate_profile(&p).is_err());
        p.base_url = "http://localhost:11434/v1".into();
        assert!(validate_profile(&p).is_ok());
        p.base_url = "https://user:pw@x.ai/v1".into();
        assert!(validate_profile(&p).is_err());
        p.base_url = "https://x.ai/v1".into();
        p.models = vec!["has space".into()];
        assert!(validate_profile(&p).is_err());
        p.models = vec![];
        p.id = "Bad".into();
        assert!(validate_profile(&p).is_err());
    }

    #[test]
    fn merge_replaces_only_kern_providers() {
        let mut doc = json!({
            "providers": {
                "ollama": { "baseUrl": "http://localhost:11434/v1", "models": [{ "id": "llama" }] },
                "kern-old": { "baseUrl": "https://gone" }
            },
            "other": true
        });
        merge_managed_providers(
            &mut doc,
            &[
                profile("zai", Protocol::Anthropic, &["glm-5"]),
                profile("empty", Protocol::OpenaiChat, &[]),
            ],
        )
        .unwrap();
        let providers = doc["providers"].as_object().unwrap();
        assert!(providers.contains_key("ollama"));
        assert!(!providers.contains_key("kern-old"));
        assert!(!providers.contains_key("kern-empty"));
        assert_eq!(doc["other"], true);
        let zai = &providers["kern-zai"];
        assert_eq!(zai["api"], "anthropic-messages");
        assert_eq!(zai["apiKey"], "KERN_CONNECTION_ZAI_API_KEY");
        assert_eq!(zai["models"][0]["id"], "glm-5");
        let mut bad = json!([]);
        assert!(merge_managed_providers(&mut bad, &[]).is_err());
    }

    #[test]
    fn pi_and_omp_files_round_trip_and_preserve_user_entries() {
        let dir = std::env::temp_dir().join(format!("kern-conn-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pi = dir.join("models.json");
        std::fs::write(
            &pi,
            r#"{"providers":{"mine":{"baseUrl":"https://a","models":[{"id":"x"}]}}}"#,
        )
        .unwrap();
        let profiles = [profile(
            "or",
            Protocol::OpenaiChat,
            &["deepseek/deepseek-v4"],
        )];
        sync_pi_models(&pi, &profiles).unwrap();
        let written: Value = serde_json::from_str(&std::fs::read_to_string(&pi).unwrap()).unwrap();
        assert!(written["providers"]["mine"].is_object());
        assert_eq!(written["providers"]["kern-or"]["api"], "openai-completions");
        assert!(dir.join("models.json.kern-backup").exists());
        assert!(!std::fs::read_to_string(&pi).unwrap().contains("sk-"));

        let omp = dir.join("models.yml");
        std::fs::write(&omp, "providers:\n  mine:\n    baseUrl: https://a\n").unwrap();
        sync_omp_models(&omp, &profiles).unwrap();
        let yaml: Value = serde_yaml::from_str(&std::fs::read_to_string(&omp).unwrap()).unwrap();
        assert_eq!(yaml["providers"]["mine"]["baseUrl"], "https://a");
        assert_eq!(
            yaml["providers"]["kern-or"]["models"][0]["id"],
            "deepseek/deepseek-v4"
        );

        // Removing every profile removes only Kern's providers.
        sync_pi_models(&pi, &[]).unwrap();
        let written: Value = serde_json::from_str(&std::fs::read_to_string(&pi).unwrap()).unwrap();
        assert!(written["providers"].get("kern-or").is_none());
        assert!(written["providers"]["mine"].is_object());

        // Invalid user JSON is never overwritten.
        std::fs::write(&pi, "{ broken").unwrap();
        assert!(sync_pi_models(&pi, &profiles).is_err());
        assert_eq!(std::fs::read_to_string(&pi).unwrap(), "{ broken");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn opencode_gets_all_compatible_profiles_and_assigned_default() {
        let f = file(
            vec![
                profile("or", Protocol::OpenaiChat, &["deepseek/v4"]),
                profile("zai", Protocol::Anthropic, &["glm-5"]),
                profile("nokey", Protocol::OpenaiChat, &["m"]),
            ],
            &[("opencode", "zai")],
        );
        let env = env_for_harness("opencode", &f, &keys(&["or", "zai"]));
        assert_eq!(get(&env, "KERN_CONNECTION_OR_API_KEY"), Some("sk-or"));
        assert_eq!(get(&env, "KERN_CONNECTION_NOKEY_API_KEY"), None);
        let config: Value =
            serde_json::from_str(get(&env, "OPENCODE_CONFIG_CONTENT").unwrap()).unwrap();
        assert_eq!(
            config["provider"]["kern-or"]["npm"],
            "@ai-sdk/openai-compatible"
        );
        assert_eq!(
            config["provider"]["kern-or"]["options"]["apiKey"],
            "{env:KERN_CONNECTION_OR_API_KEY}"
        );
        assert_eq!(
            config["provider"]["kern-zai"]["options"]["baseURL"],
            "https://api.z.ai/api/anthropic/v1"
        );
        assert!(config["provider"].get("kern-nokey").is_none());
        assert_eq!(config["model"], "kern-zai/glm-5");
        assert!(
            !config.to_string().contains("sk-"),
            "keys stay in env, not config"
        );
    }

    #[test]
    fn claude_code_routes_only_through_assigned_anthropic_profile() {
        let f = file(
            vec![
                profile("or", Protocol::OpenaiChat, &["x"]),
                profile("zai", Protocol::Anthropic, &["glm-5", "glm-5-air"]),
            ],
            &[("claude-code", "zai")],
        );
        let env = env_for_harness("claude-code", &f, &keys(&["or", "zai"]));
        assert_eq!(
            get(&env, "ANTHROPIC_BASE_URL"),
            Some("https://api.z.ai/api/anthropic")
        );
        assert_eq!(get(&env, "ANTHROPIC_AUTH_TOKEN"), Some("sk-zai"));
        assert_eq!(get(&env, "ANTHROPIC_API_KEY"), Some(""));
        assert_eq!(get(&env, "ANTHROPIC_MODEL"), Some("glm-5"));
        assert_eq!(
            get(&env, "ANTHROPIC_DEFAULT_HAIKU_MODEL"),
            Some("glm-5-air")
        );
        assert_eq!(get(&env, "KERN_CONNECTION_OR_API_KEY"), None);

        // No assignment → Claude Code keeps its own login.
        let unassigned = file(f.profiles.clone(), &[]);
        assert!(get(
            &env_for_harness("claude-code", &unassigned, &keys(&["zai"])),
            "ANTHROPIC_BASE_URL"
        )
        .is_none());
    }

    #[test]
    fn codex_and_unknown_harnesses() {
        let f = file(
            vec![profile("oa", Protocol::OpenaiResponses, &["gpt-5"])],
            &[("codex", "oa")],
        );
        let env = env_for_harness("codex", &f, &keys(&["oa"]));
        assert_eq!(
            get(&env, "OPENAI_BASE_URL"),
            Some("https://openrouter.ai/api/v1")
        );
        assert_eq!(get(&env, "OPENAI_API_KEY"), Some("sk-oa"));
        assert!(env_for_harness("gemini", &f, &keys(&["oa"])).is_empty());
        assert!(needs_assignment("codex") && !needs_assignment("opencode"));
    }

    #[test]
    fn parses_models_responses() {
        let openai = json!({ "data": [{ "id": "b" }, { "id": "a" }, { "id": "a" }] });
        assert_eq!(parse_models_response(&openai).unwrap(), ["a", "b"]);
        assert!(parse_models_response(&json!({ "models": [] })).is_err());
    }
}
