use serde::{Deserialize, Serialize};

mod dev_runner;
mod diff;
mod files;
mod graph;
mod kanban;
mod pi_rpc;
mod pipeline;
mod projects;
mod settings;
mod task_storage;
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

#[tauri::command]
fn get_config() -> Result<Config, String> {
    let raw = std::fs::read_to_string(projects::config_path()).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| projects::init_config(app.handle()).map_err(Into::into))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_config,
            dev_runner::detect_dev_command,
            dev_runner::get_dev_server,
            dev_runner::start_dev_server,
            dev_runner::stop_dev_server,
            graph::get_graph_status,
            graph::get_git_fingerprint,
            graph::build_graph,
            graph::enable_global_graphignore,
            kanban::list_kanban_tasks,
            kanban::save_kanban_tasks,
            kanban::sync_chat_task,
            pipeline::get_pipeline_data,
            pipeline::start_pipeline_run,
            pipeline::update_pipeline_stage,
            pipeline::finish_pipeline_run,
            diff::get_worktree_diff,
            projects::list_projects,
            projects::list_project_branches,
            projects::add_project,
            projects::update_project_base_branch,
            projects::remove_project,
            settings::get_pi_settings,
            settings::save_pi_settings,
            settings::get_graphify_settings,
            settings::fetch_graphify_models,
            settings::save_graphify_settings,
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
