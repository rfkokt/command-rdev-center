use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
#[cfg(test)]
use std::time::SystemTime;
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::Emitter;

const IGNORE_BLOCK: &str = "# graphify (local knowledge graph — do not push)\n/graphify-out\n/.graphify\n.graphify_python\n.graphify_detect.json\n";
const AGENTS_START: &str = "<!-- command-rdev-center:graphify -->";
const AGENTS_END: &str = "<!-- /command-rdev-center:graphify -->";
const AGENTS_NOTE: &str = "<!-- command-rdev-center:graphify -->\n## Graphify gate (blocking)\nFor every new coding task, before any file search/read (`rg`, `grep`, `find`, `ls`, `read`, or Codebase Memory):\n1. Check whether `graphify-out/graph.json` is fresh against `git HEAD`; run `graphify update .` if stale.\n2. Run `graphify query \"<the user's task>\"`.\n3. Only then inspect the returned files/symbols.\nDo not skip this gate for small tasks. Use `graphify path \"A\" \"B\"` or `graphify explain \"X\"` when needed.\n<!-- /command-rdev-center:graphify -->\n";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum GraphState {
    None,
    Fresh,
    StaleCode,
    StaleDocs,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphStatus {
    pub state: GraphState,
    pub code_stale: bool,
    pub docs_stale: bool,
    pub report_path: Option<String>,
    pub tracked_warning: Option<String>,
}

fn validate_project(path: &Path) -> Result<PathBuf, String> {
    crate::projects::ensure_registered_project(path)?;
    path.canonicalize().map_err(|e| e.to_string())
}

fn modified_ms(path: &Path) -> u128 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .unwrap_or(UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn classify(path: &Path) -> Option<bool> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if ["md", "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp"].contains(&ext.as_str()) {
        Some(true)
    } else if [
        "rs", "ts", "tsx", "js", "jsx", "py", "go", "java", "kt", "kts", "rb", "php", "c", "h",
        "cpp", "hpp", "cs", "swift", "scala", "sh", "sql", "toml", "yaml", "yml", "json",
    ]
    .contains(&ext.as_str())
    {
        Some(false)
    } else {
        None
    }
}

fn newest_changes(dir: &Path, graph_ms: u128, newest: &mut (u128, u128)) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == ".git"
            || name == "graphify-out"
            || name == "node_modules"
            || name == "target"
            || name == "dist"
        {
            continue;
        }
        if path.is_dir() {
            newest_changes(&path, graph_ms, newest);
        } else if let Some(is_doc) = classify(&path) {
            let mtime = modified_ms(&path);
            if mtime > graph_ms {
                if is_doc {
                    newest.1 = newest.1.max(mtime)
                } else {
                    newest.0 = newest.0.max(mtime)
                }
            }
        }
    }
}

fn tracked_warning(project: &Path) -> Option<String> {
    let output = Command::new("git")
        .args([
            "-C",
            &project.to_string_lossy(),
            "ls-files",
            "graphify-out/",
        ])
        .output()
        .ok()?;
    if output.status.success() && !output.stdout.is_empty() {
        Some("graphify-out/ is already tracked. Run: git rm -r --cached graphify-out/".into())
    } else {
        None
    }
}

pub(crate) fn graph_dir(workspace: &Path, repository: &Path) -> PathBuf {
    if workspace == repository {
        workspace.to_path_buf()
    } else {
        workspace.join(".graphify").join(
            repository
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("repository"),
        )
    }
}

fn repository_status(repository: &Path, output: &Path) -> GraphStatus {
    let graph = output.join("graphify-out/graph.json");
    let report = output.join("graphify-out/GRAPH_REPORT.md");
    if !graph.exists() {
        return GraphStatus {
            state: GraphState::None,
            code_stale: false,
            docs_stale: false,
            report_path: None,
            tracked_warning: tracked_warning(output),
        };
    }
    let graph_ms = modified_ms(&graph);
    let mut newest = (0, 0);
    newest_changes(repository, graph_ms, &mut newest);
    let code_stale = newest.0 > 0;
    let docs_stale = newest.1 > 0 || output.join("graphify-out/.crc-code-only").exists();
    let state = if docs_stale {
        GraphState::StaleDocs
    } else if code_stale {
        GraphState::StaleCode
    } else {
        GraphState::Fresh
    };
    GraphStatus {
        state,
        code_stale,
        docs_stale,
        report_path: report
            .exists()
            .then(|| report.to_string_lossy().to_string()),
        tracked_warning: tracked_warning(output),
    }
}

fn status(project: &Path) -> GraphStatus {
    let repositories = crate::projects::graph_repositories(project);
    if repositories.is_empty() {
        return repository_status(project, project);
    }
    let statuses = repositories
        .iter()
        .map(|repository| repository_status(repository, &graph_dir(project, repository)))
        .collect::<Vec<_>>();
    let docs_stale = statuses.iter().any(|status| status.docs_stale);
    let code_stale = statuses.iter().any(|status| status.code_stale);
    let state = if statuses.iter().any(|status| status.state == GraphState::None) {
        GraphState::None
    } else if docs_stale {
        GraphState::StaleDocs
    } else if code_stale {
        GraphState::StaleCode
    } else {
        GraphState::Fresh
    };
    GraphStatus {
        state,
        code_stale,
        docs_stale,
        report_path: statuses
            .iter()
            .find_map(|status| status.report_path.clone()),
        tracked_warning: statuses
            .iter()
            .find_map(|status| status.tracked_warning.clone()),
    }
}

fn append_once(path: &Path, marker: &str, content: &str) -> Result<(), String> {
    if fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!("refusing to write symlink: {}", path.display()));
    }
    let existing = fs::read_to_string(path).unwrap_or_default();
    if existing.contains(marker) {
        return Ok(());
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    if !existing.is_empty() && !existing.ends_with('\n') {
        writeln!(file).map_err(|e| e.to_string())?;
    }
    write!(
        file,
        "{}{}",
        if existing.is_empty() { "" } else { "\n" },
        content
    )
    .map_err(|e| e.to_string())
}

fn ensure_agents_note(path: &Path) -> Result<(), String> {
    if fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!("refusing to write symlink: {}", path.display()));
    }
    let existing = fs::read_to_string(path).unwrap_or_default();
    let next = match (existing.find(AGENTS_START), existing.find(AGENTS_END)) {
        (Some(start), Some(end)) if start <= end => {
            let end = end + AGENTS_END.len();
            format!(
                "{}{}{}",
                &existing[..start],
                AGENTS_NOTE.trim_end(),
                &existing[end..]
            )
        }
        _ if existing.is_empty() => AGENTS_NOTE.to_string(),
        _ => format!("{}\n\n{}", existing.trim_end(), AGENTS_NOTE),
    };
    if next != existing {
        fs::write(path, next).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn ensure_graphignore(path: &Path) -> Result<(), String> {
    let existing = fs::read_to_string(path).unwrap_or_default();
    if existing.lines().any(|line| line == "graphify-out/") {
        fs::write(path, existing.replace("graphify-out/", "/graphify-out"))
            .map_err(|e| e.to_string())
    } else if existing.lines().any(|line| line == "/graphify-out") {
        if existing.lines().any(|line| line == "/.graphify") {
            Ok(())
        } else {
            append_once(path, "/.graphify", "/.graphify\n")
        }
    } else {
        append_once(path, "/graphify-out", IGNORE_BLOCK)
    }
}

fn ensure_project_files(project: &Path) -> Result<(), String> {
    ensure_graphignore(&project.join(".gitignore"))?;
    ensure_agents_note(&project.join("AGENTS.md"))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

fn resolve_graphify(configured: Option<PathBuf>, home: Option<PathBuf>) -> PathBuf {
    configured
        .into_iter()
        .chain(home.map(|home| home.join(".local/bin/graphify")))
        .find(|path| is_executable(path))
        .unwrap_or_else(|| PathBuf::from("graphify"))
}

fn graphify_path() -> PathBuf {
    let configured =
        fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("crc.config.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|value| value.get("pi_path")?.as_str().map(PathBuf::from))
            .and_then(|pi| pi.parent().map(|parent| parent.join("graphify")));
    resolve_graphify(configured, std::env::var_os("HOME").map(PathBuf::from))
}

fn graphify_error(detail: &str, repository: &Path, status: std::process::ExitStatus) -> String {
    let lower = detail.to_ascii_lowercase();
    if lower.contains("billing_not_configured")
        || lower.contains("billing verification failed")
        || lower.contains("insufficient_quota")
        || lower.contains("quota exceeded")
        || lower.contains("credit balance")
    {
        return "Graphify LLM quota/billing is unavailable. Open Settings → Graphify and choose a provider with available credit, or disable the LLM configuration to build code-only.".into();
    }
    let detail = detail.lines().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
    if detail.trim().is_empty() {
        format!("Graphify failed for {} with status {status}", repository.display())
    } else {
        format!("Graphify failed for {}: {detail}", repository.display())
    }
}

fn run_graphify(
    app: &tauri::AppHandle,
    repository: &Path,
    output: &Path,
    full: bool,
    index: usize,
    total: usize,
) -> Result<(), String> {
    let mut command = Command::new(graphify_path());
    let configured = crate::settings::graphify_env();
    let inherited_key = [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "MOONSHOT_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "DEEPSEEK_API_KEY",
    ]
    .iter()
    .any(|key| std::env::var(key).is_ok_and(|value| !value.trim().is_empty()));
    let code_only = full && configured.is_none() && !inherited_key;
    if let Some((base_url, model, key)) = configured {
        command
            .env("OPENAI_BASE_URL", base_url)
            .env("OPENAI_MODEL", model)
            .env("OPENAI_API_KEY", key)
            // 9Router's WAF blocks the OpenAI SDK's default User-Agent.
            .env(
                "OPENAI_CUSTOM_HEADERS",
                "User-Agent: Mozilla/5.0\nAccept: application/json",
            );
    }
    // Keep the desktop responsive: Graphify otherwise defaults to all CPU cores and
    // multiple simultaneous LLM requests, which can beachball the WebView on macOS.
    command.args([
        "extract",
        &repository.to_string_lossy(),
        "--out",
        &output.to_string_lossy(),
        "--max-workers",
        "2",
        "--max-concurrency",
        "1",
    ]);
    if code_only {
        command.arg("--code-only");
    }
    let mut child = command
        .stdout(Stdio::inherit())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run graphify: {e}"))?;
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let stderr = child.stderr.take().ok_or("failed to capture Graphify errors")?;
    let captured = Arc::clone(&errors);
    let app = app.clone();
    let repository_name = repository.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let stderr_reader = thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("{line}");
            let activity = line
                .strip_prefix("[graphify extract] ")
                .or_else(|| line.strip_prefix("[graphify] "))
                .unwrap_or(&line)
                .chars()
                .take(180)
                .collect::<String>();
            let _ = app.emit("graphify-progress", serde_json::json!({
                "repository": repository_name,
                "index": index,
                "total": total,
                "activity": activity,
            }));
            if let Ok(mut lines) = captured.lock() {
                lines.push(line);
                if lines.len() > 100 {
                    lines.remove(0);
                }
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(1_800);
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("failed to poll graphify: {e}"))?
        {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stderr_reader.join();
            return Err(format!(
                "Graphify timed out after 30 minutes while indexing {}",
                repository.display()
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let _ = stderr_reader.join();
    if !status.success() {
        let detail = errors.lock().map(|lines| lines.join("\n")).unwrap_or_default();
        return Err(graphify_error(&detail, repository, status));
    }

    let marker = output.join("graphify-out/.crc-code-only");
    if code_only {
        fs::write(marker, "LLM API key unavailable during full build\n")
            .map_err(|e| e.to_string())?;
    } else if full {
        let _ = fs::remove_file(marker);
    }
    Ok(())
}

fn get_graph_status_blocking(project_path: String) -> Result<GraphStatus, String> {
    let project = validate_project(Path::new(&project_path))?;
    ensure_project_files(&project)?;
    Ok(status(&project))
}

#[tauri::command]
pub async fn get_graph_status(project_path: String) -> Result<GraphStatus, String> {
    tauri::async_runtime::spawn_blocking(move || get_graph_status_blocking(project_path))
        .await
        .map_err(|e| format!("Graph status worker failed: {e}"))?
}

fn get_git_fingerprint_blocking(project_path: String) -> Result<Option<String>, String> {
    let project = validate_project(Path::new(&project_path))?;
    if !project.join(".git").exists() {
        return Ok(None);
    }
    let output = Command::new("git")
        .args([
            "-C",
            &project.to_string_lossy(),
            "rev-parse",
            "--abbrev-ref",
            "HEAD",
            "HEAD",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_string(),
        ))
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
pub async fn get_git_fingerprint(project_path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || get_git_fingerprint_blocking(project_path))
        .await
        .map_err(|e| format!("Git fingerprint worker failed: {e}"))?
}

fn build_graph_blocking(
    app: tauri::AppHandle,
    project_path: String,
    full: bool,
) -> Result<GraphStatus, String> {
    let project = validate_project(Path::new(&project_path))?;
    ensure_project_files(&project)?;
    let repositories = crate::projects::graph_repositories(&project);
    let repositories = if repositories.is_empty() { vec![project.clone()] } else { repositories };
    let total = repositories.len();
    for (offset, repository) in repositories.into_iter().enumerate() {
        let index = offset + 1;
        let name = repository.file_name().unwrap_or_default().to_string_lossy();
        let _ = app.emit("graphify-progress", serde_json::json!({
            "repository": name,
            "index": index,
            "total": total,
            "activity": "Starting repository scan…",
        }));
        run_graphify(&app, &repository, &graph_dir(&project, &repository), full, index, total)?;
    }
    Ok(status(&project))
}

#[tauri::command]
pub async fn build_graph(
    app: tauri::AppHandle,
    project_path: String,
    full: bool,
) -> Result<GraphStatus, String> {
    tauri::async_runtime::spawn_blocking(move || build_graph_blocking(app, project_path, full))
        .await
        .map_err(|e| format!("Graphify worker failed: {e}"))?
}

#[tauri::command]
pub fn enable_global_graphignore() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let configured = Command::new("git")
        .args(["config", "--global", "--get", "core.excludesfile"])
        .output()
        .map_err(|e| e.to_string())?;
    let configured = String::from_utf8_lossy(&configured.stdout)
        .trim()
        .to_string();
    let path = if configured.is_empty() {
        Path::new(&home).join(".gitignore_global")
    } else {
        PathBuf::from(configured.replace('~', &home))
    };
    ensure_graphignore(&path)?;
    let output = Command::new("git")
        .args([
            "config",
            "--global",
            "core.excludesfile",
            &path.to_string_lossy(),
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(path.to_string_lossy().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

pub fn validate_report_path(path: &Path) -> Result<PathBuf, String> {
    let owner = crate::projects::registered_workspace(path)
        .ok_or("graph report is not inside a registered project")?;
    let valid = crate::projects::graph_repositories(&owner).into_iter().any(|repository| {
        path == graph_dir(&owner, &repository).join("graphify-out/GRAPH_REPORT.md")
    });
    if valid
        && path.is_file()
        && !fs::symlink_metadata(path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(true)
    {
        Ok(path.to_path_buf())
    } else {
        Err("invalid graph report path".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_graphify_for_gui_apps() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "crc-graphify-path-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let configured = root.join("configured/graphify");
        let installed = root.join("home/.local/bin/graphify");
        fs::create_dir_all(configured.parent().unwrap()).unwrap();
        fs::create_dir_all(installed.parent().unwrap()).unwrap();
        fs::write(&configured, "").unwrap();
        fs::write(&installed, "").unwrap();
        fs::set_permissions(&configured, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&installed, fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            resolve_graphify(Some(configured.clone()), Some(root.join("home"))),
            configured
        );
        fs::set_permissions(&configured, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            resolve_graphify(Some(configured), Some(root.join("home"))),
            installed
        );
        fs::remove_file(&installed).unwrap();
        assert_eq!(
            resolve_graphify(None, Some(root.join("home"))),
            PathBuf::from("graphify")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn classify_code_and_docs() {
        assert_eq!(classify(Path::new("src/App.tsx")), Some(false));
        assert_eq!(classify(Path::new("docs/PRD.md")), Some(true));
        assert_eq!(classify(Path::new("README")), None);
    }

    #[test]
    fn append_once_is_idempotent() {
        let path = std::env::temp_dir().join(format!(
            "crc-graph-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        ensure_graphignore(&path).unwrap();
        ensure_graphignore(&path).unwrap();
        assert_eq!(
            fs::read_to_string(&path)
                .unwrap()
                .matches("/graphify-out")
                .count(),
            1
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn graphignore_migrates_directory_rule_for_worktree_symlink() {
        let path = std::env::temp_dir().join(format!(
            "crc-graphignore-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, "graphify-out/\n").unwrap();
        ensure_graphignore(&path).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "/graphify-out\n");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn ensure_agents_note_keeps_mtime_when_unchanged() {
        let path = std::env::temp_dir().join(format!(
            "crc-agents-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, AGENTS_NOTE).unwrap();
        let before = fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        ensure_agents_note(&path).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), before);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn graphify_billing_error_is_actionable() {
        let status = Command::new("false").status().unwrap();
        let error = graphify_error(
            "402 billing_not_configured: Billing verification failed",
            Path::new("/tmp/repo"),
            status,
        );
        assert!(error.contains("quota/billing"));
        assert!(error.contains("Settings → Graphify"));
    }

    #[test]
    fn workspace_graphs_are_centralized_by_repository() {
        let workspace = Path::new("/tmp/workspace");
        let repository = workspace.join("frontend");
        assert_eq!(graph_dir(workspace, &repository), workspace.join(".graphify/frontend"));
        assert_eq!(graph_dir(&repository, &repository), repository);
    }

    #[test]
    fn ensure_agents_note_replaces_old_block() {
        let path = std::env::temp_dir().join(format!(
            "crc-agents-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(
            &path,
            format!("before\n{AGENTS_START}\nold\n{AGENTS_END}\nafter\n"),
        )
        .unwrap();
        ensure_agents_note(&path).unwrap();
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("Graphify gate (blocking)"));
        assert!(!content.contains("\nold\n"));
        assert_eq!(content.matches(AGENTS_START).count(), 1);
        let _ = fs::remove_file(path);
    }
}
