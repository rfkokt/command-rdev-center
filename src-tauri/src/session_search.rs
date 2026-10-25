use serde::{Deserialize, Serialize};
#[derive(Deserialize)]
pub struct Candidate { id: String, path: String }
#[derive(Serialize)]
pub struct Hit { id: String, text: String }
#[tauri::command]
pub async fn search_saved_sessions(query: String, candidates: Vec<Candidate>) -> Result<Vec<Hit>, String> {
    if query.trim().len() < 2 || query.len() > 500 || candidates.len() > 2000 { return Ok(vec![]); }
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::BufRead;
        let query = query.to_lowercase();
        let mut hits = Vec::new();
        let mut budget = 50_000_000usize;
        for candidate in candidates {
            if candidate.path.starts_with("acp:") { continue; }
            let Ok(path) = std::path::Path::new(&candidate.path).canonicalize() else { continue; };
            let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) else { continue; };
            if !path.starts_with(home.join(".pi/agent/sessions")) && crate::projects::ensure_path_allowed(&path).is_err() { continue; }
            let Ok(file) = std::fs::File::open(path) else { continue; };
            // Bounded scan prevents large/corrupt sessions blocking the worker indefinitely.
            let reader = std::io::BufReader::new(std::io::Read::take(file, 5_000_000));
            for line in reader.lines() {
                let Ok(line) = line else { break; };
                if line.len() > budget { return Ok(hits); } budget -= line.len();
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { continue; };
                let Some(message) = value.get("message") else { continue; };
                if !matches!(message["role"].as_str(), Some("user" | "assistant")) { continue; }
                let text = if let Some(text) = message["content"].as_str() { text.to_string() }
                    else { message["content"].as_array().map(|blocks| blocks.iter().filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default() };
                if text.to_lowercase().contains(&query) {
                    hits.push(Hit { id: candidate.id.clone(), text: text.chars().take(300).collect() });
                    break;
                }
            }
            if hits.len() >= 50 { break; }
        }
        Ok(hits)
    }).await.map_err(|e| e.to_string())?
}
