use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct KanbanTask {
    no: Value,
    #[serde(default)]
    url: String,
    #[serde(default)]
    deskripsi: String,
    #[serde(default)]
    pic: String,
    status: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(flatten)]
    extra: serde_json::Map<String, Value>,
}

impl KanbanTask {
    fn validate(&self) -> Result<(), String> {
        if self.no.is_null() {
            return Err("task requires no".into());
        }
        if !["Backlog", "In Progress", "Review", "Done"]
            .iter()
            .any(|status| status.eq_ignore_ascii_case(self.status.trim()))
        {
            return Err(format!("invalid task status: {}", self.status));
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
pub struct KanbanProject {
    project: String,
    tasks: Vec<KanbanTask>,
}

pub(crate) fn task_dir() -> Result<PathBuf, String> {
    crate::projects::backlog_dir()
}

fn lock_tasks(dir: &Path) -> Result<File, String> {
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(dir.join(".kanban.lock"))
        .map_err(|e| e.to_string())?;
    lock.lock_exclusive().map_err(|e| e.to_string())?;
    Ok(lock)
}

fn read_tasks(path: &Path) -> Result<Vec<KanbanTask>, String> {
    let tasks: Vec<KanbanTask> =
        serde_json::from_str(&std::fs::read_to_string(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    for task in &tasks {
        task.validate()?;
    }
    Ok(tasks)
}

fn write_tasks(path: &Path, tasks: &[KanbanTask]) -> Result<(), String> {
    let temp = path.with_extension(format!(
        "json.tmp.{}.{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    ));
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

#[derive(Debug, Deserialize)]
pub struct ErrorReportTask {
    project: String,
    session_id: String,
    title: String,
    root_cause: String,
    prevention: String,
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
    let _lock = lock_tasks(&dir)?;
    let path = dir.join(format!("{}.json", input.project));
    let mut tasks = if path.exists() {
        read_tasks(&path)?
    } else {
        Vec::new()
    };
    let existing = tasks
        .iter_mut()
        .find(|task| task.session_id.as_deref() == Some(&input.session_id));
    if let Some(task) = existing {
        task.status = input.status.clone();
    } else {
        let prompt = input.prompt.as_deref().unwrap_or_default().trim();
        if prompt.is_empty() {
            return Ok(None);
        }
        tasks.push(KanbanTask {
            no: json!(format!(
                "chat-{}",
                input.session_id.trim_start_matches("chat-")
            )),
            url: String::new(),
            deskripsi: prompt.chars().take(160).collect(),
            pic: "agent".into(),
            status: input.status.clone(),
            notes: "Created automatically from actionable chat".into(),
            session_id: Some(input.session_id),
            extra: serde_json::Map::new(),
        });
    }
    write_tasks(&path, &tasks)?;
    Ok(Some(input.status))
}

#[tauri::command]
pub fn create_error_report_task(input: ErrorReportTask) -> Result<String, String> {
    if !valid_project(&input.project) || input.session_id.trim().is_empty() {
        return Err("invalid error report identity".into());
    }
    let title = input.title.trim();
    let root_cause = input.root_cause.trim();
    let prevention = input.prevention.trim();
    if title.is_empty() || root_cause.is_empty() || prevention.is_empty() {
        return Err("error report title, root cause, and prevention are required".into());
    }
    if [title, root_cause, prevention]
        .iter()
        .any(|field| field.len() > 4_000)
    {
        return Err("error report fields are too long".into());
    }
    let dir = task_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let _lock = lock_tasks(&dir)?;
    let path = dir.join(format!("{}.json", input.project));
    let mut tasks = if path.exists() {
        read_tasks(&path)?
    } else {
        Vec::new()
    };
    let description = format!("Error: {title}");
    let notes = format!("Root cause: {root_cause}\n\nPrevention: {prevention}");
    if tasks
        .iter()
        .any(|task| task.deskripsi == description && task.notes == notes)
    {
        return Ok("existing Backlog task".into());
    }
    tasks.push(KanbanTask {
        no: json!(format!(
            "error-{}-{}",
            input.session_id.trim_start_matches("chat-"),
            tasks.len() + 1
        )),
        url: String::new(),
        deskripsi: description,
        pic: "agent".into(),
        status: "Backlog".into(),
        notes,
        session_id: Some(input.session_id),
        extra: serde_json::Map::new(),
    });
    write_tasks(&path, &tasks)?;
    Ok("Backlog".into())
}

fn update_task_status_at(path: &Path, task_no: &Value, status: &str) -> Result<(), String> {
    if !["Backlog", "In Progress", "Review", "Done"].contains(&status) {
        return Err("invalid task status".into());
    }
    let mut tasks = read_tasks(path)?;
    let task = tasks
        .iter_mut()
        .find(|task| &task.no == task_no)
        .ok_or("task no longer exists")?;
    task.status = status.into();
    write_tasks(path, &tasks)
}

#[tauri::command]
pub fn update_kanban_task_status(
    project: String,
    task_no: Value,
    status: String,
) -> Result<(), String> {
    if !valid_project(&project) || task_no.is_null() {
        return Err("invalid task identity".into());
    }
    let dir = task_dir()?;
    let _lock = lock_tasks(&dir)?;
    let path = dir.join(format!("{project}.json"));
    if !path.is_file() {
        return Err("task file does not exist".into());
    }
    update_task_status_at(&path, &task_no, &status)
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
        let tasks = serde_json::from_str::<Vec<KanbanTask>>(&raw)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        for task in &tasks {
            task.validate()
                .map_err(|e| format!("{}: {e}", path.display()))?;
        }
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
    fn status_update_preserves_concurrently_added_tasks() {
        let dir = std::env::temp_dir().join(format!("crc-kanban-update-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("demo.json");
        std::fs::write(
            &path,
            r#"[{"no":1,"deskripsi":"One","status":"Backlog"},{"no":2,"deskripsi":"Two","status":"In Progress"}]"#,
        )
        .unwrap();

        update_task_status_at(&path, &json!(1), "Done").unwrap();

        let tasks = read_tasks(&path).unwrap();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].status, "Done");
        assert_eq!(tasks[1].no, json!(2));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn status_update_preserves_unknown_fields() {
        let dir = std::env::temp_dir().join(format!("crc-kanban-fields-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("demo.json");
        std::fs::write(&path, r#"[{"no":1,"status":"Backlog","custom":true}]"#).unwrap();

        update_task_status_at(&path, &json!(1), "Done").unwrap();

        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw[0]["custom"], true);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_write_keeps_backup() {
        let dir = std::env::temp_dir().join(format!("crc-kanban-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("demo.json");
        std::fs::write(&path, "[{\"status\":\"Backlog\"}]\n").unwrap();

        let task = KanbanTask {
            no: json!(1),
            url: String::new(),
            deskripsi: "Demo".into(),
            pic: String::new(),
            status: "Done".into(),
            notes: String::new(),
            session_id: None,
            extra: serde_json::Map::new(),
        };
        write_tasks(&path, &[task]).unwrap();

        assert_eq!(
            std::fs::read_to_string(path.with_extension("json.bak")).unwrap(),
            "[{\"status\":\"Backlog\"}]\n"
        );
        assert_eq!(read_tasks(&path).unwrap()[0].status, "Done");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
