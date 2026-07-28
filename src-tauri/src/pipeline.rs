use serde::{Deserialize, Serialize};
use std::{
    fs::OpenOptions,
    io::Write,
    path::Path,
    sync::{Mutex, OnceLock},
};

fn pipeline_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PipelineStage {
    pub name: String,
    #[serde(default)]
    pub ms: u64,
    pub status: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PipelineRun {
    pub run_id: String,
    #[serde(default)]
    pub session_id: String,
    pub project: String,
    pub project_type: String,
    pub date: String,
    pub status: String,
    #[serde(default)]
    pub commits: Vec<String>,
    #[serde(default)]
    pub stages: Vec<PipelineStage>,
}

#[derive(Debug, Serialize)]
pub struct PipelineData {
    pub runs: Vec<PipelineRun>,
    pub current: Option<PipelineRun>,
}

fn read_runs(raw: &str) -> Result<Vec<PipelineRun>, String> {
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .enumerate()
        .map(|(index, line)| {
            serde_json::from_str(line).map_err(|e| format!("pipeline line {}: {e}", index + 1))
        })
        .collect()
}

fn write_current(path: &Path, run: &PipelineRun) -> Result<(), String> {
    let temp = path.with_extension(format!("json.tmp.{}", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        serde_json::to_writer_pretty(&mut file, run).map_err(|e| e.to_string())?;
        file.write_all(b"\n")
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        std::fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}

fn current_run(path: &Path, run_id: &str) -> Result<PipelineRun, String> {
    let run: PipelineRun =
        serde_json::from_str(&std::fs::read_to_string(path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("pipeline current: {e}"))?;
    if run.run_id != run_id {
        return Err("pipeline run is no longer current".into());
    }
    Ok(run)
}

#[tauri::command]
pub fn start_pipeline_run(run: PipelineRun) -> Result<(), String> {
    if run.run_id.trim().is_empty()
        || run.session_id.trim().is_empty()
        || run.project.trim().is_empty()
    {
        return Err("pipeline run identity required".into());
    }
    let _guard = pipeline_lock()
        .lock()
        .map_err(|_| "pipeline lock poisoned")?;
    let dir = super::task_storage::task_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("_pipeline-current.json");
    if path.exists() {
        let current: PipelineRun =
            serde_json::from_str(&std::fs::read_to_string(&path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("pipeline current: {e}"))?;
        if current.run_id != run.run_id {
            return Err("another pipeline run is active".into());
        }
    }
    write_current(&path, &run)
}

#[tauri::command]
pub fn update_pipeline_stage(run_id: String, stage: PipelineStage) -> Result<(), String> {
    let _guard = pipeline_lock()
        .lock()
        .map_err(|_| "pipeline lock poisoned")?;
    let path = super::task_storage::task_dir()?.join("_pipeline-current.json");
    let mut run = current_run(&path, &run_id)?;
    if let Some(existing) = run.stages.iter_mut().find(|item| item.name == stage.name) {
        *existing = stage;
    } else {
        run.stages.push(stage);
    }
    write_current(&path, &run)
}

#[tauri::command]
pub fn finish_pipeline_run(run_id: String, status: String) -> Result<(), String> {
    let _guard = pipeline_lock()
        .lock()
        .map_err(|_| "pipeline lock poisoned")?;
    let dir = super::task_storage::task_dir()?;
    let current_path = dir.join("_pipeline-current.json");
    let mut run = current_run(&current_path, &run_id)?;
    run.status = status;
    let mut history = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("_pipeline-runs.jsonl"))
        .map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut history, &run).map_err(|e| e.to_string())?;
    history
        .write_all(b"\n")
        .and_then(|_| history.sync_all())
        .map_err(|e| e.to_string())?;
    std::fs::remove_file(current_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_pipeline_data() -> Result<PipelineData, String> {
    let dir = super::task_storage::task_dir()?;
    if !dir.exists() {
        return Err(format!("Task storage is missing: {}", dir.display()));
    }
    let runs_path = dir.join("_pipeline-runs.jsonl");
    let current_path = dir.join("_pipeline-current.json");
    let mut runs = if runs_path.exists() {
        read_runs(&std::fs::read_to_string(&runs_path).map_err(|e| e.to_string())?)?
    } else {
        Vec::new()
    };
    runs.sort_by(|a, b| b.date.cmp(&a.date));
    let current = if current_path.exists() {
        Some(
            serde_json::from_str(
                &std::fs::read_to_string(current_path).map_err(|e| e.to_string())?,
            )
            .map_err(|e| format!("pipeline current: {e}"))?,
        )
    } else {
        None
    };
    Ok(PipelineData { runs, current })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_jsonl_and_skips_blank_lines() {
        let runs = read_runs("{\"run_id\":\"1\",\"project\":\"demo\",\"project_type\":\"Personal\",\"date\":\"2026-01-01T00:00:00Z\",\"status\":\"done\",\"stages\":[]}\n\n").unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].project, "demo");
    }

    #[test]
    fn reports_bad_line_number() {
        let error = read_runs("{\"run_id\":\"1\",\"project\":\"demo\",\"project_type\":\"Personal\",\"date\":\"2026-01-01T00:00:00Z\",\"status\":\"done\"}\nnot-json\n").unwrap_err();
        assert!(error.contains("pipeline line 2"));
    }

    #[test]
    fn current_write_replaces_atomically() {
        let dir = std::env::temp_dir().join(format!("crc-pipeline-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("current.json");
        let run = PipelineRun {
            run_id: "run-1".into(),
            session_id: "chat-1".into(),
            project: "demo".into(),
            project_type: "Personal".into(),
            date: "2026-01-01T00:00:00Z".into(),
            status: "running".into(),
            commits: vec![],
            stages: vec![],
        };
        write_current(&path, &run).unwrap();
        assert_eq!(current_run(&path, "run-1").unwrap().session_id, "chat-1");
        assert!(current_run(&path, "other").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
