use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

fn global_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    Ok(PathBuf::from(home).join(".pi/agent/settings.json"))
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
    if !path.exists() { return Ok(Value::Object(Map::new())); }
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&raw).map_err(|e| format!("invalid settings JSON: {e}"))?;
    if !value.is_object() { return Err("settings root must be a JSON object".to_string()); }
    Ok(value)
}

#[tauri::command]
pub fn get_pi_settings(scope: String, project_path: Option<String>) -> Result<Value, String> {
    read_value(&settings_path(&scope, project_path.as_deref())?)
}

#[tauri::command]
pub fn save_pi_settings(scope: String, project_path: Option<String>, settings: Value) -> Result<(), String> {
    if !settings.is_object() { return Err("settings root must be a JSON object".to_string()); }
    let path = settings_path(&scope, project_path.as_deref())?;
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let temp = path.with_extension("json.tmp");
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&temp, format!("{raw}\n")).map_err(|e| e.to_string())?;
    std::fs::rename(temp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unknown_scope() { assert!(settings_path("other", None).is_err()); }
}
