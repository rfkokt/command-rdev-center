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

fn walk_collect(base: &Path, results: &mut Vec<(PathBuf, PathBuf)>) {
    let mut builder = ignore::WalkBuilder::new(base);
    builder
        .hidden(true)
        .git_ignore(true)
        .git_exclude(true)
        .parents(true)
        .require_git(false)
        .filter_entry(|entry| entry.file_name() != ".git");

    for entry in builder.build().filter_map(Result::ok) {
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let path = entry.into_path();
        let rel = path.strip_prefix(base).unwrap_or(&path).to_path_buf();
        results.push((path, rel));
    }
}

fn search_files_blocking(project_path: String, query: String) -> Result<Vec<FileEntry>, String> {
    let proj_path = PathBuf::from(&project_path);
    crate::projects::ensure_registered_project(&proj_path)?;

    if !proj_path.exists() {
        return Err(format!("project path not found: {}", project_path));
    }

    let mut candidates: Vec<(PathBuf, PathBuf)> = Vec::new();
    walk_collect(&proj_path, &mut candidates);

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

#[tauri::command]
pub async fn search_files(project_path: String, query: String) -> Result<Vec<FileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || search_files_blocking(project_path, query))
        .await
        .map_err(|e| format!("File search worker failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walks_nested_git_repo_and_honors_its_gitignore() {
        let root = std::env::temp_dir().join(format!("crc-file-walk-{}", std::process::id()));
        let nested = root.join("nested");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(nested.join(".git")).unwrap();
        std::fs::write(nested.join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(nested.join("included.txt"), "included").unwrap();
        std::fs::write(nested.join("ignored.txt"), "ignored").unwrap();

        let mut files = Vec::new();
        walk_collect(&root, &mut files);
        let relative: Vec<_> = files.into_iter().map(|(_, path)| path).collect();

        assert!(relative.contains(&PathBuf::from("nested/included.txt")));
        assert!(!relative.contains(&PathBuf::from("nested/ignored.txt")));
        assert!(!relative.iter().any(|path| path.starts_with("nested/.git")));
        std::fs::remove_dir_all(root).unwrap();
    }
}
