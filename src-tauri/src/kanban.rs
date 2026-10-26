use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
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
    #[serde(skip)]
    origin: SheetOrigin,
}

/// What a Sheets-backed project read, so an empty list can say why.
#[derive(Debug, Default)]
struct SheetOrigin {
    sheets: Vec<String>,
    pics: Vec<String>,
    /// Rows read across the worksheets, before the PIC filter.
    total: usize,
    /// Status values used across those rows.
    statuses: Vec<String>,
    /// An Apps Script writer is configured for approved status changes.
    writable: bool,
}

impl KanbanProject {
    fn state(&self) -> &'static str {
        if self.error.is_some() {
            "sheet_unreachable"
        } else if self.read_only && self.origin.pics.is_empty() {
            "no_pic_selected"
        } else if self.read_only && self.origin.total > 0 && self.tasks.is_empty() {
            "no_tasks_for_pic"
        } else if self.tasks.is_empty() {
            "empty"
        } else {
            "ok"
        }
    }
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

fn is_task_file(path: &Path) -> bool {
    path.extension().and_then(|ext| ext.to_str()) == Some("json")
        && !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with('_'))
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

fn google_sheet_id(url: &str) -> Result<&str, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("Google Sheets URL is required".into());
    }
    url.split("/spreadsheets/d/")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "invalid Google Sheets URL".into())
}

fn url_gid(url: &str) -> Option<&str> {
    url.split("gid=")
        .nth(1)
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
        .filter(|gid| !gid.is_empty())
}

pub(crate) fn google_sheet_csv_url(url: &str, sheet: &str) -> Result<String, String> {
    let id = google_sheet_id(url)?;
    let gid = url_gid(url);
    if !sheet.trim().is_empty() {
        return Ok(format!(
            "https://docs.google.com/spreadsheets/d/{id}/gviz/tq?tqx=out:csv&sheet={}",
            sheet.trim().replace(' ', "%20")
        ));
    }
    Ok(format!(
        "https://docs.google.com/spreadsheets/d/{id}/export?format=csv{}",
        gid.map(|gid| format!("&gid={gid}")).unwrap_or_default()
    ))
}

fn normalized_header(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn field_index(headers: &[String], aliases: &[&str]) -> Option<usize> {
    headers
        .iter()
        .position(|header| aliases.contains(&normalized_header(header).as_str()))
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
            '"' if quoted && chars.peek() == Some(&'"') => {
                field.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => row.push(std::mem::take(&mut field)),
            '\n' if !quoted => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            '\r' if !quoted => {}
            _ => field.push(character),
        }
    }
    if quoted {
        return Err("unterminated quoted CSV field".into());
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    Ok(rows)
}

fn parse_sheet_tasks(csv_bytes: &[u8]) -> Result<Vec<KanbanTask>, String> {
    let mut rows = csv_rows(csv_bytes)?.into_iter();
    let headers = rows.next().ok_or("sheet is empty")?;
    let title = field_index(
        &headers,
        &["tugas", "task", "title", "deskripsi", "description"],
    )
    .ok_or("sheet needs a task/title column")?;
    let rows = rows.collect::<Vec<_>>();
    // Some sheets leave the number column's header as "Column 1"; accept an
    // otherwise-unnamed first column when every value in it is a number.
    let no = field_index(&headers, &["no", "nomor", "id", "key"]).or_else(|| {
        let values = rows
            .iter()
            .filter_map(|record| record.first().map(|value| value.trim()))
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        (title != 0
            && !values.is_empty()
            && values
                .iter()
                .all(|value| value.chars().all(|c| c.is_ascii_digit())))
        .then_some(0)
    });
    let pic = field_index(&headers, &["pic", "assignee", "owner", "penanggungjawab"]);
    let status_column = field_index(&headers, &["status", "state"]);
    let notes = field_index(&headers, &["catatan", "notes", "note", "keterangan"]);
    let url = field_index(&headers, &["url", "link"]);
    let mut tasks = Vec::new();
    for (index, record) in rows.into_iter().enumerate() {
        let description = record
            .get(title)
            .map(String::as_str)
            .unwrap_or_default()
            .trim();
        if description.is_empty() || description.eq_ignore_ascii_case("tugas") {
            continue;
        }
        let status = status_column
            .and_then(|column| record.get(column))
            .map(String::as_str)
            .unwrap_or_default()
            .trim();
        let status = if status.is_empty() { "Backlog" } else { status };
        let task_notes = notes
            .and_then(|column| record.get(column))
            .map(String::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let core = [Some(title), no, pic, status_column, notes, url]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        let mut extra: serde_json::Map<String, Value> = headers
            .iter()
            .enumerate()
            .filter_map(|(column, header)| {
                let key = header.trim();
                let value = record.get(column)?.trim();
                (!key.is_empty() && !value.is_empty() && !core.contains(&column))
                    .then(|| (key.to_string(), json!(value)))
            })
            .collect();
        // Sheet row (the header is row 1) so a status write targets exactly
        // this record even when task numbers repeat.
        extra.insert("_row".into(), json!(index + 2));
        tasks.push(KanbanTask {
            no: no
                .and_then(|column| record.get(column))
                .filter(|value| !value.trim().is_empty())
                .map(|value| json!(value))
                .unwrap_or_else(|| json!(index + 1)),
            url: url
                .and_then(|column| record.get(column))
                .map(String::as_str)
                .unwrap_or_default()
                .trim()
                .to_string(),
            deskripsi: description.to_string(),
            pic: pic
                .and_then(|column| record.get(column))
                .map(String::as_str)
                .unwrap_or_default()
                .trim()
                .to_string(),
            status: status.into(),
            notes: task_notes,
            session_id: None,
            extra,
        });
    }
    Ok(tasks)
}

fn curl_bytes(url: &str) -> Result<Vec<u8>, String> {
    let output = std::process::Command::new("curl")
        .args([
            "--fail",
            "--silent",
            "--show-error",
            "--location",
            "--max-time",
            "15",
            url,
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(output.stdout)
}

/// Worksheet name → gid pairs from the public edit page's bootstrap data,
/// e.g. `[1,0,\"584496886\",[{\"1\":[[0,0,\"Backlogs\"`.
fn parse_google_sheet_gids(html: &str) -> Vec<(String, String)> {
    let marker = r#"\",[{\"1\":[[0,0,\""#;
    html.match_indices(marker)
        .filter_map(|(index, _)| {
            let gid = html[..index].rsplit(r#"\""#).next()?;
            if gid.is_empty() || !gid.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let mut rest = &html[index + marker.len()..];
            let mut name = String::new();
            loop {
                if let Some(next) = rest.strip_prefix(r"\\\\") {
                    name.push('\\');
                    rest = next;
                } else if let Some(next) = rest.strip_prefix(r#"\\\""#) {
                    name.push('"');
                    rest = next;
                } else if let Some(hex) = rest.strip_prefix(r"\\u").and_then(|r| r.get(..4)) {
                    name.push(char::from_u32(u32::from_str_radix(hex, 16).ok()?)?);
                    rest = &rest[7..];
                } else if rest.starts_with(r#"\""#) {
                    break;
                } else {
                    let c = rest.chars().next()?;
                    name.push(c);
                    rest = &rest[c.len_utf8()..];
                }
            }
            Some((name, gid.to_string()))
        })
        .collect()
}

/// gid of a named worksheet, cached briefly per spreadsheet.
fn google_sheet_gid(url: &str, sheet: &str) -> Option<String> {
    type Gids = HashMap<String, (Instant, Vec<(String, String)>)>;
    static CACHE: OnceLock<Mutex<Gids>> = OnceLock::new();
    let sheet = sheet.trim();
    if sheet.is_empty() {
        return None;
    }
    let id = google_sheet_id(url).ok()?.to_string();
    let cache = CACHE.get_or_init(Default::default);
    let cached = cache
        .lock()
        .ok()?
        .get(&id)
        .and_then(|(at, gids)| (at.elapsed() < Duration::from_secs(300)).then(|| gids.clone()));
    let gids = match cached {
        Some(gids) => gids,
        None => {
            let html =
                curl_bytes(&format!("https://docs.google.com/spreadsheets/d/{id}/edit")).ok()?;
            let gids = parse_google_sheet_gids(&String::from_utf8_lossy(&html));
            cache
                .lock()
                .ok()?
                .insert(id, (Instant::now(), gids.clone()));
            gids
        }
    };
    gids.into_iter()
        .find(|(name, _)| name.trim() == sheet)
        .map(|(_, gid)| gid)
}

pub fn fetch_google_sheet_csv(url: &str, sheet: &str) -> Result<String, String> {
    // gviz infers one type per column and silently drops rows that do not
    // fit it (a real Backlogs tab lost 254 of 387 rows), so export by gid
    // whenever the worksheet's gid is known.
    let csv_url = match google_sheet_gid(url, sheet) {
        Some(gid) => format!(
            "https://docs.google.com/spreadsheets/d/{}/export?format=csv&gid={gid}",
            google_sheet_id(url)?
        ),
        None => google_sheet_csv_url(url, sheet)?,
    };
    String::from_utf8(curl_bytes(&csv_url)?).map_err(|_| "Google Sheet is not UTF-8".into())
}

fn fetch_sheet_tasks(url: &str, sheet: &str) -> Result<Vec<KanbanTask>, String> {
    let mut tasks = parse_sheet_tasks(fetch_google_sheet_csv(url, sheet)?.as_bytes())?;
    if !sheet.trim().is_empty() {
        for task in &mut tasks {
            task.extra.insert("_sheet".into(), json!(sheet.trim()));
        }
    }
    Ok(tasks)
}

fn parse_google_sheet_names(html: &str) -> Vec<String> {
    let marker = "<div class=\"goog-inline-block docs-sheet-tab-caption\">";
    let mut sheets = html
        .split(marker)
        .skip(1)
        .filter_map(|rest| rest.split("</div>").next())
        .map(|sheet| {
            sheet
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
        })
        .collect::<Vec<_>>();
    sheets.dedup();
    sheets
}

#[tauri::command(async)]
pub fn list_google_sheet_names(url: String) -> Result<Vec<String>, String> {
    let page_url = format!(
        "https://docs.google.com/spreadsheets/d/{}/edit",
        google_sheet_id(&url)?
    );
    let sheets = parse_google_sheet_names(&String::from_utf8_lossy(&curl_bytes(&page_url)?));
    if sheets.is_empty() {
        Err("No worksheets found. Make sure the spreadsheet is public.".into())
    } else {
        Ok(sheets)
    }
}

#[tauri::command(async)]
pub fn list_google_sheet_pics(url: String, sheets: Vec<String>) -> Result<Vec<String>, String> {
    let mut pics = sheets
        .iter()
        .map(String::as_str)
        .chain((sheets.is_empty()).then_some(""))
        .map(|sheet| fetch_sheet_tasks(&url, sheet))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .map(|task| task.pic)
        .filter(|pic| !pic.is_empty())
        .collect::<Vec<_>>();
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

#[tauri::command(async)]
pub fn sync_chat_task(input: ChatTaskSync) -> Result<Option<String>, String> {
    let _state = crate::state_lock::state_write_lock();
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

#[tauri::command(async)]
pub fn create_error_report_task(input: ErrorReportTask) -> Result<String, String> {
    let _state = crate::state_lock::state_write_lock();
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

#[tauri::command(async)]
pub fn update_kanban_task_status(
    project: String,
    task_no: Value,
    status: String,
) -> Result<(), String> {
    let _state = crate::state_lock::state_write_lock();
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

#[tauri::command(async)]
pub fn list_project_tasks(
    project: String,
    pic: Option<String>,
    status: Option<String>,
) -> Result<Vec<KanbanTask>, String> {
    let entry = list_kanban_tasks()?
        .into_iter()
        .find(|entry| entry.project == project);
    let tasks = match entry {
        Some(entry) => {
            if let Some(error) = entry.error {
                return Err(format!("Task source unavailable for {project}: {error}"));
            }
            entry.tasks
        }
        None => Vec::new(),
    };
    Ok(tasks
        .into_iter()
        .filter(|task| {
            pic.as_ref()
                .is_none_or(|pic| task.pic.eq_ignore_ascii_case(pic.trim()))
                && status
                    .as_ref()
                    .is_none_or(|status| task.status.eq_ignore_ascii_case(status.trim()))
        })
        .collect())
}

fn attach_references(tasks: &mut [KanbanTask], all_tasks: &[KanbanTask]) {
    for task in tasks {
        let lower = task.deskripsi.to_lowercase();
        let numbers = ["poin nomor ", "point nomor ", "poin ", "point "]
            .into_iter()
            .flat_map(|marker| {
                lower.match_indices(marker).filter_map(|(index, _)| {
                    lower[index + marker.len()..]
                        .split(|character: char| !character.is_ascii_digit())
                        .next()?
                        .parse::<i64>()
                        .ok()
                })
            })
            .collect::<Vec<_>>();
        let referenced = all_tasks
            .iter()
            .filter(|candidate| {
                numbers.iter().any(|number| {
                    candidate.no.as_i64() == Some(*number)
                        || candidate
                            .no
                            .as_str()
                            .is_some_and(|value| value == number.to_string())
                })
            })
            .collect::<Vec<_>>();
        if !referenced.is_empty() {
            // `to_value` only fails for non-serializable shapes; degrade to
            // Null instead of panicking the Tauri command.
            let value = serde_json::to_value(referenced).unwrap_or(Value::Null);
            task.extra.insert("references".into(), value);
        }
    }
}

#[tauri::command(async)]
pub fn get_project_task(project: String, task_no: String) -> Result<KanbanTask, String> {
    let task_no = task_no.trim().trim_start_matches('#');
    let mut matching = list_project_tasks(project, None, None)?
        .into_iter()
        .filter(|task| {
            task.no.as_str().is_some_and(|value| value == task_no)
                || task
                    .no
                    .as_i64()
                    .is_some_and(|value| value.to_string() == task_no)
        });
    let selected = matching.next().ok_or("task not found")?;
    if matching.next().is_some() {
        return Err("task ID is ambiguous; multiple records share this number".into());
    }
    Ok(selected)
}

/// Last task-source sync for a project (state, worksheets, PICs, syncedAt),
/// so callers can explain an empty list instead of passing on `[]`.
#[tauri::command(async)]
pub fn get_project_task_source_state(project: String) -> Result<Value, String> {
    if !valid_project(&project) {
        return Err("invalid project".into());
    }
    let path = task_dir()?
        .join(".cache")
        .join(format!("{project}.meta.json"));
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(json!({ "state": "project_not_found" }))
        }
        Err(error) => Err(error.to_string()),
    }
}

fn sheets_of(source: &crate::projects::TaskSource) -> Vec<&str> {
    if source.sheets.is_empty() {
        vec![source.sheet.as_str()]
    } else {
        source.sheets.iter().map(String::as_str).collect()
    }
}

fn writable_source(project_path: String) -> Result<crate::projects::TaskSource, String> {
    let source = crate::projects::get_project_task_source(project_path)?;
    if source.kind != "google_sheets" || source.writer_url.is_empty() {
        return Err("This project's task source is read-only. Add the Apps Script sheet writer in Project Settings → Tasks.".into());
    }
    Ok(source)
}

/// Fresh read of one Sheets task before a status write: the approval card
/// shows the current value, and the write verifies it has not changed since.
#[tauri::command(async)]
pub fn preview_task_status(
    project_path: String,
    task_no: String,
    sheet: Option<String>,
    row: Option<u64>,
) -> Result<Value, String> {
    let source = writable_source(project_path)?;
    let task_no = task_no.trim().trim_start_matches('#');
    let mut matches = Vec::new();
    for name in sheets_of(&source) {
        if sheet
            .as_deref()
            .is_some_and(|wanted| wanted.trim() != name.trim())
        {
            continue;
        }
        for task in fetch_sheet_tasks(&source.url, name)? {
            let same_no = task.no.as_str().map(str::trim) == Some(task_no)
                || task.no.as_i64().is_some_and(|no| no.to_string() == task_no);
            let task_row = task.extra.get("_row").and_then(Value::as_u64);
            if same_no && row.is_none_or(|row| task_row == Some(row)) {
                matches.push(task);
            }
        }
    }
    let task = match matches.len() {
        0 => {
            return Err(format!(
                "task {task_no} not found in the selected worksheets"
            ))
        }
        1 => matches.remove(0),
        _ => {
            let rows = matches
                .iter()
                .map(|task| {
                    format!(
                        "{} row {}",
                        task.extra
                            .get("_sheet")
                            .and_then(Value::as_str)
                            .unwrap_or("sheet"),
                        task.extra.get("_row").cloned().unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "task {task_no} is ambiguous ({rows}); pass sheet and row"
            ));
        }
    };
    if !source
        .pics
        .iter()
        .any(|pic| pic.eq_ignore_ascii_case(task.pic.trim()))
    {
        return Err(format!(
            "task {task_no} belongs to PIC \"{}\", not a PIC selected in Project Settings → Tasks",
            task.pic
        ));
    }
    Ok(json!({
        "sheet": task.extra.get("_sheet").cloned().unwrap_or(json!("")),
        "row": task.extra.get("_row").cloned().unwrap_or(Value::Null),
        "no": task_no,
        "pic": task.pic,
        "deskripsi": task.deskripsi,
        "before": task.status,
    }))
}

/// POSTs one JSON request to the Apps Script writer. The body goes through
/// stdin so the secret never appears in a process listing; curl follows the
/// script's redirect to its response with GET, as Apps Script expects.
fn post_sheet_writer(url: &str, body: &Value) -> Result<Value, String> {
    use std::io::Write as _;
    let mut child = std::process::Command::new("curl")
        .args([
            "--silent",
            "--show-error",
            "--location",
            "--max-time",
            "30",
            "--header",
            "Content-Type: application/json",
            "--data-binary",
            "@-",
            url,
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    child
        .stdin
        .take()
        .ok_or("curl stdin unavailable")?
        .write_all(body.to_string().as_bytes())
        .map_err(|error| error.to_string())?;
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_slice(&output.stdout).map_err(|_| {
        "Sheet writer did not return JSON; check that the web app is deployed with access for Anyone".into()
    })
}

/// Writes one approved status change through the Apps Script writer and
/// returns its before/after report.
#[tauri::command(async)]
pub fn write_task_status(
    project_path: String,
    sheet: String,
    row: u64,
    task_no: String,
    expected: String,
    status: String,
) -> Result<Value, String> {
    let source = writable_source(project_path)?;
    let status = status.trim();
    if status.is_empty() || status.len() > 200 {
        return Err("invalid status".into());
    }
    let mut body = json!({
        "secret": source.writer_secret,
        "action": "update",
        "no": task_no.trim().trim_start_matches('#'),
        "row": row,
        "expected": expected,
        "status": status,
        "pics": source.pics,
    });
    if sheet.trim().is_empty() {
        body["gid"] = url_gid(&source.url)
            .map(|gid| json!(gid))
            .unwrap_or(Value::Null);
    } else {
        body["sheet"] = json!(sheet.trim());
    }
    let response = post_sheet_writer(&source.writer_url, &body)?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        let mut detail = response.clone();
        if let Some(fields) = detail.as_object_mut() {
            fields.remove("ok");
        }
        return Err(format!("Sheet writer refused the change: {detail}"));
    }
    std::thread::spawn(|| {
        let _ = list_kanban_tasks();
    });
    Ok(response)
}

fn cache_project_tasks(cache: &Path, project: &KanbanProject) -> Result<(), String> {
    // A failed Sheets refresh must not replace a good snapshot with an empty list.
    if project.error.is_none() {
        write_tasks(
            &cache.join(format!("{}.json", project.project)),
            &project.tasks,
        )?;
    }
    let metadata = cache.join(format!("{}.meta.json", project.project));
    let temp = metadata.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    ));
    let synced_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    let metadata_json = json!({
        "sourceKind": if project.read_only { "google_sheets" } else { "local" },
        "error": project.error,
        "state": project.state(),
        "sheets": project.origin.sheets,
        "pics": project.origin.pics,
        "total": project.origin.total,
        "count": project.tasks.len(),
        "statuses": project.origin.statuses,
        "writable": project.origin.writable,
        "syncedAt": synced_at,
    });
    std::fs::write(
        &temp,
        serde_json::to_vec(&metadata_json).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temp, metadata).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn list_kanban_tasks() -> Result<Vec<KanbanProject>, String> {
    let dir = task_dir()?;
    let mut projects = Vec::new();
    if dir.exists() {
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if !is_task_file(&path) {
                continue;
            }
            let raw =
                std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
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
            projects.push(KanbanProject {
                project,
                tasks,
                read_only: false,
                error: None,
                origin: SheetOrigin::default(),
            });
        }
    }
    for (path, source) in crate::projects::task_sources()? {
        if source.kind != "google_sheets" {
            continue;
        }
        let project = Path::new(&path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&path)
            .to_string();
        let sheets = sheets_of(&source);
        let mut origin = SheetOrigin {
            sheets: sheets.iter().map(|sheet| sheet.to_string()).collect(),
            pics: source.pics.clone(),
            total: 0,
            statuses: Vec::new(),
            writable: !source.writer_url.is_empty(),
        };
        let result = sheets
            .into_iter()
            .map(|sheet| fetch_sheet_tasks(&source.url, sheet))
            .collect::<Result<Vec<_>, _>>()
            .map(|groups| {
                let all_tasks = groups.into_iter().flatten().collect::<Vec<_>>();
                origin.total = all_tasks.len();
                for task in &all_tasks {
                    let status = task.status.trim();
                    if !origin.statuses.iter().any(|known| known == status) {
                        origin.statuses.push(status.to_string());
                    }
                }
                let mut tasks = all_tasks
                    .iter()
                    .filter(|task| {
                        source
                            .pics
                            .iter()
                            .any(|pic| pic.eq_ignore_ascii_case(task.pic.trim()))
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                attach_references(&mut tasks, &all_tasks);
                tasks
            });
        let (tasks, error) = match result {
            Ok(tasks) => (tasks, None),
            Err(error) => (Vec::new(), Some(error)),
        };
        if let Some(existing) = projects.iter_mut().find(|entry| entry.project == project) {
            existing.tasks = tasks;
            existing.read_only = true;
            existing.error = error;
            existing.origin = origin;
        } else {
            projects.push(KanbanProject {
                project,
                tasks,
                read_only: true,
                error,
                origin,
            });
        }
    }
    projects.sort_by(|a, b| a.project.to_lowercase().cmp(&b.project.to_lowercase()));
    if let Ok(dir) = task_dir() {
        let cache = dir.join(".cache");
        if std::fs::create_dir_all(&cache).is_ok() {
            for project in &projects {
                let _ = cache_project_tasks(&cache, project);
            }
        }
    }
    Ok(projects)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_task_refresh_preserves_last_good_cache_and_records_failure() {
        let cache = std::env::temp_dir().join(format!("kern-task-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&cache);
        std::fs::create_dir_all(&cache).unwrap();
        let good = KanbanProject {
            project: "demo".into(),
            tasks: serde_json::from_value(
                json!([{ "no": 12, "deskripsi":"Full task", "status":"Backlog" }]),
            )
            .unwrap(),
            read_only: true,
            error: None,
            origin: SheetOrigin {
                sheets: vec!["Backlogs".into()],
                pics: vec!["Rifky".into()],
                total: 3,
                ..Default::default()
            },
        };
        cache_project_tasks(&cache, &good).unwrap();
        let before = std::fs::read(cache.join("demo.json")).unwrap();
        let metadata: Value =
            serde_json::from_slice(&std::fs::read(cache.join("demo.meta.json")).unwrap()).unwrap();
        assert_eq!(metadata["state"], "ok");
        assert_eq!(metadata["sheets"], json!(["Backlogs"]));
        assert_eq!(metadata["total"], 3);
        assert!(metadata["syncedAt"].as_u64().is_some());
        let failed = KanbanProject {
            project: "demo".into(),
            tasks: Vec::new(),
            read_only: true,
            error: Some("Sheets unavailable".into()),
            origin: SheetOrigin::default(),
        };
        cache_project_tasks(&cache, &failed).unwrap();
        assert_eq!(std::fs::read(cache.join("demo.json")).unwrap(), before);
        let metadata: Value =
            serde_json::from_slice(&std::fs::read(cache.join("demo.meta.json")).unwrap()).unwrap();
        assert_eq!(metadata["error"], "Sheets unavailable");
        assert_eq!(metadata["state"], "sheet_unreachable");
        std::fs::remove_dir_all(cache).unwrap();
    }

    #[test]
    fn sheet_writer_posts_json_and_follows_the_apps_script_redirect() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for response in [
                "HTTP/1.1 302 Found\r\nLocation: /echo\r\nContent-Length: 0\r\n\r\n".to_string(),
                {
                    let body = r#"{"ok":true,"before":"Testing","after":"Done"}"#;
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                        body.len()
                    )
                },
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 4096];
                loop {
                    let read = stream.read(&mut buffer).unwrap();
                    request.extend_from_slice(&buffer[..read]);
                    let text = String::from_utf8_lossy(&request);
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let length = head
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if body.len() >= length {
                            break;
                        }
                    }
                }
                seen.push(String::from_utf8_lossy(&request).into_owned());
                stream.write_all(response.as_bytes()).unwrap();
            }
            seen
        });
        let result = post_sheet_writer(
            &format!("{base}/exec"),
            &json!({ "secret": "s3cret", "status": "Done" }),
        )
        .unwrap();
        assert_eq!(result["after"], "Done");
        let seen = server.join().unwrap();
        assert!(seen[0].starts_with("POST /exec"));
        assert!(seen[0].ends_with(r#"{"secret":"s3cret","status":"Done"}"#));
        assert!(seen[1].starts_with("GET /echo"));
    }

    #[test]
    fn empty_sheet_projects_explain_why() {
        let project = |pics: Vec<String>, total| KanbanProject {
            project: "demo".into(),
            tasks: Vec::new(),
            read_only: true,
            error: None,
            origin: SheetOrigin {
                sheets: vec!["Backlogs".into()],
                pics,
                total,
                ..Default::default()
            },
        };
        assert_eq!(project(Vec::new(), 9).state(), "no_pic_selected");
        assert_eq!(project(vec!["Rifky".into()], 9).state(), "no_tasks_for_pic");
        assert_eq!(project(vec!["Rifky".into()], 0).state(), "empty");
    }

    #[test]
    fn ignores_internal_pipeline_json_files() {
        assert!(!is_task_file(Path::new("_pipeline-current.json")));
        assert!(is_task_file(Path::new("demo.json")));
        assert!(!is_task_file(Path::new("_pipeline-runs.jsonl")));
    }

    #[test]
    fn parses_sheet_columns_and_aliases_statuses() {
        let tasks = parse_sheet_tasks(b"No,Tugas,PIC,Status,Catatan\n1,\"Build, UI\",Rifki,On Progress,Ready\n2,Unknown task,,Blocked,Waiting\n").unwrap();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].status, "On Progress");
        assert_eq!(tasks[0].deskripsi, "Build, UI");
        assert_eq!(tasks[1].status, "Blocked");
        assert_eq!(tasks[1].notes, "Waiting");
        let tasks = parse_sheet_tasks(b"No,Tugas,Modul / Fitur,PIC,Priority,Status\n6,Revisi poin nomor 4,Master,Rifky,High,To Do\n").unwrap();
        assert_eq!(tasks[0].extra.get("Modul / Fitur"), Some(&json!("Master")));
        assert_eq!(tasks[0].extra.get("Priority"), Some(&json!("High")));
    }

    #[test]
    fn preserves_references_to_tasks_owned_by_other_pics() {
        let all = parse_sheet_tasks(
            b"No,Tugas,PIC,Status\n4,Detail UI,Rizal,To Do\n6,Revisi poin nomor 4,Rifky,To Do\n",
        )
        .unwrap();
        let mut selected = vec![all[1].clone()];
        attach_references(&mut selected, &all);
        assert_eq!(selected[0].extra["references"][0]["deskripsi"], "Detail UI");
    }

    #[test]
    fn parses_public_sheet_names() {
        assert_eq!(
            parse_google_sheet_names(
                r#"<div class="goog-inline-block docs-sheet-tab-caption">Sprint-0</div><div class="goog-inline-block docs-sheet-tab-caption">API &amp; Docs</div>"#
            ),
            vec!["Sprint-0", "API & Docs"]
        );
    }

    #[test]
    fn parses_sheet_gids_from_bootstrap_data() {
        let html = r#"x[1,0,\"584496886\",[{\"1\":[[0,0,\"Backlogs\"]]}],[8,0,\"277522010\",[{\"1\":[[0,0,\"Dokumen \\u0026 \\\"Akses\\\"\",1]]"#;
        assert_eq!(
            parse_google_sheet_gids(html),
            vec![
                ("Backlogs".to_string(), "584496886".to_string()),
                (r#"Dokumen & "Akses""#.to_string(), "277522010".to_string()),
            ]
        );
    }

    #[test]
    fn numeric_unnamed_first_column_is_the_task_number() {
        let tasks = parse_sheet_tasks(
            b"Column 1,Tugas,PIC,Status\n352,Draft dates,Rifky,Testing\n,Section,,\n329,Non roster,Rifky,Done\n",
        )
        .unwrap();
        assert_eq!(tasks[0].no, json!("352"));
        assert_eq!(tasks[2].no, json!("329"));
        assert!(!tasks[0].extra.contains_key("Column 1"));
        let titled = parse_sheet_tasks(b"Column 1,Tugas\nabc,Task\n").unwrap();
        assert_eq!(titled[0].no, json!(1));
    }

    #[test]
    fn converts_shared_sheet_url_to_csv_export() {
        assert_eq!(
            google_sheet_csv_url(
                "https://docs.google.com/spreadsheets/d/abc123/edit?gid=42#gid=42",
                ""
            )
            .unwrap(),
            "https://docs.google.com/spreadsheets/d/abc123/export?format=csv&gid=42"
        );
        assert_eq!(
            google_sheet_csv_url(
                "https://docs.google.com/spreadsheets/d/abc123/edit",
                "Sprint 1"
            )
            .unwrap(),
            "https://docs.google.com/spreadsheets/d/abc123/gviz/tq?tqx=out:csv&sheet=Sprint%201"
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
