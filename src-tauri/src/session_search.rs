//! Cross-session message search (docs/tasks/orca-essentials O2-02).
//!
//! Scans saved pi session files (JSONL) for user/assistant text, off the main
//! thread and within fixed budgets, so a huge or corrupt history can never
//! freeze the app. ACP sessions keep no local transcript and are skipped.

use serde::{Deserialize, Serialize};
use std::io::BufRead;
use std::path::Path;

const PER_FILE_BYTES: u64 = 5_000_000;
const TOTAL_BYTES: usize = 50_000_000;
const MAX_HITS: usize = 50;

#[derive(Deserialize)]
pub struct Candidate {
    id: String,
    path: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Hit {
    id: String,
    text: String,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    hits: Vec<Hit>,
    /// Budgets ran out before every session was read.
    truncated: bool,
    /// Sessions that could not be searched (ACP, missing or not allowed).
    skipped: usize,
}

fn message_text(message: &serde_json::Value) -> String {
    if let Some(text) = message["content"].as_str() {
        return text.to_string();
    }
    message["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| block["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// One hit per session at most: the first matching message.
fn search(
    query: &str,
    candidates: Vec<Candidate>,
    allowed: impl Fn(&Path) -> bool,
) -> SearchResult {
    let query = query.to_lowercase();
    let mut result = SearchResult::default();
    let mut budget = TOTAL_BYTES;
    for candidate in candidates {
        if result.hits.len() >= MAX_HITS {
            result.truncated = true;
            break;
        }
        if candidate.path.starts_with("acp:") {
            result.skipped += 1;
            continue;
        }
        let Ok(path) = Path::new(&candidate.path).canonicalize() else {
            result.skipped += 1;
            continue;
        };
        if !allowed(&path) {
            result.skipped += 1;
            continue;
        }
        let Ok(file) = std::fs::File::open(&path) else {
            result.skipped += 1;
            continue;
        };
        let reader = std::io::BufReader::new(std::io::Read::take(file, PER_FILE_BYTES));
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.len() > budget {
                result.truncated = true;
                return result;
            }
            budget -= line.len();
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let Some(message) = value.get("message") else {
                continue;
            };
            if !matches!(message["role"].as_str(), Some("user" | "assistant")) {
                continue;
            }
            let text = message_text(message);
            if text.to_lowercase().contains(&query) {
                result.hits.push(Hit {
                    id: candidate.id.clone(),
                    text: text.chars().take(300).collect(),
                });
                break;
            }
        }
    }
    result
}

#[tauri::command]
pub async fn search_saved_sessions(
    query: String,
    candidates: Vec<Candidate>,
) -> Result<SearchResult, String> {
    if query.trim().chars().count() < 2 || query.len() > 500 || candidates.len() > 2000 {
        return Ok(SearchResult::default());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let roots = session_roots();
        search(&query, candidates, |path| {
            session_path_allowed(&roots, path)
        })
    })
    .await
    .map_err(|e| e.to_string())
}

/// Where pi keeps sessions: the default dir plus a configured `sessionDir`.
fn session_roots() -> Vec<std::path::PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(std::path::PathBuf::from(home).join(".pi/agent/sessions"));
    }
    if let Ok(settings) = crate::settings::get_pi_settings("global".into(), None) {
        if let Some(dir) = settings.get("sessionDir").and_then(|value| value.as_str()) {
            if !dir.trim().is_empty() {
                roots.push(std::path::PathBuf::from(dir));
            }
        }
    }
    roots
        .into_iter()
        .filter_map(|root| root.canonicalize().ok())
        .collect()
}

fn session_path_allowed(roots: &[std::path::PathBuf], path: &Path) -> bool {
    roots.iter().any(|root| path.starts_with(root))
        || crate::projects::ensure_path_allowed(path).is_ok()
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionToolCall {
    name: String,
    args: serde_json::Value,
    is_error: bool,
}

/// Tool calls on the session's latest branch, oldest first (bounded). Used to
/// hand a reloaded chat's work over to another model: the chat view only keeps
/// tool calls for turns it saw live.
fn tool_calls_in(path: &Path, max: usize) -> Vec<SessionToolCall> {
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let reader = std::io::BufReader::new(std::io::Read::take(file, 20_000_000));
    let mut calls: Vec<SessionToolCall> = Vec::new();
    let mut errors: std::collections::HashSet<String> = Default::default();
    let mut ids: Vec<Option<String>> = Vec::new();
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let message = &value["message"];
        match message["role"].as_str() {
            Some("assistant") => {
                for block in message["content"].as_array().into_iter().flatten() {
                    if block["type"] != "toolCall" {
                        continue;
                    }
                    let mut args = block["arguments"].clone();
                    // Keep paths and commands; drop bulky bodies (file contents, patches).
                    if let Some(map) = args.as_object_mut() {
                        map.retain(|key, value| {
                            matches!(
                                key.as_str(),
                                "path" | "file_path" | "filePath" | "file" | "command" | "cmd"
                            ) && value.as_str().is_some_and(|text| text.len() <= 2000)
                        });
                    }
                    calls.push(SessionToolCall {
                        name: block["name"].as_str().unwrap_or_default().to_string(),
                        args,
                        is_error: false,
                    });
                    ids.push(block["id"].as_str().map(str::to_string));
                }
            }
            Some("toolResult") if message["isError"] == true => {
                if let Some(id) = message["toolCallId"].as_str() {
                    errors.insert(id.to_string());
                }
            }
            _ => {}
        }
    }
    for (call, id) in calls.iter_mut().zip(&ids) {
        call.is_error = id.as_ref().is_some_and(|id| errors.contains(id));
    }
    let skip = calls.len().saturating_sub(max);
    calls.into_iter().skip(skip).collect()
}

#[tauri::command]
pub async fn session_tool_calls(session_file: String) -> Result<Vec<SessionToolCall>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if session_file.starts_with("acp:") {
            return Ok(Vec::new());
        }
        let path = Path::new(&session_file)
            .canonicalize()
            .map_err(|e| format!("session file: {e}"))?;
        if !session_path_allowed(&session_roots(), &path) {
            return Err("Session file is outside the pi session folders".into());
        }
        Ok(tool_calls_in(&path, 400))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Save the full handoff transcript where the next agent can read it on demand.
#[tauri::command]
pub async fn write_chat_handoff(
    app: tauri::AppHandle,
    chat_id: String,
    content: String,
) -> Result<String, String> {
    use tauri::Manager;
    if content.len() > 4_000_000 {
        return Err("Handoff transcript too large".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("handoffs");
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let name: String = chat_id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .take(80)
            .collect();
        let path = dir.join(format!(
            "{}.md",
            if name.is_empty() { "chat".into() } else { name }
        ));
        let partial = path.with_extension("md.partial");
        std::fs::write(&partial, content).map_err(|e| e.to_string())?;
        std::fs::rename(&partial, &path).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(lines: &[serde_json::Value]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "kern-search-{}.jsonl",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let body: Vec<String> = lines.iter().map(|line| line.to_string()).collect();
        std::fs::write(&path, body.join("\n")).unwrap();
        path
    }

    #[test]
    fn finds_text_in_user_and_assistant_messages_only() {
        let path = session(&[
            serde_json::json!({"type":"message","message":{"role":"toolResult","content":"needle in tool"}}),
            serde_json::json!({"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"The NEEDLE is here"}]}}),
            serde_json::json!("not json object"),
        ]);
        let result = search(
            "needle",
            vec![
                Candidate {
                    id: "a".into(),
                    path: path.to_string_lossy().into(),
                },
                Candidate {
                    id: "acp".into(),
                    path: "acp:session".into(),
                },
                Candidate {
                    id: "gone".into(),
                    path: "/no/such/file.jsonl".into(),
                },
            ],
            |_| true,
        );
        assert_eq!(
            result.hits,
            vec![Hit {
                id: "a".into(),
                text: "The NEEDLE is here".into()
            }]
        );
        assert_eq!(result.skipped, 2);
        assert!(!result.truncated);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn tool_calls_keep_paths_and_commands_and_mark_errors() {
        let path = session(&[
            serde_json::json!({"type":"message","message":{"role":"assistant","content":[
                {"type":"toolCall","id":"t1","name":"edit","arguments":{"path":"src/a.ts","oldText":"x","newText":"y"}},
                {"type":"toolCall","id":"t2","name":"bash","arguments":{"command":"pnpm test"}}
            ]}}),
            serde_json::json!({"type":"message","message":{"role":"toolResult","toolCallId":"t2","isError":true,"content":[]}}),
        ]);
        let calls = tool_calls_in(&path, 10);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].args, serde_json::json!({"path":"src/a.ts"}));
        assert!(!calls[0].is_error);
        assert_eq!(calls[1].args, serde_json::json!({"command":"pnpm test"}));
        assert!(calls[1].is_error);
        assert_eq!(tool_calls_in(&path, 1).len(), 1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn refuses_paths_outside_the_allowed_roots() {
        let path = session(&[serde_json::json!({"message":{"role":"user","content":"needle"}})]);
        let result = search(
            "needle",
            vec![Candidate {
                id: "a".into(),
                path: path.to_string_lossy().into(),
            }],
            |_| false,
        );
        assert!(result.hits.is_empty());
        assert_eq!(result.skipped, 1);
        let _ = std::fs::remove_file(path);
    }
}
