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
        let sessions = std::env::var_os("HOME")
            .map(|home| std::path::PathBuf::from(home).join(".pi/agent/sessions"));
        search(&query, candidates, |path| {
            sessions.as_ref().is_some_and(|dir| path.starts_with(dir))
                || crate::projects::ensure_path_allowed(path).is_ok()
        })
    })
    .await
    .map_err(|e| e.to_string())
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
