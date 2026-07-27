use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub relative: String,
}

/// Simple fuzzy: score if needle chars appear in order in haystack (case-insensitive).
fn fuzzy_match(hay: &str, needle: &str) -> Option<i32> {
    if needle.is_empty() {
        return Some(0);
    }
    let hay = hay.to_lowercase();
    let needle = needle.to_lowercase();
    let mut score = 0i32;
    let mut hi = 0usize;
    let hay_chars: Vec<char> = hay.chars().collect();
    for nc in needle.chars() {
        let mut found = false;
        while hi < hay_chars.len() {
            if hay_chars[hi] == nc {
                score += 1;
                if hi < 20 {
                    score += 2; // prefix bonus
                }
                hi += 1;
                found = true;
                break;
            }
            hi += 1;
        }
        if !found {
            return None;
        }
    }
    Some(score)
}

fn walk_collect(
    base: &Path,
    cur: &Path,
    depth: usize,
    results: &mut Vec<(PathBuf, PathBuf)>,
    limit: usize,
) {
    if results.len() >= limit {
        return;
    }
    if depth > 4 {
        return;
    }
    let entries = match std::fs::read_dir(cur) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let file_name = match p.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if file_name.starts_with('.') {
            continue;
        }
        if file_name == "node_modules"
            || file_name == "dist"
            || file_name == "target"
            || file_name == ".git"
            || file_name == "__pycache__"
            || file_name == ".next"
            || file_name == "graphify-out"
            || file_name == ".crc-worktrees"
        {
            continue;
        }
        if p.is_dir() {
            walk_collect(base, &p, depth + 1, results, limit);
        } else {
            let rel = p.strip_prefix(base).unwrap_or(&p).to_path_buf();
            results.push((p, rel));
        }
        if results.len() >= limit {
            return;
        }
    }
}

#[tauri::command]
pub fn search_files(project_path: String, query: String) -> Result<Vec<FileEntry>, String> {
    let proj_path = PathBuf::from(&project_path);
    crate::projects::ensure_registered_project(&proj_path)?;

    if !proj_path.exists() {
        return Err(format!("project path not found: {}", project_path));
    }

    let mut candidates: Vec<(PathBuf, PathBuf)> = Vec::new();
    walk_collect(&proj_path, &proj_path, 0, &mut candidates, 1000);

    let q = query.trim().to_lowercase();
    let mut scored: Vec<(i32, FileEntry)> = Vec::new();
    for (abs, rel) in candidates {
        let rel_s = rel.to_string_lossy().to_string();
        let name = abs
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if let Some(score) = fuzzy_match(&rel_s, &q) {
            scored.push((
                score,
                FileEntry {
                    name,
                    path: abs.to_string_lossy().to_string(),
                    relative: rel_s,
                },
            ));
        }
    }
    // If empty query, return first 50 anyway
    if q.is_empty() {
        return Ok(scored.into_iter().take(50).map(|(_, f)| f).collect());
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored.truncate(50);
    Ok(scored.into_iter().map(|(_, f)| f).collect())
}
