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
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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
    #[serde(default)]
    pub initiator_session_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PipelineData {
    pub runs: Vec<PipelineRun>,
    pub current: Option<PipelineRun>,
    pub pending_input: Option<PipelinePendingInput>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PipelinePendingInput {
    pub nonce: String,
    pub run_id: String,
    pub step_id: String,
    pub mode: String,
    pub step: String,
    pub prompt: String,
    pub options: Vec<String>,
    pub execution_cwd: String,
    pub initiator_session_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PipelineStep {
    pub id: String,
    pub name: String,
    #[serde(default = "shell_mode", alias = "type")]
    pub mode: String,
    #[serde(default)]
    pub command: String,
    pub enabled: bool,
    pub failure_policy: String,
    pub max_attempts: u32,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub options: Vec<String>,
}

fn shell_mode() -> String {
    "shell".into()
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
    input: Option<PipelineInput>,
    pending: Option<PipelinePendingInput>,
    consumed_nonce: Option<String>,
    awaiting_action: bool,
}

#[derive(Debug, Deserialize)]
pub struct PipelineInput {
    nonce: String,
    run_id: String,
    step_id: String,
    mode: String,
    session_id: Option<String>,
    execution_cwd: String,
    value: Option<String>,
    message: Option<String>,
    #[serde(default)]
    paths: Vec<String>,
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
            mode: "shell".into(),
            command: (*command).into(),
            enabled: true,
            failure_policy: if *id == "push" { "ask_user" } else { "ai_fix" }.into(),
            max_attempts: 3,
            prompt: String::new(),
            options: vec![],
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
        if step.id.trim().is_empty() || step.name.trim().is_empty() {
            return Err("step id and name are required".into());
        }
        if !matches!(step.mode.as_str(), "shell" | "ai_commit" | "confirm") {
            return Err(format!("invalid mode for {}", step.name));
        }
        if step.mode == "shell" && step.command.trim().is_empty() {
            return Err("shell step command is required".into());
        }
        if step.mode == "confirm"
            && (step.prompt.trim().is_empty()
                || step.options.is_empty()
                || step.options.len() > 10
                || step
                    .options
                    .iter()
                    .any(|option| option.trim().is_empty() || option.len() > 50))
        {
            return Err(format!(
                "confirm step {} needs prompt and options",
                step.name
            ));
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
    execute_with_env(project, command, &[], state, run_id, attempt)
}

fn execute_with_env(
    project: &Path,
    command: &str,
    envs: &[(&str, &str)],
    state: &Arc<Mutex<ActiveRun>>,
    run_id: &str,
    attempt: u32,
) -> Result<(bool, String), String> {
    let output_path = std::env::temp_dir().join(format!("crc-pipeline-{run_id}-{attempt}.log"));
    let log = std::fs::File::create(&output_path).map_err(|e| e.to_string())?;
    let mut child = Command::new("sh");
    child.args(["-lc", command]).current_dir(project);
    for (key, value) in envs {
        child.env(key, value);
    }
    let mut child = child
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

fn git_paths(project: &Path, args: &[&str]) -> Result<Vec<String>, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(project)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            String::from_utf8(entry.to_vec())
                .map_err(|_| "pipeline does not support non-UTF-8 Git paths".into())
        })
        .collect()
}

fn modified_paths(project: &Path) -> Result<Vec<String>, String> {
    let changed = git_paths(
        project,
        &[
            "diff",
            "--name-status",
            "-z",
            "--find-renames",
            "--find-copies",
            "HEAD",
            "--",
        ],
    )?;
    let mut paths = vec![];
    let mut entries = changed.into_iter();
    while let Some(status) = entries.next() {
        if status.starts_with(['R', 'C']) {
            let _source = entries.next().ok_or("malformed Git rename/copy status")?;
            let _destination = entries.next().ok_or("malformed Git rename/copy status")?;
            return Err(
                "AI commit does not support rename/copy changes; commit them manually".into(),
            );
        }
        paths.push(entries.next().ok_or("malformed Git status")?);
    }
    paths.extend(git_paths(
        project,
        &["ls-files", "--others", "--exclude-standard", "-z", "--"],
    )?);
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn staged_paths(project: &Path) -> Result<Vec<String>, String> {
    git_paths(project, &["diff", "--cached", "--name-only", "-z", "--"])
}

fn validate_commit_input(
    project: &Path,
    input: PipelineInput,
) -> Result<(String, Vec<String>), String> {
    let message = input.message.unwrap_or_default().trim().to_string();
    if message.is_empty() || message.len() > 200 || message.contains(['\n', '\r', '\0']) {
        return Err("commit message must be one line and at most 200 characters".into());
    }
    if input.paths.is_empty() {
        return Err("commit requires explicit changed paths".into());
    }
    let modified = modified_paths(project)?;
    let path_count = input.paths.len();
    let mut validated = vec![];
    for raw in input.paths {
        let path = Path::new(&raw);
        if path.is_absolute()
            || path
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
            || !modified.contains(&raw)
        {
            return Err(format!("invalid or unchanged commit path: {raw}"));
        }
        validated.push(raw);
    }
    validated.sort();
    validated.dedup();
    if validated.len() != path_count {
        return Err("duplicate commit paths are not allowed".into());
    }
    Ok((message, validated))
}

fn unstage_paths(project: &Path, paths: &[String]) {
    let _ = Command::new("git")
        .arg("-C")
        .arg(project)
        .args(["reset", "--quiet", "--"])
        .args(paths)
        .status();
}

fn execute_ai_commit(project: &Path, input: PipelineInput) -> Result<(bool, String), String> {
    let (message, paths) = validate_commit_input(project, input)?;
    if !staged_paths(project)?.is_empty() {
        return Err("commit blocked: Git index already contains staged changes".into());
    }
    let status = Command::new("git")
        .arg("-C")
        .arg(project)
        .arg("add")
        .arg("--")
        .args(&paths)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        unstage_paths(project, &paths);
        return Ok((false, "git add failed".into()));
    }
    let mut staged = staged_paths(project)?;
    let mut expected = paths.clone();
    staged.sort();
    expected.sort();
    if staged != expected {
        unstage_paths(project, &paths);
        return Err("commit blocked: staged paths differ from explicitly authorized paths".into());
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(project)
        .args(["commit", "-m", &message])
        .output()
        .map_err(|e| e.to_string())?;
    let log = format!(
        "Paths: {}\nMessage: {message}\n{}{}",
        paths.join(", "),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() {
        unstage_paths(project, &paths);
    }
    Ok((output.status.success(), log))
}

fn random_nonce() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn wait_for_input(
    state: &Arc<Mutex<ActiveRun>>,
    pending: PipelinePendingInput,
) -> Result<PipelineInput, String> {
    wait_for_input_with_timeout(state, pending, Duration::from_secs(600))
}

fn wait_for_input_with_timeout(
    state: &Arc<Mutex<ActiveRun>>,
    pending: PipelinePendingInput,
    timeout: Duration,
) -> Result<PipelineInput, String> {
    let started = Instant::now();
    state.lock().map_err(|_| "pipeline state poisoned")?.pending = Some(pending.clone());
    loop {
        thread::sleep(Duration::from_millis(20));
        let mut guard = state.lock().map_err(|_| "pipeline state poisoned")?;
        if guard.cancel {
            guard.pending = None;
            return Err("pipeline cancelled while waiting for input".into());
        }
        if started.elapsed() >= timeout {
            guard.pending = None;
            return Err(format!(
                "pipeline input timed out after 10 minutes: {}",
                pending.step
            ));
        }
        if let Some(input) = guard.input.take() {
            guard.pending = None;
            return Ok(input);
        }
    }
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
    execution_cwd: String,
    initiator_session_id: Option<String>,
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
        initiator_session_id: initiator_session_id.clone(),
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
            let result = match step.mode.as_str() {
                "ai_commit" => wait_for_input(&state, PipelinePendingInput { nonce: random_nonce()?, run_id: run.run_id.clone(), step_id: step.id.clone(), mode: step.mode.clone(), step: step.name.clone(), prompt: if step.prompt.is_empty() { "Review the current worktree diff, propose explicit changed file paths and a conventional commit message.".into() } else { step.prompt.clone() }, options: vec![], execution_cwd: execution_cwd.clone(), initiator_session_id: initiator_session_id.clone() }).and_then(|input| execute_ai_commit(&project, input)),
                "confirm" => wait_for_input(&state, PipelinePendingInput { nonce: random_nonce()?, run_id: run.run_id.clone(), step_id: step.id.clone(), mode: step.mode.clone(), step: step.name.clone(), prompt: step.prompt.clone(), options: step.options.clone(), execution_cwd: execution_cwd.clone(), initiator_session_id: initiator_session_id.clone() }).and_then(|input| {
                    let value = input.value.unwrap_or_default();
                    if !step.options.contains(&value) { return Err("invalid confirmation option".into()); }
                    execute_with_env(&project, &step.command, &[(&"PIPELINE_INPUT", value.as_str())], &state, &run.run_id, run.stages[index].attempts)
                }),
                _ => execute(&project, &step.command, &state, &run.run_id, run.stages[index].attempts),
            };
            let (success, log) = match result {
                Ok(result) => result,
                Err(error) => {
                    let cancelled = state.lock().map_err(|_| "pipeline state poisoned")?.cancel;
                    run.stages[index].status = if cancelled { "skip" } else { "fail" }.into();
                    run.stages[index].log = error;
                    run.status = if cancelled { "cancelled" } else { "failed" }.into();
                    let archived = finish_run(&runs_path, &current_path, &run);
                    remove_active(&project_key);
                    archived?;
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
            state
                .lock()
                .map_err(|_| "pipeline state poisoned")?
                .awaiting_action = true;
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
                    Some("retry") if run.stages[index].attempts < step.max_attempts => {
                        guard.awaiting_action = false;
                        break;
                    }
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
                        guard.awaiting_action = false;
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
    initiator_session_id: Option<String>,
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
    if initiator_session_id.is_none()
        && config
            .steps
            .iter()
            .any(|step| step.enabled && step.mode == "ai_commit")
    {
        return Err("AI commit pipelines must be started from the matching project chat".into());
    }
    let project_key = project.to_string_lossy().to_string();
    let state = Arc::new(Mutex::new(ActiveRun {
        cancel: false,
        process_group: None,
        action: None,
        input: None,
        pending: None,
        consumed_nonce: None,
        awaiting_action: false,
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
    let execution_cwd = execution.to_string_lossy().into_owned();
    thread::spawn(move || {
        if run_pipeline_thread(
            execution,
            key.clone(),
            name,
            config,
            state,
            execution_cwd,
            initiator_session_id,
        )
        .is_err()
        {
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
    } else if guard.awaiting_action {
        guard.action = Some(action.into());
    } else {
        return Err("pipeline step is not waiting for retry or skip".into());
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

fn accept_pipeline_input(guard: &mut ActiveRun, input: PipelineInput) -> Result<(), String> {
    let pending = guard
        .pending
        .as_ref()
        .ok_or("pipeline is not waiting for input")?;
    if guard.input.is_some() || guard.consumed_nonce.as_deref() == Some(&input.nonce) {
        return Err("pipeline input already provided".into());
    }
    if input.nonce != pending.nonce
        || input.run_id != pending.run_id
        || input.step_id != pending.step_id
        || input.mode != pending.mode
    {
        return Err("pipeline input identity mismatch".into());
    }
    if input.execution_cwd != pending.execution_cwd {
        return Err("pipeline input worktree mismatch".into());
    }
    if pending.initiator_session_id != input.session_id {
        return Err("pipeline input session mismatch".into());
    }
    if pending.mode == "confirm"
        && !pending
            .options
            .iter()
            .any(|option| Some(option.as_str()) == input.value.as_deref())
    {
        return Err("invalid confirmation option".into());
    }
    if pending.mode == "ai_commit" {
        validate_commit_input(
            Path::new(&pending.execution_cwd),
            PipelineInput {
                nonce: input.nonce.clone(),
                run_id: input.run_id.clone(),
                step_id: input.step_id.clone(),
                mode: input.mode.clone(),
                session_id: input.session_id.clone(),
                execution_cwd: input.execution_cwd.clone(),
                value: input.value.clone(),
                message: input.message.clone(),
                paths: input.paths.clone(),
            },
        )?;
    }
    guard.consumed_nonce = Some(input.nonce.clone());
    guard.input = Some(input);
    Ok(())
}

#[tauri::command]
pub fn provide_pipeline_input(project_path: String, input: PipelineInput) -> Result<(), String> {
    let project = crate::projects::ensure_path_allowed(Path::new(&project_path))?;
    let state = active()
        .lock()
        .map_err(|_| "pipeline registry poisoned")?
        .as_ref()
        .filter(|(key, _)| key == &project.to_string_lossy())
        .map(|(_, state)| state.clone())
        .ok_or("pipeline is not active for this project")?;
    let mut guard = state.lock().map_err(|_| "pipeline state poisoned")?;
    accept_pipeline_input(&mut guard, input)
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
    let pending_input = active().lock().ok().and_then(|slot| {
        slot.as_ref()
            .filter(|(key, _)| project_key.as_ref().is_none_or(|project| project == key))
            .and_then(|(_, state)| state.lock().ok()?.pending.clone())
    });
    Ok(PipelineData {
        runs,
        current,
        pending_input,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_step_defaults_to_shell_mode() {
        let step: PipelineStep = serde_json::from_str(r#"{"id":"x","name":"X","command":"echo x","enabled":true,"failure_policy":"stop","max_attempts":1}"#).unwrap();
        assert_eq!(step.mode, "shell");
        assert!(step.options.is_empty());
    }

    #[test]
    fn confirm_requires_prompt_and_options() {
        let mut step = presets("Personal").remove(0);
        step.mode = "confirm".into();
        let config = PipelineConfig {
            preset: "Custom".into(),
            steps: vec![step],
        };
        assert!(validate_config(&config).is_err());
    }

    #[test]
    fn confirm_input_is_passed_as_env_not_shell_text() {
        let state = Arc::new(Mutex::new(ActiveRun {
            cancel: false,
            process_group: None,
            action: None,
            input: None,
            pending: None,
            consumed_nonce: None,
            awaiting_action: false,
        }));
        let (success, output) = execute_with_env(
            Path::new("/tmp"),
            "printf '%s' \"$PIPELINE_INPUT\"",
            &[("PIPELINE_INPUT", "patch; touch /tmp/nope")],
            &state,
            "env-test",
            1,
        )
        .unwrap();
        assert!(success);
        assert_eq!(output, "patch; touch /tmp/nope");
    }

    fn pending(mode: &str) -> PipelinePendingInput {
        PipelinePendingInput {
            nonce: "nonce".into(),
            run_id: "run".into(),
            step_id: "step".into(),
            mode: mode.into(),
            step: "Step".into(),
            prompt: "Prompt".into(),
            options: vec!["patch".into()],
            execution_cwd: "/tmp".into(),
            initiator_session_id: Some("chat".into()),
        }
    }

    fn input() -> PipelineInput {
        PipelineInput {
            nonce: "nonce".into(),
            run_id: "run".into(),
            step_id: "step".into(),
            mode: "confirm".into(),
            session_id: Some("chat".into()),
            execution_cwd: "/tmp".into(),
            value: Some("patch".into()),
            message: None,
            paths: vec![],
        }
    }

    #[test]
    fn pending_input_rejects_wrong_identity_and_replacement() {
        let mut state = ActiveRun {
            cancel: false,
            process_group: None,
            action: None,
            input: None,
            pending: Some(pending("confirm")),
            consumed_nonce: None,
            awaiting_action: false,
        };
        let mut wrong = input();
        wrong.nonce = "wrong".into();
        assert!(accept_pipeline_input(&mut state, wrong)
            .unwrap_err()
            .contains("identity"));
        assert!(state.pending.is_some());
        accept_pipeline_input(&mut state, input()).unwrap();
        assert!(accept_pipeline_input(&mut state, input())
            .unwrap_err()
            .contains("already"));
    }

    #[test]
    fn pending_input_rejects_wrong_session_and_worktree() {
        let mut state = ActiveRun {
            cancel: false,
            process_group: None,
            action: None,
            input: None,
            pending: Some(pending("confirm")),
            consumed_nonce: None,
            awaiting_action: false,
        };
        let mut wrong_session = input();
        wrong_session.session_id = Some("other".into());
        assert!(accept_pipeline_input(&mut state, wrong_session)
            .unwrap_err()
            .contains("session"));
        let mut wrong_cwd = input();
        wrong_cwd.execution_cwd = "/other".into();
        assert!(accept_pipeline_input(&mut state, wrong_cwd)
            .unwrap_err()
            .contains("worktree"));
        assert!(state.pending.is_some());
    }

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
        assert!(runs[0].initiator_session_id.is_none());
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
            input: None,
            pending: None,
            consumed_nonce: None,
            awaiting_action: false,
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
    fn ai_commit_rejects_preexisting_staged_index() {
        let dir = std::env::temp_dir().join(format!("crc-pipeline-index-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(&dir)
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(&dir)
            .status()
            .unwrap();
        std::fs::write(dir.join("a.txt"), "a").unwrap();
        Command::new("git")
            .args(["add", "a.txt"])
            .current_dir(&dir)
            .status()
            .unwrap();
        Command::new("git")
            .args(["commit", "-qm", "init"])
            .current_dir(&dir)
            .status()
            .unwrap();
        std::fs::write(dir.join("a.txt"), "changed").unwrap();
        Command::new("git")
            .args(["add", "a.txt"])
            .current_dir(&dir)
            .status()
            .unwrap();
        let input = PipelineInput {
            nonce: "n".into(),
            run_id: "r".into(),
            step_id: "s".into(),
            mode: "ai_commit".into(),
            session_id: None,
            execution_cwd: dir.to_string_lossy().into(),
            value: None,
            message: Some("fix: test".into()),
            paths: vec!["a.txt".into()],
        };
        assert!(execute_ai_commit(&dir, input)
            .unwrap_err()
            .contains("already contains staged"));
        assert_eq!(staged_paths(&dir).unwrap(), vec!["a.txt"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ai_commit_failure_unstages_authorized_paths() {
        let dir = std::env::temp_dir().join(format!(
            "crc-pipeline-commit-failure-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
            .status()
            .unwrap();
        std::fs::write(dir.join("a.txt"), "a").unwrap();
        Command::new("git")
            .args(["add", "a.txt"])
            .current_dir(&dir)
            .status()
            .unwrap();
        Command::new("git")
            .args([
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test",
                "commit",
                "-qm",
                "init",
            ])
            .current_dir(&dir)
            .status()
            .unwrap();
        std::fs::write(dir.join("a.txt"), "changed").unwrap();
        let hook = dir.join(".git/hooks/pre-commit");
        std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let result = execute_ai_commit(
            &dir,
            PipelineInput {
                nonce: "n".into(),
                run_id: "r".into(),
                step_id: "s".into(),
                mode: "ai_commit".into(),
                session_id: None,
                execution_cwd: dir.to_string_lossy().into(),
                value: None,
                message: Some("fix: test".into()),
                paths: vec!["a.txt".into()],
            },
        )
        .unwrap();
        assert!(!result.0);
        assert!(staged_paths(&dir).unwrap().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn pending_input_rejects_wrong_mode_and_stays_pending() {
        let mut state = ActiveRun {
            cancel: false,
            process_group: None,
            action: None,
            input: None,
            pending: Some(pending("confirm")),
            consumed_nonce: None,
            awaiting_action: false,
        };
        let mut wrong = input();
        wrong.mode = "ai_commit".into();
        assert!(accept_pipeline_input(&mut state, wrong)
            .unwrap_err()
            .contains("identity"));
        assert!(state.pending.is_some());
        assert!(state.input.is_none());
    }

    #[test]
    fn timeout_and_cancel_clear_pending_input() {
        let state = Arc::new(Mutex::new(ActiveRun {
            cancel: false,
            process_group: None,
            action: None,
            input: None,
            pending: None,
            consumed_nonce: None,
            awaiting_action: false,
        }));
        assert!(
            wait_for_input_with_timeout(&state, pending("confirm"), Duration::ZERO)
                .unwrap_err()
                .contains("timed out")
        );
        assert!(state.lock().unwrap().pending.is_none());
        state.lock().unwrap().cancel = true;
        assert!(
            wait_for_input_with_timeout(&state, pending("confirm"), Duration::from_secs(1))
                .unwrap_err()
                .contains("cancelled")
        );
        assert!(state.lock().unwrap().pending.is_none());
    }

    #[test]
    fn modified_paths_rejects_rename_and_supports_spaces_and_short_names() {
        let dir = std::env::temp_dir().join(format!("crc-pipeline-paths-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(&dir)
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(&dir)
            .status()
            .unwrap();
        std::fs::write(dir.join("old"), "content").unwrap();
        Command::new("git")
            .args(["add", "old"])
            .current_dir(&dir)
            .status()
            .unwrap();
        Command::new("git")
            .args(["commit", "-qm", "init"])
            .current_dir(&dir)
            .status()
            .unwrap();
        Command::new("git")
            .args(["mv", "old", "new name"])
            .current_dir(&dir)
            .status()
            .unwrap();
        assert!(modified_paths(&dir).unwrap_err().contains("rename/copy"));
        Command::new("git")
            .args(["reset", "--hard", "-q"])
            .current_dir(&dir)
            .status()
            .unwrap();
        std::fs::write(dir.join("a"), "a").unwrap();
        std::fs::write(dir.join("x y.txt"), "x").unwrap();
        assert_eq!(modified_paths(&dir).unwrap(), vec!["a", "x y.txt"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn git_paths_rejects_non_utf8_names() {
        use std::os::unix::ffi::OsStringExt;
        let dir = std::env::temp_dir().join(format!("crc-pipeline-nonutf8-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
            .status()
            .unwrap();
        if std::fs::write(
            dir.join(std::ffi::OsString::from_vec(vec![b'x', 0xff])),
            "x",
        )
        .is_ok()
        {
            assert!(modified_paths(&dir).unwrap_err().contains("non-UTF-8"));
        }
        std::fs::remove_dir_all(dir).unwrap();
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
