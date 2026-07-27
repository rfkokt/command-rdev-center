use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const IGNORE_BLOCK: &str = "# graphify (local knowledge graph — do not push)\ngraphify-out/\n.graphify_python\n.graphify_detect.json\n";
const AGENTS_NOTE: &str = "<!-- command-rdev-center:graphify -->\n## Graphify navigation\nA local knowledge graph exists at `graphify-out/graph.json`. Before reading files one by one, use `graphify query \"<question>\"`, `graphify path \"A\" \"B\"`, or `graphify explain \"X\"` via bash.\n<!-- /command-rdev-center:graphify -->\n";

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

fn status(project: &Path) -> GraphStatus {
    let graph = project.join("graphify-out/graph.json");
    let report = project.join("graphify-out/GRAPH_REPORT.md");
    if !graph.exists() {
        return GraphStatus {
            state: GraphState::None,
            code_stale: false,
            docs_stale: false,
            report_path: None,
            tracked_warning: tracked_warning(project),
        };
    }
    let graph_ms = modified_ms(&graph);
    let mut newest = (0, 0);
    newest_changes(project, graph_ms, &mut newest);
    let code_stale = newest.0 > 0;
    let docs_stale = newest.1 > 0 || project.join("graphify-out/.crc-code-only").exists();
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
        tracked_warning: tracked_warning(project),
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

fn ensure_project_files(project: &Path) -> Result<(), String> {
    append_once(&project.join(".gitignore"), "graphify-out/", IGNORE_BLOCK)?;
    append_once(
        &project.join("AGENTS.md"),
        "command-rdev-center:graphify",
        AGENTS_NOTE,
    )
}

fn graphify_path() -> String {
    let cfg = Path::new(env!("CARGO_MANIFEST_DIR")).join("crc.config.json");
    fs::read_to_string(cfg)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| value.get("pi_path")?.as_str().map(String::from))
        .and_then(|pi| Path::new(&pi).parent().map(|p| p.join("graphify")))
        .filter(|path| path.exists())
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "graphify".into())
}

fn run_graphify(project: &Path, full: bool) -> Result<(), String> {
    ensure_project_files(project)?;
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
    if full {
        command.args([
            "extract",
            &project.to_string_lossy(),
            "--out",
            &project.to_string_lossy(),
        ]);
        if code_only {
            command.arg("--code-only");
        }
    } else {
        command.args(["update", &project.to_string_lossy()]);
    }
    let output = command
        .output()
        .map_err(|e| format!("failed to run graphify: {e}"))?;
    if output.status.success() {
        let marker = project.join("graphify-out/.crc-code-only");
        if code_only {
            fs::write(marker, "LLM API key unavailable during full build\n")
                .map_err(|e| e.to_string())?;
        } else if full {
            let _ = fs::remove_file(marker);
        }
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
pub fn get_graph_status(project_path: String) -> Result<GraphStatus, String> {
    Ok(status(&validate_project(Path::new(&project_path))?))
}

fn build_graph_blocking(project_path: String, full: bool) -> Result<GraphStatus, String> {
    let project = validate_project(Path::new(&project_path))?;
    run_graphify(&project, full)?;
    Ok(status(&project))
}

#[tauri::command]
pub async fn build_graph(project_path: String, full: bool) -> Result<GraphStatus, String> {
    tauri::async_runtime::spawn_blocking(move || build_graph_blocking(project_path, full))
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
    append_once(&path, "graphify-out/", IGNORE_BLOCK)?;
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
    let project = path
        .parent()
        .and_then(Path::parent)
        .ok_or("invalid graph report path")?;
    let project = validate_project(project)?;
    let expected = project.join("graphify-out/GRAPH_REPORT.md");
    if path == expected
        && path.is_file()
        && !fs::symlink_metadata(path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(true)
    {
        Ok(expected)
    } else {
        Err("invalid graph report path".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        append_once(&path, "graphify-out/", IGNORE_BLOCK).unwrap();
        append_once(&path, "graphify-out/", IGNORE_BLOCK).unwrap();
        assert_eq!(
            fs::read_to_string(&path)
                .unwrap()
                .matches("graphify-out/")
                .count(),
            1
        );
        let _ = fs::remove_file(path);
    }
}
