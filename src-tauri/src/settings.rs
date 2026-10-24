use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const GRAPHIFY_KEYCHAIN_SERVICE: &str = "command-rdev-center.graphify";
const GRAPHIFY_KEYCHAIN_ACCOUNT: &str = "openai-api-key";
const JEV_KEYCHAIN_SERVICE: &str = "command-rdev-center.jev";
const JEV_KEYCHAIN_ACCOUNT: &str = "api-key";
static JEV_SETTINGS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct JevSettings {
    pub mode: String,
    pub endpoint: String,
    pub model: String,
    pub timeout_ms: u64,
    pub generation: String,
    #[serde(skip_deserializing)]
    pub has_api_key: bool,
}

impl Default for JevSettings {
    fn default() -> Self {
        Self {
            mode: "off".into(),
            endpoint: "https://api.typesafe.ai/v1/systemone".into(),
            model: "jev-1.13.0".into(),
            timeout_ms: 2500,
            generation: String::new(),
            has_api_key: false,
        }
    }
}

fn jev_settings_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    Ok(PathBuf::from(home).join("Library/Application Support/command-rdev-center/jev.json"))
}

fn validate_jev_settings(settings: &JevSettings) -> Result<(), String> {
    if !["off", "shadow", "advisory"].contains(&settings.mode.as_str()) {
        return Err("Jev mode must be off, shadow, or advisory".into());
    }
    if settings.model.trim().is_empty() || !(100..=30_000).contains(&settings.timeout_ms) {
        return Err("Jev requires a model and timeout between 100 and 30000 ms".into());
    }
    let url = url::Url::parse(&settings.endpoint).map_err(|_| "Invalid Jev endpoint")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https" || (url.scheme() == "http" && local))
    {
        return Err("Jev endpoint requires HTTPS or exact loopback HTTP, without credentials, query, or fragment".into());
    }
    Ok(())
}

fn jev_key() -> Result<String, String> {
    let bytes = security_framework::passwords::get_generic_password(
        JEV_KEYCHAIN_SERVICE,
        JEV_KEYCHAIN_ACCOUNT,
    )
    .map_err(|_| "Jev API key not configured")?;
    let key = String::from_utf8(bytes).map_err(|_| "Invalid Jev API key")?;
    if key.trim().is_empty() || key.contains(['\r', '\n']) {
        return Err("Invalid Jev API key".into());
    }
    Ok(key)
}

#[tauri::command(async)]
pub fn get_jev_settings() -> Result<JevSettings, String> {
    let path = jev_settings_path()?;
    let mut settings = if path.exists() {
        serde_json::from_str::<JevSettings>(
            &std::fs::read_to_string(path).map_err(|_| "Cannot read Jev settings")?,
        )
        .map_err(|_| "Invalid Jev settings JSON")?
    } else {
        JevSettings::default()
    };
    validate_jev_settings(&settings)?;
    settings.has_api_key = jev_key().is_ok();
    Ok(settings)
}

#[tauri::command]
pub async fn save_jev_settings(
    mut settings: JevSettings,
    api_key: Option<String>,
) -> Result<JevSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = JEV_SETTINGS_LOCK
            .lock()
            .map_err(|_| "Jev settings lock unavailable")?;
        validate_jev_settings(&settings)?;
        if let Some(key) = api_key.filter(|key| !key.trim().is_empty()) {
            if key.contains(['\r', '\n']) {
                return Err("Invalid Jev API key".into());
            }
            security_framework::passwords::set_generic_password(
                JEV_KEYCHAIN_SERVICE,
                JEV_KEYCHAIN_ACCOUNT,
                key.trim().as_bytes(),
            )
            .map_err(|_| "Cannot save Jev API key to macOS Keychain")?;
        }
        if settings.mode != "off" && jev_key().is_err() {
            return Err("Set a Jev API key before enabling routing".into());
        }
        let path = jev_settings_path()?;
        std::fs::create_dir_all(path.parent().ok_or("Invalid Jev settings directory")?)
            .map_err(|_| "Cannot create Jev settings directory")?;
        let mut generation = [0u8; 16];
        getrandom::fill(&mut generation)
            .map_err(|_| "Cannot create Jev configuration generation")?;
        settings.generation = generation
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        write_jev_settings(&path, &settings)?;
        get_jev_settings()
    })
    .await
    .map_err(|_| "Jev settings worker failed")?
}

fn write_jev_settings(path: &Path, settings: &JevSettings) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(settings).map_err(|_| "Cannot encode Jev settings")?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, format!("{raw}\n")).map_err(|_| "Cannot write Jev settings")?;
    std::fs::rename(temp, path).map_err(|_| "Cannot save Jev settings".to_string())
}

fn disable_jev_at_path(path: &Path, expected_generation: &str) -> Result<bool, String> {
    let mut settings: JevSettings = serde_json::from_str(
        &std::fs::read_to_string(path).map_err(|_| "Cannot read Jev settings")?,
    )
    .map_err(|_| "Invalid Jev settings JSON")?;
    // A stale chat must not turn off settings the user has saved since that chat started.
    if settings.generation != expected_generation || settings.mode == "off" {
        return Ok(false);
    }
    settings.mode = "off".into();
    write_jev_settings(path, &settings)?;
    Ok(true)
}

pub fn disable_jev_for_billing(expected_generation: &str) -> Result<bool, String> {
    let _guard = JEV_SETTINGS_LOCK
        .lock()
        .map_err(|_| "Jev settings lock unavailable")?;
    disable_jev_at_path(&jev_settings_path()?, expected_generation)
}

/// Applied to project sessions only, including runtime-repair respawns.
pub fn apply_jev_env(command: &mut Command) -> Option<String> {
    // Do not inherit shell configuration accidentally: opt-in is app-owned.
    for name in [
        "CRC_JEV_API_KEY",
        "CRC_JEV_ENDPOINT",
        "CRC_JEV_MODEL",
        "CRC_JEV_TIMEOUT_MS",
        "CRC_JEV_SETTINGS_PATH",
    ] {
        command.env_remove(name);
    }
    command.env("CRC_JEV_MODE", "off");
    let settings = get_jev_settings().ok()?;
    if settings.mode == "off" {
        return None;
    }
    command
        .env("CRC_JEV_MODE", settings.mode)
        .env("CRC_JEV_ENDPOINT", settings.endpoint)
        .env("CRC_JEV_MODEL", settings.model)
        .env("CRC_JEV_TIMEOUT_MS", settings.timeout_ms.to_string())
        .env("CRC_JEV_SETTINGS_PATH", jev_settings_path().ok()?);
    if let Ok(key) = jev_key() {
        command.env("CRC_JEV_API_KEY", key);
    }
    Some(settings.generation)
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct GraphifySettings {
    #[serde(default)]
    pub enabled: bool,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub has_api_key: bool,
    /// Use a shared connection profile (Settings → Connections) instead of
    /// Graphify's own base URL and key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
}

/// Opt-in: Graphify integration only activates when the user enables it.
pub fn graphify_enabled() -> bool {
    std::fs::read_to_string(graphify_settings_path().unwrap_or_default())
        .ok()
        .and_then(|raw| serde_json::from_str::<GraphifySettings>(&raw).ok())
        .is_some_and(|s| s.enabled)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FigmaMcpSettings {
    pub enabled: bool,
    pub url: String,
}

impl Default for FigmaMcpSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            url: "https://mcp.figma.com/mcp".into(),
        }
    }
}

fn figma_mcp_settings_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    Ok(PathBuf::from(home).join("Library/Application Support/command-rdev-center/figma-mcp.json"))
}

fn validate_figma_mcp_url(url: &str) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Figma MCP URL must use HTTPS".into());
    }
    Ok(())
}

#[tauri::command(async)]
pub fn get_figma_mcp_settings() -> Result<FigmaMcpSettings, String> {
    let path = figma_mcp_settings_path()?;
    if !path.exists() {
        return Ok(FigmaMcpSettings::default());
    }
    serde_json::from_str(&std::fs::read_to_string(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn save_figma_mcp_settings(enabled: bool, url: String) -> Result<(), String> {
    let _serial = crate::config_guard();
    let settings = FigmaMcpSettings {
        enabled,
        url: url.trim().to_string(),
    };
    validate_figma_mcp_url(&settings.url)?;
    let path = figma_mcp_settings_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(path, format!("{raw}\n")).map_err(|e| e.to_string())
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
    if !settings.enabled {
        return None;
    }
    if let Some(id) = settings.connection_id.as_deref() {
        let (base_url, key) = crate::connections::openai_endpoint(id)?;
        return (!settings.model.trim().is_empty()).then(|| (base_url, settings.model, key));
    }
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

#[tauri::command(async)]
pub fn get_pi_settings(scope: String, project_path: Option<String>) -> Result<Value, String> {
    read_value(&settings_path(&scope, project_path.as_deref())?)
}

#[tauri::command(async)]
pub fn save_pi_settings(
    scope: String,
    project_path: Option<String>,
    settings: Value,
) -> Result<(), String> {
    let _serial = crate::config_guard();
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

#[tauri::command(async)]
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
        enabled: true,
        base_url: base_url.trim().trim_end_matches('/').to_string(),
        model: "placeholder".into(),
        has_api_key: false,
        connection_id: None,
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
    enabled: bool,
    base_url: String,
    model: String,
    api_key: Option<String>,
    connection_id: Option<String>,
) -> Result<GraphifySettings, String> {
    let connection_id = connection_id.filter(|id| !id.trim().is_empty());
    let settings = GraphifySettings {
        enabled,
        base_url: base_url.trim().trim_end_matches('/').to_string(),
        model: model.trim().to_string(),
        has_api_key: false,
        connection_id: connection_id.clone(),
    };
    if let Some(id) = &connection_id {
        if crate::connections::openai_endpoint(id).is_none() {
            return Err("Pick an OpenAI-compatible connection that has an API key".into());
        }
        if enabled && settings.model.is_empty() {
            return Err("Model is required".into());
        }
        write_graphify_settings_file(&settings)?;
        return get_graphify_settings();
    }
    if enabled && (!settings.base_url.is_empty() || !settings.model.is_empty() || api_key.is_some())
    {
        validate_graphify_settings(&settings)?;
    }
    if let Some(key) = api_key.filter(|key| !key.trim().is_empty()) {
        security_framework::passwords::set_generic_password(
            GRAPHIFY_KEYCHAIN_SERVICE,
            GRAPHIFY_KEYCHAIN_ACCOUNT,
            key.trim().as_bytes(),
        )
        .map_err(|e| format!("Failed to save API key to macOS Keychain: {e}"))?;
    } else if enabled && keychain_key().is_err() {
        return Err("API key is required".into());
    }
    write_graphify_settings_file(&settings)?;
    get_graphify_settings()
}

fn write_graphify_settings_file(settings: &GraphifySettings) -> Result<(), String> {
    let path = graphify_settings_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, format!("{raw}\n")).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_graphify_settings(
    enabled: bool,
    base_url: String,
    model: String,
    api_key: Option<String>,
    connection_id: Option<String>,
) -> Result<GraphifySettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_graphify_settings_blocking(enabled, base_url, model, api_key, connection_id)
    })
    .await
    .map_err(|e| format!("Failed to save Graphify settings: {e}"))?
}

// ------------------------------------------------------------ Jev usage

/// TypeSafe publishes no balance API, so Kern tallies billed input tokens
/// itself and estimates the balance from the last amount the user read off
/// the TypeSafe dashboard. Output tokens are free.
pub const JEV_USD_PER_MILLION_INPUT: f64 = 0.042;

static JEV_USAGE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(default)]
pub struct JevUsage {
    /// `YYYY-MM` the monthly counters belong to.
    pub month: String,
    pub month_requests: u64,
    pub month_input_tokens: u64,
    pub total_input_tokens: u64,
    /// Balance the user entered, and the token total at that moment.
    pub balance_usd: Option<f64>,
    pub balance_tokens: u64,
    pub balance_set_at: Option<i64>,
    /// Set when TypeSafe reported exhausted credits; cleared by a new balance.
    pub billing_exhausted_at: Option<i64>,
}

impl JevUsage {
    pub fn spent_since_balance_usd(&self) -> f64 {
        self.total_input_tokens.saturating_sub(self.balance_tokens) as f64 / 1_000_000.0
            * JEV_USD_PER_MILLION_INPUT
    }

    pub fn remaining_usd(&self) -> Option<f64> {
        self.balance_usd
            .map(|balance| (balance - self.spent_since_balance_usd()).max(0.0))
    }
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `YYYY-MM` (UTC) for Unix seconds.
fn month_of(secs: i64) -> String {
    // Civil from days (Howard Hinnant).
    let days = secs.div_euclid(86_400) + 719_468;
    let era = days.div_euclid(146_097);
    let doe = days - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}")
}

fn jev_usage_path() -> Result<PathBuf, String> {
    Ok(jev_settings_path()?.with_file_name("jev-usage.json"))
}

fn read_jev_usage_at(path: &Path) -> JevUsage {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn update_jev_usage(path: &Path, change: impl FnOnce(&mut JevUsage)) -> Result<JevUsage, String> {
    let _guard = JEV_USAGE_LOCK
        .lock()
        .map_err(|_| "Jev usage lock unavailable")?;
    let mut usage = read_jev_usage_at(path);
    change(&mut usage);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "Cannot create Jev usage directory")?;
    }
    let raw = serde_json::to_string_pretty(&usage).map_err(|_| "Cannot encode Jev usage")?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, format!("{raw}\n")).map_err(|_| "Cannot write Jev usage")?;
    std::fs::rename(temp, path).map_err(|_| "Cannot save Jev usage")?;
    Ok(usage)
}

fn add_usage(usage: &mut JevUsage, input_tokens: u64, now: i64) {
    let month = month_of(now);
    if usage.month != month {
        usage.month = month;
        usage.month_requests = 0;
        usage.month_input_tokens = 0;
    }
    usage.month_requests += 1;
    usage.month_input_tokens += input_tokens;
    usage.total_input_tokens += input_tokens;
}

/// One successful Jev request (`CRC_JEV_USAGE <tokens>` from an extension).
pub fn record_jev_usage(input_tokens: u64) {
    if let Ok(path) = jev_usage_path() {
        let _ = update_jev_usage(&path, |usage| add_usage(usage, input_tokens, unix_now()));
    }
}

/// TypeSafe reported exhausted credits (`CRC_JEV_BILLING_EXHAUSTED`).
pub fn record_jev_billing_exhausted() {
    if let Ok(path) = jev_usage_path() {
        let _ = update_jev_usage(&path, |usage| usage.billing_exhausted_at = Some(unix_now()));
    }
}

pub fn jev_usage() -> JevUsage {
    jev_usage_path()
        .map(|path| read_jev_usage_at(&path))
        .unwrap_or_default()
}

#[tauri::command(async)]
pub fn get_jev_usage() -> JevUsage {
    jev_usage()
}

/// The balance shown on the TypeSafe dashboard right now; `None` clears it.
#[tauri::command(async)]
pub fn set_jev_balance(balance_usd: Option<f64>) -> Result<JevUsage, String> {
    let _serial = crate::config_guard();
    if let Some(balance) = balance_usd {
        if !balance.is_finite() || !(0.0..=100_000.0).contains(&balance) {
            return Err("Enter the balance in USD, e.g. 4.86".into());
        }
    }
    update_jev_usage(&jev_usage_path()?, |usage| {
        usage.balance_usd = balance_usd;
        usage.balance_tokens = usage.total_input_tokens;
        usage.balance_set_at = balance_usd.map(|_| unix_now());
        if balance_usd.is_some_and(|balance| balance > 0.0) {
            usage.billing_exhausted_at = None;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn graphify_is_opt_in_for_new_and_legacy_settings() {
        let defaults = GraphifySettings::default();
        assert!(!defaults.enabled);
        assert!(!graphify_enabled());
        // Legacy settings written before `enabled` existed deserialize as off.
        let legacy: GraphifySettings = serde_json::from_str(
            r#"{"base_url":"https://x.example","model":"m","has_api_key":true}"#,
        )
        .unwrap();
        assert!(!legacy.enabled);
        assert_eq!(legacy.base_url, "https://x.example");
        assert!(!serde_json::to_string(&defaults)
            .unwrap()
            .contains("\"enabled\":true"));
    }

    #[test]
    fn rejects_unknown_scope() {
        assert!(settings_path("other", None).is_err());
    }

    #[test]
    fn jev_defaults_are_opt_in_and_do_not_deserialize_key_presence() {
        let defaults = JevSettings::default();
        assert_eq!(defaults.mode, "off");
        assert!(validate_jev_settings(&defaults).is_ok());
        let stored: JevSettings = serde_json::from_str(r#"{"has_api_key":true}"#).unwrap();
        assert!(!stored.has_api_key);
        assert_eq!(stored.mode, "off");
        assert!(!serde_json::to_string(&defaults).unwrap().contains("apiKey"));
    }

    #[test]
    fn jev_rejects_credential_urls_and_loopback_prefix_lookalikes() {
        for endpoint in [
            "http://localhost.evil.test/v1/systemone",
            "http://127.0.0.1.evil.test",
            "https://secret@example.com",
            "https://example.com/?key=secret",
            "https://example.com/#secret",
            "file:///tmp/key",
        ] {
            assert!(
                validate_jev_settings(&JevSettings {
                    endpoint: endpoint.into(),
                    ..JevSettings::default()
                })
                .is_err(),
                "{endpoint}"
            );
        }
        for endpoint in [
            "https://api.typesafe.ai/v1/systemone",
            "http://localhost:1234/v1/systemone",
            "http://127.0.0.1:1234/v1/systemone",
            "http://[::1]:1234/v1/systemone",
        ] {
            assert!(
                validate_jev_settings(&JevSettings {
                    endpoint: endpoint.into(),
                    ..JevSettings::default()
                })
                .is_ok(),
                "{endpoint}"
            );
        }
    }

    #[test]
    fn jev_requires_supported_mode_and_bounded_timeout() {
        assert!(validate_jev_settings(&JevSettings {
            mode: "automatic".into(),
            ..JevSettings::default()
        })
        .is_err());
        for timeout_ms in [0, 99, 30_001] {
            assert!(validate_jev_settings(&JevSettings {
                timeout_ms,
                ..JevSettings::default()
            })
            .is_err());
        }
    }

    #[test]
    fn graphify_connection_id_is_optional_in_stored_json() {
        let legacy: GraphifySettings =
            serde_json::from_str(r#"{"enabled":true,"base_url":"https://x","model":"m"}"#).unwrap();
        assert_eq!(legacy.connection_id, None);
        assert!(!serde_json::to_string(&legacy)
            .unwrap()
            .contains("connection_id"));
    }

    #[test]
    fn graphify_url_requires_https_or_localhost() {
        let valid = GraphifySettings {
            enabled: true,
            base_url: "https://router.example/v1".into(),
            model: "model".into(),
            has_api_key: false,
            connection_id: None,
        };
        assert!(validate_graphify_settings(&valid).is_ok());
        assert!(validate_graphify_settings(&GraphifySettings {
            base_url: "http://router.example/v1".into(),
            ..valid
        })
        .is_err());
    }
}

#[cfg(test)]
mod jev_usage_tests {
    use super::*;

    #[test]
    fn months_roll_over_and_balance_counts_only_later_tokens() {
        assert_eq!(month_of(0), "1970-01");
        assert_eq!(month_of(1_792_778_399), "2026-10");
        assert_eq!(month_of(1_793_491_200), "2026-11"); // 2026-11-01T00:00Z

        let mut usage = JevUsage::default();
        add_usage(&mut usage, 3_000_000, 1_792_778_399);
        usage.balance_usd = Some(4.86);
        usage.balance_tokens = usage.total_input_tokens;
        add_usage(&mut usage, 10_000_000, 1_792_778_400);
        assert_eq!(
            (usage.month_requests, usage.month_input_tokens),
            (2, 13_000_000)
        );
        assert!((usage.spent_since_balance_usd() - 0.42).abs() < 1e-9);
        assert!((usage.remaining_usd().unwrap() - 4.44).abs() < 1e-9);

        add_usage(&mut usage, 1_000, 1_793_491_200);
        assert_eq!((usage.month.as_str(), usage.month_requests), ("2026-11", 1));
        assert_eq!(usage.total_input_tokens, 13_001_000);
    }

    #[test]
    fn usage_file_round_trips() {
        let path = std::env::temp_dir().join(format!("kern-jev-usage-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        update_jev_usage(&path, |usage| add_usage(usage, 500, 1_792_778_399)).unwrap();
        let usage = update_jev_usage(&path, |usage| usage.billing_exhausted_at = Some(1)).unwrap();
        assert_eq!(read_jev_usage_at(&path), usage);
        assert_eq!(usage.total_input_tokens, 500);
        let _ = std::fs::remove_file(path);
    }
}
