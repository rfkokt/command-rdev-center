use serde::{Deserialize, Serialize};

mod diff;
mod files;
mod pi_rpc;
mod projects;
mod settings;
mod worktree;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub pi_path: String,
    pub project_root: String,
    pub default_provider: String,
    pub default_model: String,
    pub default_thinking: String,
    #[serde(default)]
    pub projects: Vec<String>,
}

fn config_path() -> std::path::PathBuf {
    // dev: file lives next to Cargo.toml (src-tauri/crc.config.json)
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("crc.config.json")
}

#[tauri::command]
fn get_config() -> Result<Config, String> {
    let raw = std::fs::read_to_string(config_path()).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_config,
            diff::get_worktree_diff,
            projects::list_projects,
            projects::add_project,
            settings::get_pi_settings,
            settings::save_pi_settings,
            worktree::ensure_worktree,
            worktree::remove_worktree,
            pi_rpc::spawn_pi_rpc,
            pi_rpc::send_pi_command,
            pi_rpc::kill_pi_session,
            pi_rpc::list_pi_sessions,
            files::search_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
