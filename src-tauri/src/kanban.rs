use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, Serialize)]
pub struct KanbanProject {
    project: String,
    tasks: Vec<Value>,
}

fn task_dir() -> Result<PathBuf, String> {
    let root = super::projects::project_root()?;
    let parent = root.parent().ok_or("project root has no parent")?;
    Ok(parent.join("Task All Project"))
}

#[tauri::command]
pub fn list_kanban_tasks() -> Result<Vec<KanbanProject>, String> {
    let dir = task_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut projects = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let raw = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let tasks = serde_json::from_str::<Vec<Value>>(&raw).map_err(|e| format!("{}: {e}", path.display()))?;
        let project = path.file_stem().and_then(|name| name.to_str()).ok_or_else(|| format!("invalid filename: {}", path.display()))?.to_owned();
        projects.push(KanbanProject { project, tasks });
    }
    projects.sort_by(|a, b| a.project.to_lowercase().cmp(&b.project.to_lowercase()));
    Ok(projects)
}
