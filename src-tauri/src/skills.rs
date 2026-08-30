use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
pub struct SkillSource { pub id: String, pub label: String, pub path: String, pub readable: bool, pub error: Option<String> }
#[derive(Debug, Clone, Serialize)]
pub struct SkillManifest { pub name: String, pub description: String, pub source: String, pub valid: bool, pub disabled_model_invocation: bool, pub allowed_tools: Vec<String>, pub trigger_terms: Vec<String>, pub capabilities: Vec<String>, pub use_when: String, pub risk: String, pub fingerprint: String, pub indexed_at: String }
#[derive(Debug, Clone, Serialize)]
pub struct PiSkill {
    pub name: String, pub description: String, pub location: String, pub source_id: String,
    pub valid: bool, pub invalid_reason: Option<String>, pub manual_only: bool,
    pub license: Option<String>, pub compatibility: Option<String>, pub metadata: Option<String>,
    pub allowed_tools: Option<String>, pub frontmatter: String, pub content: String, pub supporting_files: Vec<String>, pub manifest: Option<SkillManifest>,
}
#[derive(Debug, Clone, Serialize)]
pub struct SkillCatalog { pub skills: Vec<PiSkill>, pub sources: Vec<SkillSource> }

fn home() -> Result<PathBuf, String> { Ok(PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set")?)) }
fn bundled_root(home: &Path) -> Result<PathBuf, String> {
    let root = home.join("Library/Application Support/command-rdev-center/bundled-skills");
    let path = root.join("screenshot-to-existing-ui/SKILL.md");
    let content = include_str!("../skills/screenshot-to-existing-ui/SKILL.md");
    if std::fs::read_to_string(&path).ok().as_deref() != Some(content) {
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|error| error.to_string())?;
        std::fs::write(&path, content).map_err(|error| error.to_string())?;
    }
    Ok(root)
}
fn configured_roots(home: &Path) -> Vec<PathBuf> {
    let path = home.join(".pi/agent/settings.json");
    let Ok(raw) = std::fs::read_to_string(path) else { return Vec::new() };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else { return Vec::new() };
    value.get("skills").and_then(Value::as_array).into_iter().flatten().filter_map(|item| match item {
        Value::String(path) => Some(path.clone()), Value::Object(object) => object.get("path").and_then(Value::as_str).map(String::from), _ => None,
    }).map(|path| PathBuf::from(path.strip_prefix("~/").map(|rest| home.join(rest)).unwrap_or_else(|| PathBuf::from(path)))).collect()
}
fn sources() -> Result<Vec<(String, String, PathBuf)>, String> {
    let home = home()?;
    let mut roots = vec![
        ("crc-bundled".into(), "Command RDEV Center".into(), bundled_root(&home)?),
        ("pi-global".into(), "~/.pi/agent/skills".into(), home.join(".pi/agent/skills")),
        ("agents-global".into(), "~/.agents/skills".into(), home.join(".agents/skills")),
    ];
    roots.extend(configured_roots(&home).into_iter().enumerate().map(|(index, path)| (format!("settings-{index}"), "Pi settings".into(), path)));
    Ok(roots)
}
fn frontmatter(contents: &str) -> Result<(&str, &str), String> {
    let body = contents.strip_prefix("---\n").ok_or("missing opening YAML frontmatter delimiter")?;
    let (frontmatter, content) = body.split_once("\n---\n").ok_or("missing closing YAML frontmatter delimiter")?;
    serde_yaml::from_str::<serde_yaml::Value>(frontmatter).map_err(|error| format!("invalid YAML frontmatter: {error}"))?;
    Ok((frontmatter, content))
}
fn value(frontmatter: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:"); let mut lines = frontmatter.lines().peekable();
    while let Some(line) = lines.next() {
        if let Some(raw) = line.strip_prefix(&prefix) {
            let raw = raw.trim();
            if raw == ">" || raw == "|" || raw.is_empty() { let mut text = Vec::new(); while let Some(next) = lines.peek() { if next.starts_with(' ') { text.push(lines.next().unwrap().trim()); } else { break } } return Some(if raw == ">" { text.join(" ") } else { text.join("\n") }); }
            return Some(raw.trim_matches(|ch| ch == '\'' || ch == '"').to_string());
        }
    } None
}
fn bool_value(frontmatter: &str, key: &str) -> bool { matches!(value(frontmatter, key).as_deref(), Some("true")) }
fn fingerprint(text: &str) -> String { let mut hash: u64 = 0xcbf29ce484222325; for byte in text.as_bytes() { hash ^= u64::from(*byte); hash = hash.wrapping_mul(0x100000001b3); } format!("{hash:016x}") }
fn manifest(name: &str, description: &str, source: &str, valid: bool, manual_only: bool, tools: Option<String>, content: &str) -> SkillManifest { let lower = format!("{name} {description}").to_lowercase(); let terms: Vec<String> = lower.split(|c: char| !c.is_alphanumeric()).filter(|word| word.len() > 2 && !matches!(*word, "the" | "and" | "for" | "with" | "from" | "this" | "that" | "skill")).map(String::from).collect::<HashSet<_>>().into_iter().take(12).collect(); let risk = if lower.contains("review") || lower.contains("audit") { "read-only" } else if lower.contains("implement") || lower.contains("build") || lower.contains("modify") { "may-modify" } else { "guidance" }; let capabilities = description.split(|c| matches!(c, '.' | ';' | ',')).map(str::trim).filter(|part| !part.is_empty()).take(5).map(String::from).collect(); SkillManifest { name: name.into(), description: description.chars().take(500).collect(), source: source.into(), valid, disabled_model_invocation: manual_only, allowed_tools: tools.as_deref().map(|value| value.split(',').map(|item| item.trim().to_string()).filter(|item| !item.is_empty()).collect()).unwrap_or_default(), trigger_terms: terms, capabilities, use_when: description.chars().take(300).collect(), risk: risk.into(), fingerprint: fingerprint(content), indexed_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs().to_string() } }
fn supporting_files(path: &Path) -> Vec<String> { std::fs::read_dir(path.parent().unwrap_or(path)).into_iter().flatten().flatten().filter_map(|entry| { let path = entry.path(); path.is_file().then(|| path.file_name().map(|name| name.to_string_lossy().into_owned())).flatten() }).filter(|name| name != "SKILL.md").collect() }
fn collect(root: &Path, source_id: &str, skills: &mut Vec<PiSkill>, seen: &mut HashSet<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() { let path = entry.path(); if path.is_dir() { collect(&path, source_id, skills, seen); continue } if !path.file_name().is_some_and(|name| name == "SKILL.md") { continue }
        let path = path.canonicalize().unwrap_or(path); if !seen.insert(path.clone()) { continue }
        let location = path.to_string_lossy().into_owned(); let content = match std::fs::read_to_string(&path) { Ok(value) => value, Err(error) => { skills.push(PiSkill { name: "Invalid skill".into(), description: "".into(), location, source_id: source_id.into(), valid: false, invalid_reason: Some(format!("cannot read SKILL.md: {error}")), manual_only: false, license: None, compatibility: None, metadata: None, allowed_tools: None, frontmatter: "".into(), content: "".into(), supporting_files: vec![], manifest: None }); continue } };
        match frontmatter(&content) { Ok((raw, _)) => { let name = value(raw, "name"); let description = value(raw, "description"); let reason = match (&name, &description) { (None, _) => Some("frontmatter is missing name".into()), (_, None) => Some("frontmatter is missing description".into()), (Some(name), _) if name.trim().is_empty() => Some("frontmatter name is empty".into()), (_, Some(description)) if description.trim().is_empty() => Some("frontmatter description is empty".into()), _ => None }; let valid = reason.is_none(); let skill_name = name.clone().filter(|value| !value.trim().is_empty()).unwrap_or_else(|| "Invalid skill".into()); let skill_description = description.clone().unwrap_or_default(); let manual_only = bool_value(raw, "disable-model-invocation"); let allowed_tools = value(raw, "allowed-tools"); let manifest = manifest(&skill_name, &skill_description, source_id, valid, manual_only, allowed_tools.clone(), &content); skills.push(PiSkill { name: skill_name, description: skill_description, location, source_id: source_id.into(), valid, invalid_reason: reason, manual_only, license: value(raw, "license"), compatibility: value(raw, "compatibility"), metadata: value(raw, "metadata"), allowed_tools, frontmatter: raw.into(), manifest: Some(manifest), content, supporting_files: supporting_files(&path) }); }, Err(reason) => skills.push(PiSkill { name: "Invalid skill".into(), description: "".into(), location, source_id: source_id.into(), valid: false, invalid_reason: Some(reason), manual_only: false, license: None, compatibility: None, metadata: None, allowed_tools: None, frontmatter: "".into(), content, supporting_files: supporting_files(&path), manifest: None }) }
    }
}
fn discover(roots: Vec<(String, String, PathBuf)>) -> SkillCatalog { let mut skills = Vec::new(); let mut seen = HashSet::new(); let sources = roots.into_iter().map(|(id, label, path)| { let result = std::fs::read_dir(&path); let source = SkillSource { id: id.clone(), label, path: path.to_string_lossy().into(), readable: result.is_ok(), error: result.err().map(|error| error.to_string()) }; if source.readable { collect(&path, &id, &mut skills, &mut seen) }; source }).collect(); skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase())); SkillCatalog { skills, sources } }
#[derive(Debug, Clone, serde::Deserialize)] pub struct GitSkillRequest { pub url: String, pub reference: Option<String>, pub path: Option<String>, pub selected_paths: Vec<String>, pub replace: bool, pub source_type: Option<String> }
#[derive(Debug, Clone, Serialize)] pub struct SkillPreview { pub repository: String, pub reference: String, pub skills: Vec<PiSkill>, pub error: Option<String> }
#[derive(Debug, Clone, Serialize)] pub struct SkillInstallResult { pub installed: Vec<String>, pub target: String, pub log: Vec<String> }
fn canonical_git_url(input: &str) -> Result<String, String> { let input = input.trim(); if input.split('/').count() == 2 && !input.contains("://") && !input.contains(' ') { return Ok(format!("https://github.com/{input}.git")) } if input.starts_with("https://") || input.starts_with("git@") { if input.contains("localhost") || input.starts_with("file:") || input.contains("..") { return Err("local, file, and traversal Git URLs are not allowed".into()) } return Ok(input.into()) } Err("enter an HTTPS Git URL, SSH Git URL, or owner/repository shorthand".into()) }
fn safe_subpath(value: &str) -> Result<&Path, String> { let path = Path::new(value); if path.is_absolute() || path.components().any(|part| matches!(part, std::path::Component::ParentDir | std::path::Component::Prefix(_))) { return Err("skill path must be a relative path without traversal".into()) } Ok(path) }
fn temp_clone() -> PathBuf { std::env::temp_dir().join(format!("crc-skill-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos())) }
fn clone_repo(url: &str, reference: Option<&str>) -> Result<(PathBuf, String), String> { let dir = temp_clone(); let dir_text = dir.to_str().ok_or("temporary path is not UTF-8")?; let output = Command::new("git").args(["-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", "--filter=blob:none", "--no-tags", url, dir_text]).stdin(Stdio::null()).output().map_err(|e| format!("Git is unavailable: {e}"))?; if !output.status.success() { let _ = std::fs::remove_dir_all(&dir); return Err(format!("clone failed: {}", String::from_utf8_lossy(&output.stderr).trim())) } if let Some(reference) = reference.filter(|value| !value.trim().is_empty()) { if reference.starts_with('-') || reference.contains(['\n', '\r']) { let _ = std::fs::remove_dir_all(&dir); return Err("invalid Git reference".into()) } let output = Command::new("git").args(["-C", dir.to_str().unwrap(), "checkout", "--detach", reference]).stdin(Stdio::null()).output().map_err(|e| e.to_string())?; if !output.status.success() { let _ = std::fs::remove_dir_all(&dir); return Err(format!("checkout failed: {}", String::from_utf8_lossy(&output.stderr).trim())) } } let output = Command::new("git").args(["-C", dir.to_str().unwrap(), "rev-parse", "HEAD"]).output().map_err(|e| e.to_string())?; Ok((dir, String::from_utf8_lossy(&output.stdout).trim().into())) }
fn staged_skills(repo: &Path, path: Option<&str>) -> Result<Vec<PiSkill>, String> { let root = match path.filter(|value| !value.trim().is_empty()) { Some(value) => repo.join(safe_subpath(value)?), None => repo.to_path_buf() }; if !root.starts_with(repo) { return Err("skill path escapes cloned repository".into()) } let mut skills = Vec::new(); collect(&root, "preview", &mut skills, &mut HashSet::new()); if skills.len() > 50 { return Err("repository contains more than 50 skills; specify a skill path".into()) } Ok(skills) }
#[tauri::command] pub fn preview_git_skills(request: GitSkillRequest) -> Result<SkillPreview, String> { let url = canonical_git_url(&request.url)?; let (repo, commit) = clone_repo(&url, request.reference.as_deref())?; let skills = staged_skills(&repo, request.path.as_deref()); let _ = std::fs::remove_dir_all(repo); Ok(SkillPreview { repository: url, reference: commit, skills: skills?, error: None }) }
#[tauri::command] pub fn install_git_skills(request: GitSkillRequest) -> Result<SkillInstallResult, String> { let url = canonical_git_url(&request.url)?; if request.selected_paths.is_empty() { return Err("select at least one validated skill".into()) } let (repo, commit) = clone_repo(&url, request.reference.as_deref())?; let result = (|| { let skills = staged_skills(&repo, request.path.as_deref())?; let target_root = home()?.join(".pi/agent/skills"); std::fs::create_dir_all(&target_root).map_err(|e| e.to_string())?; let mut installed = Vec::new(); for selected in &request.selected_paths { let skill = skills.iter().find(|item| item.name == *selected).ok_or("selected skill is not a valid discovered skill")?; let skill_path = PathBuf::from(&skill.location); let source = skill_path.parent().ok_or("skill folder unavailable")?.to_path_buf(); if !skill.valid { return Err(format!("{} is invalid: {}", skill.name, skill.invalid_reason.clone().unwrap_or_default())) } let destination = target_root.join(&skill.name); if !destination.starts_with(&target_root) { return Err("unsafe skill name".into()) } if destination.exists() && !request.replace { return Err(format!("{} already exists; choose Replace to continue", skill.name)) } let backup = home()?.join("Library/Application Support/command-rdev-center/skill-backups").join(format!("{}-{}", skill.name, SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs())); if destination.exists() { std::fs::create_dir_all(backup.parent().unwrap()).map_err(|e| e.to_string())?; std::fs::rename(&destination, &backup).map_err(|e| e.to_string())?; } let copy = Command::new("cp").args(["-R", source.to_str().ok_or("path")?, destination.to_str().ok_or("path")?]).status().map_err(|e| e.to_string()); if copy.map(|status| status.success()).unwrap_or(false) && std::fs::read_to_string(destination.join("SKILL.md")).ok().and_then(|text| frontmatter(&text).ok().map(|(raw, _)| (value(raw, "name"), value(raw, "description")))).is_some_and(|(name, description)| name.is_some() && description.is_some()) { let provenance = serde_json::json!({"installedAt": SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(), "sourceType": request.source_type.clone().unwrap_or_else(|| "git".into()), "repository": url.clone(), "ref": commit.clone(), "sourceSubpath": selected}); std::fs::write(destination.join(".crc-provenance.json"), serde_json::to_vec_pretty(&provenance).unwrap()).map_err(|e| e.to_string())?; installed.push(skill.name.clone()); } else { let _ = std::fs::remove_dir_all(&destination); if backup.exists() { let _ = std::fs::rename(backup, &destination); } return Err(format!("failed to install {}; existing skill was restored", skill.name)) } } Ok(SkillInstallResult { installed, target: target_root.to_string_lossy().into(), log: vec!["Cloned without hooks or credentials.".into(), "Validated SKILL.md after copy.".into()] }) })(); let _ = std::fs::remove_dir_all(repo); result }
#[tauri::command] pub fn list_pi_skills() -> Result<SkillCatalog, String> { Ok(discover(sources()?)) }
#[tauri::command] pub fn list_skill_manifests() -> Result<Vec<SkillManifest>, String> { Ok(discover(sources()?).skills.into_iter().filter_map(|skill| skill.manifest.filter(|manifest| manifest.valid)).collect()) }
#[tauri::command] pub fn load_skill_instructions(name: String) -> Result<String, String> { let skill = discover(sources()?).skills.into_iter().find(|skill| skill.valid && skill.name == name).ok_or("valid skill not found")?; Ok(skill.content) }

#[cfg(test)] mod tests { use super::*; use std::time::{SystemTime, UNIX_EPOCH}; fn temp(name: &str) -> PathBuf { let path = std::env::temp_dir().join(format!("crc-skills-{name}-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos())); std::fs::create_dir_all(&path).unwrap(); path }
    #[test] fn discovers_nested_valid_skill() { let root = temp("nested"); let path = root.join("nested/a/SKILL.md"); std::fs::create_dir_all(path.parent().unwrap()).unwrap(); std::fs::write(&path, "---\nname: Test\ndescription: Works\nlicense: MIT\n---\n# Test").unwrap(); let catalog = discover(vec![("test".into(), "Test".into(), root.clone())]); assert_eq!(catalog.skills[0].name, "Test"); assert!(catalog.skills[0].valid); std::fs::remove_dir_all(root).unwrap(); }
    #[test] fn reports_invalid_frontmatter() { let root = temp("invalid"); std::fs::write(root.join("SKILL.md"), "# no frontmatter").unwrap(); let catalog = discover(vec![("test".into(), "Test".into(), root.clone())]); assert!(!catalog.skills[0].valid); assert!(catalog.skills[0].invalid_reason.as_deref().unwrap().contains("opening")); std::fs::remove_dir_all(root).unwrap(); }
    #[test] fn reports_missing_directory() { let root = std::env::temp_dir().join("crc-skills-does-not-exist"); let catalog = discover(vec![("test".into(), "Test".into(), root)]); assert!(!catalog.sources[0].readable); }
    #[test] fn bundled_screenshot_skill_is_valid() { let root = temp("bundled"); let path = root.join("screenshot-to-existing-ui/SKILL.md"); std::fs::create_dir_all(path.parent().unwrap()).unwrap(); std::fs::write(&path, include_str!("../skills/screenshot-to-existing-ui/SKILL.md")).unwrap(); let catalog = discover(vec![("bundled".into(), "Bundled".into(), root.clone())]); assert_eq!(catalog.skills[0].name, "screenshot-to-existing-ui"); assert!(catalog.skills[0].valid); std::fs::remove_dir_all(root).unwrap(); }
}
