//! Per-chat attachment store (docs/tasks/orca-essentials O1-01).
//!
//! Adapted from stablyai/orca src/main/native-chat/agent-session-attachments
//! (MIT): every upload gets its own directory so the original file name
//! survives without collisions, files are committed atomically, oversized
//! files are refused, and a sweep drops uploads nobody needs any more.
//!
//! The stored path is what the agent is told about, so it can use the file
//! (copy it into the project, read it with a tool) whatever the model reads.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
/// Uploads older than this are swept at startup. Inline images also live in
/// the session history, so only the file copy goes.
const RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StoredAttachment {
    pub id: String,
    pub name: String,
    pub path: String,
    pub mime: String,
    pub size: u64,
    /// Base64 bytes for images a model can take inline (preview + sending).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
}

fn store_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("attachments"))
}

/// A path segment from a chat id: only `[A-Za-z0-9._-]`, never empty or `..`.
fn safe_segment(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('.').to_string();
    if cleaned.is_empty() {
        "chat".into()
    } else {
        cleaned
    }
}

/// The file name only (no directories), without characters that break paths.
fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && *c != ':')
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    if cleaned.is_empty() {
        "attachment".into()
    } else {
        cleaned
    }
}

fn upload_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut random = [0u8; 4];
    let _ = getrandom::fill(&mut random);
    format!(
        "{nanos:x}-{}",
        random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

pub fn mime_for(name: &str) -> String {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
    .into()
}

fn too_large(size: u64) -> String {
    format!(
        "File is {:.1} MB; attachments are limited to {} MB",
        size as f64 / 1024.0 / 1024.0,
        MAX_ATTACHMENT_BYTES / 1024 / 1024
    )
}

/// Write into `<root>/<chat>/<upload id>/<name>`, via a temp file and a rename
/// so a half-written file is never visible under its real name.
fn commit(
    root: &Path,
    chat: &str,
    name: &str,
    mime: Option<&str>,
    write: impl FnOnce(&Path) -> std::io::Result<u64>,
) -> Result<StoredAttachment, String> {
    let name = safe_name(name);
    let id = upload_id();
    let dir = root.join(safe_segment(chat)).join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("attachment store: {e}"))?;
    let temp = dir.join(".partial");
    let size = match write(&temp) {
        Ok(size) => size,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(format!("attachment store: {error}"));
        }
    };
    let path = dir.join(&name);
    if let Err(error) = std::fs::rename(&temp, &path) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!("attachment store: {error}"));
    }
    Ok(StoredAttachment {
        id,
        mime: mime.map(str::to_string).unwrap_or_else(|| mime_for(&name)),
        name,
        path: path.to_string_lossy().into_owned(),
        size,
        data: None,
    })
}

/// Formats every vision API takes inline; anything else travels as a path.
pub fn is_inline_image(mime: &str) -> bool {
    matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    )
}

/// Standard base64 with padding (no crate needed for this one use).
pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

pub fn store_bytes(
    root: &Path,
    chat: &str,
    name: &str,
    mime: Option<&str>,
    bytes: &[u8],
) -> Result<StoredAttachment, String> {
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(too_large(bytes.len() as u64));
    }
    let mut stored = commit(root, chat, name, mime, |temp| {
        std::fs::write(temp, bytes)?;
        Ok(bytes.len() as u64)
    })?;
    // Like store_attachment_file: the composer needs inline bytes for images.
    if is_inline_image(&stored.mime) {
        stored.data = Some(base64(bytes));
    }
    Ok(stored)
}

pub fn store_file(root: &Path, chat: &str, source: &Path) -> Result<StoredAttachment, String> {
    let metadata =
        std::fs::metadata(source).map_err(|e| format!("Cannot read {}: {e}", source.display()))?;
    if !metadata.is_file() {
        return Err(format!("Not a file: {}", source.display()));
    }
    if metadata.len() > MAX_ATTACHMENT_BYTES {
        return Err(too_large(metadata.len()));
    }
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("attachment")
        .to_string();
    commit(root, chat, &name, None, |temp| std::fs::copy(source, temp))
}

/// Re-open an upload that already lives under `root` (draft restore), without
/// copying it again. Anything outside the store is refused.
pub fn read_stored(root: &Path, path: &Path) -> Result<StoredAttachment, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("attachment store: {e}"))?;
    let path = path
        .canonicalize()
        .map_err(|e| format!("Attachment is no longer available: {e}"))?;
    if !path.starts_with(&root) {
        return Err("Not an attachment-store file".into());
    }
    let metadata = std::fs::metadata(&path).map_err(|e| format!("attachment store: {e}"))?;
    if !metadata.is_file() {
        return Err("Not an attachment-store file".into());
    }
    if metadata.len() > MAX_ATTACHMENT_BYTES {
        return Err(too_large(metadata.len()));
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("attachment")
        .to_string();
    let id = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    let mime = mime_for(&name);
    let data = if is_inline_image(&mime) {
        Some(base64(
            &std::fs::read(&path).map_err(|e| format!("attachment store: {e}"))?,
        ))
    } else {
        None
    };
    Ok(StoredAttachment {
        id,
        name,
        path: path.to_string_lossy().into_owned(),
        mime,
        size: metadata.len(),
        data,
    })
}

/// Remove upload directories last touched before `now - keep`; then any chat
/// directory left empty. Returns how many uploads went.
pub fn sweep(root: &Path, keep: Duration, now: SystemTime) -> usize {
    let mut removed = 0;
    let Ok(chats) = std::fs::read_dir(root) else {
        return 0;
    };
    for chat in chats.filter_map(Result::ok) {
        let chat_dir = chat.path();
        if !chat_dir.is_dir() {
            continue;
        }
        if let Ok(uploads) = std::fs::read_dir(&chat_dir) {
            for upload in uploads.filter_map(Result::ok) {
                let modified = upload.metadata().and_then(|m| m.modified()).ok();
                let old = modified
                    .and_then(|at| now.duration_since(at).ok())
                    .is_some_and(|age| age > keep);
                if old && std::fs::remove_dir_all(upload.path()).is_ok() {
                    removed += 1;
                }
            }
        }
        // Only succeeds when empty.
        let _ = std::fs::remove_dir(&chat_dir);
    }
    removed
}

/// Startup housekeeping, off the main thread.
pub fn sweep_in_background(app: &AppHandle) {
    let Ok(root) = store_root(app) else { return };
    std::thread::spawn(move || {
        sweep(&root, RETENTION, SystemTime::now());
    });
}

fn header(request: &tauri::ipc::Request<'_>, name: &str) -> Option<String> {
    let raw = request.headers().get(name)?.to_str().ok()?;
    // The frontend percent-encodes values (file names may not be ASCII).
    url::form_urlencoded::parse(format!("v={raw}").as_bytes())
        .next()
        .map(|(_, value)| value.into_owned())
}

/// Once the `ipc://` custom protocol fails in a window, Tauri falls back to
/// postMessage for the rest of its life and a `Uint8Array` arrives as a JSON
/// array of numbers instead of a raw body.
fn body_bytes(body: &tauri::ipc::InvokeBody) -> Result<Vec<u8>, String> {
    match body {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        tauri::ipc::InvokeBody::Json(value) => serde_json::from_value::<Vec<u8>>(value.clone())
            .map_err(|_| "attachment upload needs a binary body".to_string()),
    }
}

/// Store bytes the user pasted. Raw IPC body (or its postMessage JSON form); `x-chat-id`, `x-file-name` and
/// `x-mime` headers (percent-encoded).
#[tauri::command]
pub async fn save_attachment_bytes(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<StoredAttachment, String> {
    let bytes = body_bytes(request.body())?;
    let chat = header(&request, "x-chat-id").unwrap_or_default();
    let name = header(&request, "x-file-name").unwrap_or_else(|| "pasted".into());
    let mime = header(&request, "x-mime");
    let root = store_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        store_bytes(&root, &chat, &name, mime.as_deref(), &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copy a file the user dropped or picked into the chat's store.
#[tauri::command(async)]
pub fn store_attachment_file(
    app: AppHandle,
    chat_id: String,
    path: String,
) -> Result<StoredAttachment, String> {
    let mut stored = store_file(&store_root(&app)?, &chat_id, Path::new(&path))?;
    if is_inline_image(&stored.mime) {
        let bytes = std::fs::read(&stored.path).map_err(|e| format!("attachment store: {e}"))?;
        stored.data = Some(base64(&bytes));
    }
    Ok(stored)
}

/// Reload a stored attachment for a restored draft (no new copy).
#[tauri::command(async)]
pub fn read_stored_attachment(app: AppHandle, path: String) -> Result<StoredAttachment, String> {
    read_stored(&store_root(&app)?, Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pasted_images_come_back_with_inline_data() {
        let root = temp_root("pasted-data");
        let image = store_bytes(&root, "c", "shot.png", Some("image/png"), b"png").unwrap();
        assert_eq!(image.data.as_deref(), Some(base64(b"png").as_str()));
        let other = store_bytes(&root, "c", "notes.bin", None, b"bin").unwrap();
        assert_eq!(other.data, None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn body_bytes_accepts_raw_and_postmessage_json() {
        use tauri::ipc::InvokeBody;
        assert_eq!(
            body_bytes(&InvokeBody::Raw(vec![1, 2, 255])).unwrap(),
            vec![1, 2, 255]
        );
        assert_eq!(
            body_bytes(&InvokeBody::Json(serde_json::json!([1, 2, 255]))).unwrap(),
            vec![1, 2, 255]
        );
        assert!(body_bytes(&InvokeBody::Json(serde_json::json!({ "a": 1 }))).is_err());
    }

    #[test]
    fn read_stored_reopens_without_copying_and_refuses_outside_files() {
        let root = temp_root("reopen");
        let stored = store_bytes(&root, "chat-1", "shot.png", None, b"png").unwrap();
        let again = read_stored(&root, Path::new(&stored.path)).unwrap();
        assert_eq!(
            Path::new(&again.path),
            Path::new(&stored.path).canonicalize().unwrap()
        );
        assert_eq!(again.mime, "image/png");
        assert_eq!(again.data.as_deref(), Some(base64(b"png").as_str()));
        assert_eq!(std::fs::read_dir(root.join("chat-1")).unwrap().count(), 1);
        let outside = root.with_extension("outside.png");
        std::fs::write(&outside, b"x").unwrap();
        assert!(read_stored(&root, &outside).is_err());
        let _ = std::fs::remove_file(outside);
        let _ = std::fs::remove_dir_all(root);
    }

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("kern-attachments-{tag}-{}", upload_id()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn same_name_never_collides() {
        let root = temp_root("collide");
        let a = store_bytes(&root, "chat-1", "shot.png", None, b"one").unwrap();
        let b = store_bytes(&root, "chat-1", "shot.png", None, b"two").unwrap();
        assert_ne!(a.path, b.path);
        assert_eq!(std::fs::read(&a.path).unwrap(), b"one");
        assert_eq!(std::fs::read(&b.path).unwrap(), b"two");
        assert_eq!(a.name, "shot.png");
        assert_eq!(a.mime, "image/png");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn names_and_chat_ids_cannot_escape_the_store() {
        let root = temp_root("escape");
        let stored = store_bytes(&root, "../../etc", "../../passwd", None, b"x").unwrap();
        assert!(Path::new(&stored.path).starts_with(&root));
        assert_eq!(stored.name, "passwd");
        assert_eq!(safe_name(""), "attachment");
        assert_eq!(safe_segment(".."), "chat");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_files_are_refused() {
        let root = temp_root("large");
        let big = vec![0u8; MAX_ATTACHMENT_BYTES as usize + 1];
        let error = store_bytes(&root, "c", "big.bin", None, &big).unwrap_err();
        assert!(error.contains("limited to 20 MB"), "{error}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn copies_files_with_their_name() {
        let root = temp_root("copy");
        let source = root.join("source.pdf");
        std::fs::write(&source, b"%PDF").unwrap();
        let stored = store_file(&root.join("store"), "c", &source).unwrap();
        assert_eq!(stored.name, "source.pdf");
        assert_eq!(stored.mime, "application/pdf");
        assert_eq!(stored.size, 4);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0x00]), "//4A");
    }

    #[test]
    fn sweep_drops_only_old_uploads() {
        let root = temp_root("sweep");
        let kept = store_bytes(&root, "c", "a.png", None, b"a").unwrap();
        let now = SystemTime::now();
        assert_eq!(sweep(&root, Duration::from_secs(60), now), 0);
        assert!(Path::new(&kept.path).exists());
        // Seen from two minutes later, the upload is past a one-minute keep.
        assert_eq!(
            sweep(
                &root,
                Duration::from_secs(60),
                now + Duration::from_secs(120)
            ),
            1
        );
        assert!(!Path::new(&kept.path).exists());
        assert!(!root.join("c").exists(), "empty chat directory removed");
        let _ = std::fs::remove_dir_all(root);
    }
}
