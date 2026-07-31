use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PipelineStage {
    pub name: String,
    #[serde(default, alias = "duration_ms", alias = "elapsed_ms")]
    pub ms: u64,
    pub status: String,
    #[serde(default)]
    pub log: String,
    #[serde(default)]
    pub failure_policy: String,
    #[serde(default)]
    pub attempts: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PipelineRun {
    pub run_id: String,
    pub project: String,
    #[serde(default)]
    pub project_path: String,
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

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PipelineStep {
    pub id: String,
    pub name: String,
    pub command: String,
    pub enabled: bool,
    pub failure_policy: String,
    pub max_attempts: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PipelineConfig {
    pub preset: String,
    pub steps: Vec<PipelineStep>,
}

struct ActiveRun {
    cancel: bool,
    process_group: Option<u32>,
    action: Option<String>,
}

static ACTIVE: OnceLock<Mutex<Option<(String, Arc<Mutex<ActiveRun>>)>>> = OnceLock::new();
static CONFIG_LOCK: Mutex<()> = Mutex::new(());
fn active() -> &'static Mutex<Option<(String, Arc<Mutex<ActiveRun>>)>> {
    ACTIVE.get_or_init(|| Mutex::new(None))
}

const MAX_RUNS: usize = 500;

fn presets(name: &str) -> Vec<PipelineStep> {
    let names: &[(&str, &str, &str)] = match name {
        "KAI" => &[
            ("status", "Status", "git status --short"),
            ("review", "Review", "git diff --check"),
            ("test", "Test", "pnpm test"),
            ("build", "Build", "pnpm build"),
            ("push", "Push", "git push"),
        ],
        "MBI" => &[
            ("status", "Status", "git status --short"),
            ("review", "Review", "git diff --check"),
            ("test", "Test", "pnpm test"),
            ("push", "Push", "git push"),
        ],
        "Personal" => &[
            ("status", "Status", "git status --short"),
            ("test", "Test", "pnpm test"),
            ("build", "Build", "pnpm build"),
            ("push", "Push", "git push"),
        ],
        _ => &[],
    };
    names
        .iter()
        .map(|(id, label, command)| PipelineStep {
            id: (*id).into(),
            name: (*label).into(),
            command: (*command).into(),
            enabled: true,
            failure_policy: if *id == "push" { "ask_user" } else { "ai_fix" }.into(),
            max_attempts: 3,
        })
        .collect()
}

fn config_path() -> PathBuf {
    crate::projects::config_path().with_file_name("pipeline-config.json")
}

fn read_configs() -> Result<HashMap<String, PipelineConfig>, String> {
    if !config_path().exists() {
        return Ok(HashMap::new());
    }
    serde_json::from_str(&std::fs::read_to_string(config_path()).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

fn write_configs(configs: &HashMap<String, PipelineConfig>) -> Result<(), String> {
    let path = config_path();
    let temp = path.with_extension("json.tmp");
    std::fs::write(
        &temp,
        serde_json::to_vec_pretty(configs).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temp, path).map_err(|e| e.to_string())
}

fn validate_config(config: &PipelineConfig) -> Result<(), String> {
    if !matches!(
        config.preset.as_str(),
        "Personal" | "KAI" | "MBI" | "Custom"
    ) {
        return Err("invalid pipeline preset".into());
    }
    if config.steps.len() > 50 {
        return Err("pipeline supports at most 50 steps".into());
    }
    for step in &config.steps {
        if step.id.trim().is_empty()
            || step.name.trim().is_empty()
            || step.command.trim().is_empty()
        {
            return Err("step id, name, and command are required".into());
        }
        if !matches!(
            step.failure_policy.as_str(),
            "ai_fix" | "ask_user" | "stop" | "continue"
        ) {
            return Err(format!("invalid failure policy for {}", step.name));
        }
        if step.max_attempts == 0 || step.max_attempts > 10 {
            return Err("max attempts must be 1..10".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_pipeline_config(
    project_path: String,
    preset: Option<String>,
) -> Result<PipelineConfig, String> {
    let project = crate::projects::ensure_path_allowed(Path::new(&project_path))?;
    let key = project.to_string_lossy().to_string();
    if preset.is_none() {
        if let Some(config) = read_configs()?.remove(&key) {
            return Ok(config);
        }
    }
    let preset = preset.unwrap_or_else(|| "Personal".into());
    Ok(PipelineConfig {
        steps: presets(&preset),
        preset,
    })
}

#[tauri::command]
pub fn save_pipeline_config(project_path: String, config: PipelineConfig) -> Result<(), String> {
    let project = crate::projects::ensure_path_allowed(Path::new(&project_path))?;
    validate_config(&config)?;
    let _lock = CONFIG_LOCK
        .lock()
        .map_err(|_| "pipeline config lock poisoned")?;
    let mut configs = read_configs()?;
    configs.insert(project.to_string_lossy().to_string(), config);
    write_configs(&configs)
}

fn read_runs(raw: &str) -> Result<Vec<PipelineRun>, String> {
    let lines: Vec<_> = raw
        .lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .collect();
    lines
        .iter()
        .enumerate()
        .filter_map(
            |(position, (index, line))| match serde_json::from_str(line) {
                Ok(run) => Some(Ok(run)),
                Err(error)
                    if position + 1 == lines.len() && !raw.ends_with('\n') && error.is_eof() =>
                {
                    None
                }
                Err(error) => Some(Err(format!("pipeline line {}: {error}", index + 1))),
            },
        )
        .collect()
}

fn task_paths() -> Result<(PathBuf, PathBuf), String> {
    let dir = crate::kanban::task_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok((
        dir.join("_pipeline-runs.jsonl"),
        dir.join("_pipeline-current.json"),
    ))
}

fn write_current(path: &Path, run: &PipelineRun) -> Result<(), String> {
    let temp = path.with_extension("json.tmp");
    std::fs::write(
        &temp,
        serde_json::to_vec_pretty(run).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temp, path).map_err(|e| e.to_string())
}

fn finish_run(runs_path: &Path, current_path: &Path, run: &PipelineRun) -> Result<(), String> {
    use fs2::FileExt;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(runs_path)
        .map_err(|e| e.to_string())?;
    file.lock_exclusive().map_err(|e| e.to_string())?;
    let mut archived = run.clone();
    for stage in &mut archived.stages {
        if stage.status != "fail" {
            stage.log.clear();
        } else if stage.log.len() > 8_000 {
            let mut start = stage.log.len() - 8_000;
            while !stage.log.is_char_boundary(start) {
                start += 1;
            }
            stage.log = stage.log[start..].to_string();
        }
    }
    file.write_all(&serde_json::to_vec(&archived).map_err(|e| e.to_string())?)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(current_path);
    Ok(())
}

fn iso_now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{seconds}")
}

fn execute(
    project: &Path,
    command: &str,
    state: &Arc<Mutex<ActiveRun>>,
    run_id: &str,
    attempt: u32,
) -> Result<(bool, String), String> {
    let output_path = std::env::temp_dir().join(format!("crc-pipeline-{run_id}-{attempt}.log"));
    let log = std::fs::File::create(&output_path).map_err(|e| e.to_string())?;
    let mut child = Command::new("sh")
        .args(["-lc", command])
        .current_dir(project)
        .process_group(0)
        .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|e| e.to_string())?;
    let group = child.id();
    {
        let mut guard = state.lock().map_err(|_| "pipeline state poisoned")?;
        guard.process_group = Some(group);
        if guard.cancel {
            terminate_group(group);
        }
    }
    let status = child.wait().map_err(|e| e.to_string());
    if let Ok(mut guard) = state.lock() {
        guard.process_group = None;
    }
    let output = std::fs::read_to_string(&output_path).unwrap_or_default();
    let _ = std::fs::remove_file(&output_path);
    let status = status?;
    let output: String = output
        .chars()
        .rev()
        .take(20_000)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let diagnostics = if status.success() {
        output
    } else {
        let exit = status
            .code()
            .map(|code| format!("exit code {code}"))
            .unwrap_or_else(|| "terminated by signal".into());
        format!(
            "Command: {command}\nWorking directory: {}\nResult: {exit}\n{}",
            project.display(),
            if output.trim().is_empty() {
                "Output: <empty>".into()
            } else {
                format!("Output:\n{output}")
            }
        )
    };
    Ok((status.success(), diagnostics))
}

fn terminate_group(group: u32) {
    let target = format!("-{group}");
    let _ = Command::new("kill").args(["-TERM", &target]).status();
    for _ in 0..20 {
        if !Command::new("kill")
            .args(["-0", &target])
            .status()
            .is_ok_and(|s| s.success())
        {
            return;
        }
        thread::sleep(std::time::Duration::from_millis(100));
    }
    let _ = Command::new("kill").args(["-KILL", &target]).status();
}

fn remove_active(project_key: &str) {
    if let Ok(mut slot) = active().lock() {
        if slot.as_ref().is_some_and(|(key, _)| key == project_key) {
            *slot = None;
        }
    }
}

fn run_pipeline_thread(
    project: PathBuf,
    project_key: String,
    project_name: String,
    config: PipelineConfig,
    state: Arc<Mutex<ActiveRun>>,
) -> Result<(), String> {
    let (runs_path, current_path) = task_paths()?;
    let mut run = PipelineRun {
        run_id: format!(
            "app-{}-{}-{}",
            std::process::id(),
            iso_now(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos()
        ),
        project: project_name.clone(),
        project_path: project_key.clone(),
        project_type: config.preset.clone(),
        date: iso_now(),
        status: "running".into(),
        commits: vec![],
        stages: config
            .steps
            .iter()
            .filter(|s| s.enabled)
            .map(|s| PipelineStage {
                name: s.name.clone(),
                ms: 0,
                status: "pending".into(),
                log: String::new(),
                failure_policy: s.failure_policy.clone(),
                attempts: 0,
            })
            .collect(),
    };
    write_current(&current_path, &run)?;
    let enabled: Vec<_> = config.steps.into_iter().filter(|s| s.enabled).collect();
    for (index, step) in enabled.iter().enumerate() {
        loop {
            if state.lock().map_err(|_| "pipeline state poisoned")?.cancel {
                run.status = "cancelled".into();
                finish_run(&runs_path, &current_path, &run)?;
                remove_active(&project_key);
                return Ok(());
            }
            run.stages[index].status = "running".into();
            run.stages[index].attempts += 1;
            write_current(&current_path, &run)?;
            let started = Instant::now();
            let result = execute(
                &project,
                &step.command,
                &state,
                &run.run_id,
                run.stages[index].attempts,
            );
            let (success, log) = match result {
                Ok(result) => result,
                Err(error) => {
                    run.stages[index].status = "fail".into();
                    run.stages[index].log = error;
                    run.status = "failed".into();
                    finish_run(&runs_path, &current_path, &run)?;
                    remove_active(&project_key);
                    return Ok(());
                }
            };
            run.stages[index].ms += started.elapsed().as_millis() as u64;
            run.stages[index].log = log;
            if success {
                run.stages[index].status = "pass".into();
                write_current(&current_path, &run)?;
                break;
            }
            run.stages[index].status = "fail".into();
            write_current(&current_path, &run)?;
            if step.failure_policy == "continue" {
                break;
            }
            if step.failure_policy == "stop" {
                run.status = "failed".into();
                finish_run(&runs_path, &current_path, &run)?;
                remove_active(&project_key);
                return Ok(());
            }
            loop {
                thread::sleep(std::time::Duration::from_millis(200));
                let mut guard = state.lock().map_err(|_| "pipeline state poisoned")?;
                if guard.cancel {
                    drop(guard);
                    run.status = "cancelled".into();
                    finish_run(&runs_path, &current_path, &run)?;
                    remove_active(&project_key);
                    return Ok(());
                }
                match guard.action.take().as_deref() {
                    Some("retry") if run.stages[index].attempts < step.max_attempts => break,
                    Some("retry") => {
                        drop(guard);
                        run.status = "failed".into();
                        run.stages[index].log =
                            format!("Maximum {} attempts reached", step.max_attempts);
                        finish_run(&runs_path, &current_path, &run)?;
                        remove_active(&project_key);
                        return Ok(());
                    }
                    Some("skip") => {
                        run.stages[index].status = "skip".into();
                        write_current(&current_path, &run)?;
                        break;
                    }
                    _ => continue,
                }
            }
            if run.stages[index].status == "skip" {
                break;
            }
        }
    }
    run.status = if run.stages.iter().any(|s| s.status == "fail") {
        "failed"
    } else {
        "done"
    }
    .into();
    finish_run(&runs_path, &current_path, &run)?;
    remove_active(&project_key);
    Ok(())
}

#[tauri::command]
pub fn start_pipeline(
    project_path: String,
    execution_cwd: Option<String>,
) -> Result<String, String> {
    let project = crate::projects::ensure_path_allowed(Path::new(&project_path))?;
    let execution = if let Some(cwd) = execution_cwd.filter(|cwd| !cwd.trim().is_empty()) {
        crate::projects::ensure_pipeline_cwd(&project, Path::new(&cwd))?
    } else {
        project.clone()
    };
    let project_name = project
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("invalid project name")?
        .to_string();
    let config = get_pipeline_config(project.to_string_lossy().to_string(), None)?;
    validate_config(&config)?;
    if !config.steps.iter().any(|step| step.enabled) {
        return Err("pipeline has no enabled steps".into());
    }
    let project_key = project.to_string_lossy().to_string();
    let state = Arc::new(Mutex::new(ActiveRun {
        cancel: false,
        process_group: None,
        action: None,
    }));
    {
        let mut slot = active().lock().map_err(|_| "pipeline registry poisoned")?;
        if slot.is_some() {
            return Err("another pipeline is already running".into());
        }
        *slot = Some((project_key.clone(), state.clone()));
    }
    let name = project_name.clone();
    let key = project_key.clone();
    thread::spawn(move || {
        if run_pipeline_thread(execution, key.clone(), name, config, state).is_err() {
            if let Ok((_, current_path)) = task_paths() {
                let _ = std::fs::remove_file(current_path);
            }
            remove_active(&key);
        }
    });
    Ok(project_name)
}

fn control_pipeline(project_path: String, action: &str) -> Result<(), String> {
    let project = crate::projects::ensure_path_allowed(Path::new(&project_path))?;
    let key = project.to_string_lossy().to_string();
    let state = active()
        .lock()
        .map_err(|_| "pipeline registry poisoned")?
        .as_ref()
        .filter(|(active_key, _)| active_key == &key)
        .map(|(_, state)| state.clone())
        .ok_or("pipeline is not active for this project")?;
    let mut guard = state.lock().map_err(|_| "pipeline state poisoned")?;
    if action == "cancel" {
        guard.cancel = true;
        if let Some(group) = guard.process_group {
            thread::spawn(move || terminate_group(group));
        }
    } else {
        guard.action = Some(action.into());
    }
    Ok(())
}

#[tauri::command]
pub fn cancel_pipeline(project_path: String) -> Result<(), String> {
    control_pipeline(project_path, "cancel")
}
#[tauri::command]
pub fn retry_pipeline_step(project_path: String) -> Result<(), String> {
    control_pipeline(project_path, "retry")
}
#[tauri::command]
pub fn skip_pipeline_step(project_path: String) -> Result<(), String> {
    control_pipeline(project_path, "skip")
}

#[tauri::command]
pub fn get_pipeline_data(project_path: Option<String>) -> Result<PipelineData, String> {
    let project_key = project_path
        .map(|path| {
            crate::projects::ensure_path_allowed(Path::new(&path))
                .map(|p| p.to_string_lossy().to_string())
        })
        .transpose()?;
    let (runs_path, current_path) = task_paths()?;
    let mut runs = if runs_path.exists() {
        read_runs(&std::fs::read_to_string(&runs_path).map_err(|e| e.to_string())?)?
    } else {
        vec![]
    };
    if let Some(key) = &project_key {
        runs.retain(|run| &run.project_path == key);
    }
    runs.sort_by(|a, b| b.date.cmp(&a.date));
    runs.truncate(MAX_RUNS);
    let current = if current_path.exists() {
        let run: PipelineRun = serde_json::from_str(
            &std::fs::read_to_string(current_path).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("pipeline current: {e}"))?;
        project_key
            .as_ref()
            .is_none_or(|key| &run.project_path == key)
            .then_some(run)
    } else {
        None
    };
    Ok(PipelineData { runs, current })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn presets_have_safe_failure_policies() {
        let p = presets("KAI");
        assert_eq!(p.last().unwrap().failure_policy, "ask_user");
        assert!(p[..p.len() - 1]
            .iter()
            .all(|s| s.failure_policy == "ai_fix"));
    }
    #[test]
    fn rejects_invalid_policy() {
        let mut config = PipelineConfig {
            preset: "Custom".into(),
            steps: presets("Personal"),
        };
        config.steps[0].failure_policy = "oops".into();
        assert!(validate_config(&config).is_err());
    }
    #[test]
    fn parses_legacy_duration_alias() {
        let runs = read_runs("{\"run_id\":\"1\",\"project\":\"demo\",\"project_type\":\"Personal\",\"date\":\"1\",\"status\":\"done\",\"stages\":[{\"name\":\"build\",\"duration_ms\":10,\"status\":\"pass\"}]}\n").unwrap();
        assert_eq!(runs[0].stages[0].ms, 10);
    }

    #[test]
    fn preset_request_replaces_saved_shape() {
        let config = PipelineConfig {
            preset: "KAI".into(),
            steps: presets("KAI"),
        };
        assert_eq!(config.steps.last().unwrap().name, "Push");
        assert_eq!(config.steps.len(), 5);
    }

    #[test]
    fn failed_command_without_output_has_actionable_diagnostics() {
        let state = Arc::new(Mutex::new(ActiveRun {
            cancel: false,
            process_group: None,
            action: None,
        }));
        let (success, diagnostics) =
            execute(Path::new("/tmp"), "exit 7", &state, "diagnostic-test", 1).unwrap();
        assert!(!success);
        assert!(diagnostics.contains("Command: exit 7"));
        assert!(diagnostics.contains("Working directory: /tmp"));
        assert!(diagnostics.contains("Result: exit code 7"));
        assert!(diagnostics.contains("Output: <empty>"));
    }

    #[test]
    fn archived_run_keeps_bounded_failure_diagnostics() {
        let mut stage = PipelineStage {
            name: "build".into(),
            ms: 1,
            status: "fail".into(),
            log: "x".repeat(9_000),
            failure_policy: "stop".into(),
            attempts: 1,
        };
        if stage.log.len() > 8_000 {
            let mut start = stage.log.len() - 8_000;
            while !stage.log.is_char_boundary(start) {
                start += 1;
            }
            stage.log = stage.log[start..].to_string();
        }
        assert!(stage.log.len() <= 8_000);
    }
}
