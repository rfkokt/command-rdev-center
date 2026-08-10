use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

const MAX_TEXT_ATTACHMENT_BYTES: u64 = 512 * 1024;
const MAX_PDF_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_ATTACHMENT_TEXT_BYTES: usize = 1_000_000;

fn macos_tool(name: &str) -> String {
    [format!("/opt/homebrew/bin/{name}"), format!("/usr/local/bin/{name}"), name.into()]
        .into_iter()
        .find(|path| Path::new(path).is_file())
        .unwrap_or_else(|| name.into())
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatAttachment {
    pub name: String,
    pub path: String,
    pub content: String,
}

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

#[tauri::command]
pub async fn install_poppler() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let output = Command::new(macos_tool("brew"))
            .args(["install", "poppler"])
            .output()
            .map_err(|_| "Homebrew is required to install Poppler. Install Homebrew first: https://brew.sh".to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| format!("Poppler installer failed: {e}"))?
}

#[tauri::command]
pub async fn read_chat_attachments(paths: Vec<String>) -> Result<Vec<ChatAttachment>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let attachments: Result<Vec<_>, String> = paths.into_iter().map(|path| {
            let metadata = std::fs::metadata(&path).map_err(|e| format!("Cannot read {path}: {e}"))?;
            if !metadata.is_file() { return Err(format!("Not a file: {path}")); }
            let name = Path::new(&path).file_name().and_then(|name| name.to_str()).unwrap_or(&path).to_string();
            let is_pdf = Path::new(&path).extension().is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"));
            let limit = if is_pdf { MAX_PDF_ATTACHMENT_BYTES } else { MAX_TEXT_ATTACHMENT_BYTES };
            if metadata.len() > limit { return Err(format!("File exceeds {} MB: {path}", limit / 1024 / 1024)); }
            let content = if is_pdf {
                let output = Command::new(macos_tool("pdftotext")).arg(&path).arg("-").output()
                    .map_err(|_| "PDF support requires pdftotext (install Poppler).".to_string())?;
                if !output.status.success() { return Err(format!("Could not extract PDF text from {path}: {}", String::from_utf8_lossy(&output.stderr).trim())); }
                String::from_utf8(output.stdout).map_err(|_| format!("PDF text is not UTF-8: {path}"))?
            } else {
                std::fs::read_to_string(&path).map_err(|_| format!("File is not UTF-8 text: {path}"))?
            };
            Ok(ChatAttachment { name, path, content })
        }).collect();
        let attachments = attachments?;
        if attachments.iter().map(|attachment| attachment.content.len()).sum::<usize>() > MAX_ATTACHMENT_TEXT_BYTES {
            return Err(format!("Total attachment text exceeds {} MB", MAX_ATTACHMENT_TEXT_BYTES / 1_000_000));
        }
        Ok(attachments)
    }).await.map_err(|e| format!("Attachment reader failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_tool_prefers_known_homebrew_paths() {
        assert!(macos_tool("pdftotext").ends_with("pdftotext"));
    }

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
