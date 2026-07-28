use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
};

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

fn write_tasks(path: &Path, tasks: &[Value]) -> Result<(), String> {
    let temp = path.with_extension(format!("json.tmp.{}", std::process::id()));
    let backup = path.with_extension("json.bak");
    let result = (|| {
        let bytes = serde_json::to_vec_pretty(tasks).map_err(|e| e.to_string())?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        if path.exists() {
            std::fs::copy(path, &backup)
                .and_then(|_| OpenOptions::new().read(true).open(&backup)?.sync_all())
                .map_err(|e| e.to_string())?;
        }
        std::fs::rename(&temp, path).map_err(|e| e.to_string())?;
        OpenOptions::new()
            .read(true)
            .open(path.parent().ok_or("task file has no parent")?)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}

fn valid_project(project: &str) -> bool {
    !project.is_empty() && project != "." && project != ".." && !project.contains(['/', '\\'])
}

#[derive(Debug, Deserialize)]
pub struct ChatTaskSync {
    project: String,
    session_id: String,
    prompt: Option<String>,
    status: String,
}

#[tauri::command]
pub fn sync_chat_task(input: ChatTaskSync) -> Result<Option<String>, String> {
    if !valid_project(&input.project) || input.session_id.trim().is_empty() {
        return Err("invalid chat task identity".into());
    }
    if !["In Progress", "Review", "Done"].contains(&input.status.as_str()) {
        return Err("invalid task status".into());
    }

    let dir = task_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", input.project));
    let mut tasks = if path.exists() {
        serde_json::from_str::<Vec<Value>>(
            &std::fs::read_to_string(&path).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    let existing = tasks
        .iter_mut()
        .find(|task| task.get("session_id").and_then(Value::as_str) == Some(&input.session_id));
    if let Some(task) = existing {
        task["status"] = json!(input.status);
    } else {
        let prompt = input.prompt.as_deref().unwrap_or_default().trim();
        if prompt.is_empty() {
            return Ok(None);
        }
        tasks.push(json!({
            "no": format!("chat-{}", input.session_id.trim_start_matches("chat-")),
            "url": "",
            "deskripsi": prompt.chars().take(160).collect::<String>(),
            "pic": "agent",
            "status": input.status,
            "notes": "Created automatically from actionable chat",
            "session_id": input.session_id
        }));
    }
    write_tasks(&path, &tasks)?;
    Ok(Some(input.status))
}

#[tauri::command]
pub fn save_kanban_tasks(project: String, tasks: Vec<Value>) -> Result<(), String> {
    if !valid_project(&project) {
        return Err("invalid project name".into());
    }
    let path = task_dir()?.join(format!("{project}.json"));
    if !path.is_file() {
        return Err("task file does not exist".into());
    }
    write_tasks(&path, &tasks)
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
        let tasks = serde_json::from_str::<Vec<Value>>(&raw)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let project = path
            .file_stem()
            .and_then(|name| name.to_str())
            .ok_or_else(|| format!("invalid filename: {}", path.display()))?
            .to_owned();
        projects.push(KanbanProject { project, tasks });
    }
    projects.sort_by(|a, b| a.project.to_lowercase().cmp(&b.project.to_lowercase()));
    Ok(projects)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_keeps_backup() {
        let dir = std::env::temp_dir().join(format!("crc-kanban-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("demo.json");
        std::fs::write(&path, "[{\"status\":\"Backlog\"}]\n").unwrap();

        write_tasks(&path, &[serde_json::json!({"status": "Done"})]).unwrap();

        assert_eq!(
            std::fs::read_to_string(path.with_extension("json.bak")).unwrap(),
            "[{\"status\":\"Backlog\"}]\n"
        );
        assert_eq!(
            serde_json::from_str::<Vec<Value>>(&std::fs::read_to_string(&path).unwrap()).unwrap(),
            vec![serde_json::json!({"status": "Done"})]
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
