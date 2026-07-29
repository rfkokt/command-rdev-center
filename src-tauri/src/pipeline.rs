use serde::{Deserialize, Serialize};

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

#[tauri::command]
pub fn get_pipeline_data() -> Result<PipelineData, String> {
    let dir = crate::kanban::task_dir()?;
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
}
