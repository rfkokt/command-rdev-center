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
    #[serde(default)]
    read_only: bool,
    #[serde(default)]
    error: Option<String>,
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

pub(crate) fn google_sheet_csv_url(url: &str, sheet: &str) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("Google Sheets URL is required".into());
    }
    let marker = "/spreadsheets/d/";
    let id = url.split(marker).nth(1).and_then(|rest| rest.split('/').next())
        .filter(|id| !id.is_empty())
        .ok_or("invalid Google Sheets URL")?;
    let gid = url.split("gid=").nth(1).and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next()).filter(|gid| !gid.is_empty());
    let selection = if sheet.trim().is_empty() {
        gid.map(|gid| format!("&gid={gid}")).unwrap_or_default()
    } else {
        format!("&sheet={}", sheet.trim().replace(' ', "%20"))
    };
    Ok(format!("https://docs.google.com/spreadsheets/d/{id}/export?format=csv{selection}"))
}

fn normalized_header(value: &str) -> String {
    value.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

fn field_index(headers: &[String], aliases: &[&str]) -> Option<usize> {
    headers.iter().position(|header| aliases.contains(&normalized_header(header).as_str()))
}

fn csv_rows(bytes: &[u8]) -> Result<Vec<Vec<String>>, String> {
    let text = std::str::from_utf8(bytes).map_err(|error| error.to_string())?;
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '"' if quoted && chars.peek() == Some(&'"') => { field.push('"'); chars.next(); }
            '"' => quoted = !quoted,
            ',' if !quoted => row.push(std::mem::take(&mut field)),
            '\n' if !quoted => { row.push(std::mem::take(&mut field)); rows.push(std::mem::take(&mut row)); }
            '\r' if !quoted => {}
            _ => field.push(character),
        }
    }
    if quoted { return Err("unterminated quoted CSV field".into()); }
    if !field.is_empty() || !row.is_empty() { row.push(field); rows.push(row); }
    Ok(rows)
}

fn parse_sheet_tasks(csv_bytes: &[u8]) -> Result<Vec<KanbanTask>, String> {
    let mut rows = csv_rows(csv_bytes)?.into_iter();
    let headers = rows.next().ok_or("sheet is empty")?;
    let title = field_index(&headers, &["tugas", "task", "title", "deskripsi", "description"])
        .ok_or("sheet needs a task/title column")?;
    let no = field_index(&headers, &["no", "nomor", "id", "key"]);
    let pic = field_index(&headers, &["pic", "assignee", "owner", "penanggungjawab"]);
    let status = field_index(&headers, &["status", "state"]);
    let notes = field_index(&headers, &["catatan", "notes", "note", "keterangan"]);
    let url = field_index(&headers, &["url", "link"]);
    let mut tasks = Vec::new();
    for (index, record) in rows.enumerate() {
        let description = record.get(title).map(String::as_str).unwrap_or_default().trim();
        if description.is_empty() || description.eq_ignore_ascii_case("tugas") {
            continue;
        }
        let status = status.and_then(|column| record.get(column)).map(String::as_str).unwrap_or_default().trim();
        let status = if status.is_empty() { "Backlog" } else { status };
        let task_notes = notes.and_then(|column| record.get(column)).map(String::as_str).unwrap_or_default().trim().to_string();
        tasks.push(KanbanTask {
            no: no.and_then(|column| record.get(column)).filter(|value| !value.trim().is_empty()).map(|value| json!(value)).unwrap_or_else(|| json!(index + 1)),
            url: url.and_then(|column| record.get(column)).map(String::as_str).unwrap_or_default().trim().to_string(),
            deskripsi: description.to_string(),
            pic: pic.and_then(|column| record.get(column)).map(String::as_str).unwrap_or_default().trim().to_string(),
            status: status.into(),
            notes: task_notes,
            session_id: None,
            extra: serde_json::Map::new(),
        });
    }
    Ok(tasks)
}

fn fetch_sheet_tasks(url: &str, sheet: &str) -> Result<Vec<KanbanTask>, String> {
    let csv_url = google_sheet_csv_url(url, sheet)?;
    let output = std::process::Command::new("curl").args(["--fail", "--silent", "--show-error", "--location", "--max-time", "15", &csv_url]).output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    parse_sheet_tasks(&output.stdout)
}

#[tauri::command]
pub fn list_google_sheet_pics(url: String, sheets: Vec<String>) -> Result<Vec<String>, String> {
    let mut pics = sheets.iter().map(String::as_str).chain((sheets.is_empty()).then_some(""))
        .map(|sheet| fetch_sheet_tasks(&url, sheet))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter().flatten().map(|task| task.pic).filter(|pic| !pic.is_empty()).collect::<Vec<_>>();
    pics.sort_by_key(|pic| pic.to_lowercase());
    pics.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    Ok(pics)
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
pub fn list_project_tasks(project: String, pic: Option<String>, status: Option<String>) -> Result<Vec<KanbanTask>, String> {
    let tasks = list_kanban_tasks()?.into_iter().find(|entry| entry.project == project).map(|entry| entry.tasks).unwrap_or_default();
    Ok(tasks.into_iter().filter(|task| pic.as_ref().is_none_or(|pic| task.pic.eq_ignore_ascii_case(pic.trim())) && status.as_ref().is_none_or(|status| task.status.eq_ignore_ascii_case(status.trim()))).collect())
}

#[tauri::command]
pub fn get_project_task(project: String, task_no: String) -> Result<KanbanTask, String> {
    list_project_tasks(project, None, None)?.into_iter().find(|task| task.no.as_str().is_some_and(|value| value == task_no) || task.no.as_i64().is_some_and(|value| value.to_string() == task_no)).ok_or("task not found".into())
}

#[tauri::command]
pub fn list_kanban_tasks() -> Result<Vec<KanbanProject>, String> {
    let dir = task_dir()?;
    let mut projects = Vec::new();
    if dir.exists() {
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
            projects.push(KanbanProject { project, tasks, read_only: false, error: None });
        }
    }
    for (path, source) in crate::projects::task_sources()? {
        if source.kind != "google_sheets" { continue; }
        let project = Path::new(&path).file_name().and_then(|name| name.to_str()).unwrap_or(&path).to_string();
        let sheets = if source.sheets.is_empty() { vec![source.sheet.as_str()] } else { source.sheets.iter().map(String::as_str).collect() };
        let result = sheets.into_iter().map(|sheet| fetch_sheet_tasks(&source.url, sheet)).collect::<Result<Vec<_>, _>>()
            .map(|groups| groups.into_iter().flatten().filter(|task| source.pics.iter().any(|pic| pic.eq_ignore_ascii_case(task.pic.trim()))).collect());
        let (tasks, error) = match result { Ok(tasks) => (tasks, None), Err(error) => (Vec::new(), Some(error)) };
        if let Some(existing) = projects.iter_mut().find(|entry| entry.project == project) {
            existing.tasks = tasks;
            existing.read_only = true;
            existing.error = error;
        } else {
            projects.push(KanbanProject { project, tasks, read_only: true, error });
        }
    }
    projects.sort_by(|a, b| a.project.to_lowercase().cmp(&b.project.to_lowercase()));
    if let Ok(dir) = task_dir() {
        let cache = dir.join(".cache");
        if std::fs::create_dir_all(&cache).is_ok() {
            for project in &projects {
                if let Ok(bytes) = serde_json::to_vec_pretty(&project.tasks) {
                    let _ = std::fs::write(cache.join(format!("{}.json", project.project)), bytes);
                }
            }
        }
    }
    Ok(projects)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sheet_columns_and_aliases_statuses() {
        let tasks = parse_sheet_tasks(b"No,Tugas,PIC,Status,Catatan\n1,\"Build, UI\",Rifki,On Progress,Ready\n2,Unknown task,,Blocked,Waiting\n").unwrap();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].status, "On Progress");
        assert_eq!(tasks[0].deskripsi, "Build, UI");
        assert_eq!(tasks[1].status, "Blocked");
        assert_eq!(tasks[1].notes, "Waiting");
    }

    #[test]
    fn converts_shared_sheet_url_to_csv_export() {
        assert_eq!(
            google_sheet_csv_url("https://docs.google.com/spreadsheets/d/abc123/edit?gid=42#gid=42", "").unwrap(),
            "https://docs.google.com/spreadsheets/d/abc123/export?format=csv&gid=42"
        );
        assert_eq!(
            google_sheet_csv_url("https://docs.google.com/spreadsheets/d/abc123/edit", "Sprint 1").unwrap(),
            "https://docs.google.com/spreadsheets/d/abc123/export?format=csv&sheet=Sprint%201"
        );
        assert!(google_sheet_csv_url("https://example.com/not-a-sheet", "").is_err());
    }

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
