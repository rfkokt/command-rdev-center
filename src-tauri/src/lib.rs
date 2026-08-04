use serde::{Deserialize, Serialize};

mod dev_runner;
mod diff;
mod files;
mod graph;
mod kanban;
mod pi_rpc;
mod pipeline;
mod projects;
mod rag;
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

#[tauri::command]
fn get_config() -> Result<Config, String> {
    let raw = std::fs::read_to_string(projects::config_path()).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            kanban::update_kanban_task_status,
            kanban::sync_chat_task,
            kanban::create_error_report_task,
            pipeline::get_pipeline_data,
            pipeline::get_pipeline_config,
            pipeline::save_pipeline_config,
            pipeline::start_pipeline,
            pipeline::cancel_pipeline,
            pipeline::retry_pipeline_step,
            pipeline::skip_pipeline_step,
            pipeline::provide_pipeline_input,
            diff::get_worktree_diff,
            diff::get_workspace_diff,
            projects::list_projects,
            projects::list_project_branches,
            projects::discover_projects,
            projects::add_workspace,
            projects::add_project,
            projects::update_project_base_branch,
            projects::update_project_pipeline_type,
            projects::get_backlog_dir,
            projects::save_backlog_dir,
            projects::remove_project,
            rag::get_rag_settings,
            rag::save_rag_settings,
            rag::test_rag_connection,
            rag::ingest_rag_document,
            rag::save_rag_chat_response,
            rag::list_rag_sources,
            rag::delete_rag_source,
            rag::get_rag_source,
            rag::list_project_files,
            rag::get_project_file_content,
            settings::get_pi_settings,
            settings::save_pi_settings,
            settings::get_graphify_settings,
            settings::fetch_graphify_models,
            settings::save_graphify_settings,
            worktree::ensure_worktree,
            worktree::remove_worktree,
            pi_rpc::get_global_chat_cwd,
            pi_rpc::spawn_pi_rpc,
            pi_rpc::send_pi_command,
            pi_rpc::is_pi_session_running,
            pi_rpc::kill_pi_session,
            pi_rpc::list_pi_sessions,
            files::search_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
