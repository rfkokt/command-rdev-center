use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const GRAPHIFY_KEYCHAIN_SERVICE: &str = "command-rdev-center.graphify";
const GRAPHIFY_KEYCHAIN_ACCOUNT: &str = "openai-api-key";

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct GraphifySettings {
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub has_api_key: bool,
}

fn global_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    Ok(PathBuf::from(home).join(".pi/agent/settings.json"))
}

fn graphify_settings_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    Ok(PathBuf::from(home).join("Library/Application Support/command-rdev-center/graphify.json"))
}

fn validate_graphify_settings(settings: &GraphifySettings) -> Result<(), String> {
    if settings.base_url.trim().is_empty() || settings.model.trim().is_empty() {
        return Err("Base URL and model are required".into());
    }
    if !settings.base_url.starts_with("https://")
        && !settings.base_url.starts_with("http://localhost")
        && !settings.base_url.starts_with("http://127.0.0.1")
    {
        return Err("Base URL must use HTTPS (HTTP allowed only for localhost)".into());
    }
    Ok(())
}

fn keychain_key() -> Result<String, String> {
    let password = security_framework::passwords::get_generic_password(
        GRAPHIFY_KEYCHAIN_SERVICE,
        GRAPHIFY_KEYCHAIN_ACCOUNT,
    )
    .map_err(|_| "Graphify API key not configured".to_string())?;
    String::from_utf8(password).map_err(|_| "Graphify API key is invalid UTF-8".to_string())
}

pub fn graphify_env() -> Option<(String, String, String)> {
    let settings: GraphifySettings =
        serde_json::from_str(&std::fs::read_to_string(graphify_settings_path().ok()?).ok()?)
            .ok()?;
    let key = keychain_key().ok()?;
    (!key.is_empty() && validate_graphify_settings(&settings).is_ok())
        .then(|| (settings.base_url, settings.model, key))
}

fn settings_path(scope: &str, project_path: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        "global" => global_path(),
        "project" => {
            let project = PathBuf::from(project_path.ok_or("project path required")?);
            crate::projects::ensure_registered_project(&project)?;
            Ok(project.join(".pi/settings.json"))
        }
        _ => Err("scope must be global or project".to_string()),
    }
}

fn read_value(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(Value::Object(Map::new()));
    }
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let value: Value =
        serde_json::from_str(&raw).map_err(|e| format!("invalid settings JSON: {e}"))?;
    if !value.is_object() {
        return Err("settings root must be a JSON object".to_string());
    }
    Ok(value)
}

#[tauri::command]
pub fn get_pi_settings(scope: String, project_path: Option<String>) -> Result<Value, String> {
    read_value(&settings_path(&scope, project_path.as_deref())?)
}

#[tauri::command]
pub fn save_pi_settings(
    scope: String,
    project_path: Option<String>,
    settings: Value,
) -> Result<(), String> {
    if !settings.is_object() {
        return Err("settings root must be a JSON object".to_string());
    }
    let path = settings_path(&scope, project_path.as_deref())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = path.with_extension("json.tmp");
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&temp, format!("{raw}\n")).map_err(|e| e.to_string())?;
    std::fs::rename(temp, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_graphify_settings() -> Result<GraphifySettings, String> {
    let path = graphify_settings_path()?;
    let mut settings = if path.exists() {
        serde_json::from_str::<GraphifySettings>(
            &std::fs::read_to_string(path).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?
    } else {
        GraphifySettings::default()
    };
    settings.has_api_key = keychain_key().is_ok();
    Ok(settings)
}

fn fetch_graphify_models_blocking(
    base_url: String,
    api_key: Option<String>,
) -> Result<Vec<String>, String> {
    let settings = GraphifySettings {
        base_url: base_url.trim().trim_end_matches('/').to_string(),
        model: "placeholder".into(),
        has_api_key: false,
    };
    validate_graphify_settings(&settings)?;
    let key = api_key
        .filter(|key| !key.trim().is_empty())
        .map(|key| key.trim().to_string())
        .map_or_else(keychain_key, Ok)?;
    if key.contains(['\r', '\n', '"']) {
        return Err("Invalid API key".into());
    }
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
    let config = format!(
        "url = \"{}/models\"\nheader = \"Authorization: Bearer {}\"\n",
        settings.base_url, key
    );
    std::io::Write::write_all(
        child.stdin.as_mut().ok_or("curl stdin unavailable")?,
        config.as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Invalid models response: {e}"))?;
    let mut models: Vec<String> = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or("Models response missing data array")?
        .iter()
        .filter_map(|item| item.get("id")?.as_str().map(String::from))
        .collect();
    models.sort();
    models.dedup();
    Ok(models)
}

#[tauri::command]
pub async fn fetch_graphify_models(
    base_url: String,
    api_key: Option<String>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_graphify_models_blocking(base_url, api_key))
        .await
        .map_err(|e| format!("Failed to fetch models: {e}"))?
}

fn save_graphify_settings_blocking(
    base_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<GraphifySettings, String> {
    let settings = GraphifySettings {
        base_url: base_url.trim().trim_end_matches('/').to_string(),
        model: model.trim().to_string(),
        has_api_key: false,
    };
    validate_graphify_settings(&settings)?;
    if let Some(key) = api_key.filter(|key| !key.trim().is_empty()) {
        security_framework::passwords::set_generic_password(
            GRAPHIFY_KEYCHAIN_SERVICE,
            GRAPHIFY_KEYCHAIN_ACCOUNT,
            key.trim().as_bytes(),
        )
        .map_err(|e| format!("Failed to save API key to macOS Keychain: {e}"))?;
    } else if keychain_key().is_err() {
        return Err("API key is required".into());
    }
    let path = graphify_settings_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(path, format!("{raw}\n")).map_err(|e| e.to_string())?;
    get_graphify_settings()
}

#[tauri::command]
pub async fn save_graphify_settings(
    base_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<GraphifySettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_graphify_settings_blocking(base_url, model, api_key)
    })
    .await
    .map_err(|e| format!("Failed to save Graphify settings: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unknown_scope() {
        assert!(settings_path("other", None).is_err());
    }

    #[test]
    fn graphify_url_requires_https_or_localhost() {
        let valid = GraphifySettings {
            base_url: "https://router.example/v1".into(),
            model: "model".into(),
            has_api_key: false,
        };
        assert!(validate_graphify_settings(&valid).is_ok());
        assert!(validate_graphify_settings(&GraphifySettings {
            base_url: "http://router.example/v1".into(),
            ..valid
        })
        .is_err());
    }
}
