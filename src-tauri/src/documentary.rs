use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Emitter;

const VERSION: u32 = 1;
const MAX_TEXT: usize = 20_000;
static LOCK: Mutex<()> = Mutex::new(());
static GENERATION_RUNNING: Mutex<bool> = Mutex::new(false);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceSnapshot {
    pub id: String,
    pub url: String,
    pub canonical_url: String,
    pub title: String,
    pub cited: bool,
    pub approved: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Claim {
    pub id: String,
    pub text: String,
    pub source_ids: Vec<String>,
    pub status: ClaimStatus,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ClaimStatus {
    Verified,
    Uncertain,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetNeed {
    pub id: String,
    pub kind: AssetKind,
    pub description: String,
    pub orientation: Orientation,
    #[serde(default)]
    pub minimum_resolution: Option<String>,
    pub required: bool,
    pub purpose: String,
    pub rights_reminder: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AssetKind {
    Background,
    Subject,
    Prop,
    Overlay,
    Narration,
    Music,
    Sfx,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Orientation {
    Portrait,
    Landscape,
    Square,
    Transparent,
    Audio,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scene {
    pub id: String,
    pub order: u8,
    pub voiceover: String,
    pub claim_ids: Vec<String>,
    pub on_screen_text: Vec<String>,
    pub emotional_beat: String,
    pub visual_concept: String,
    pub motion_suggestion: MotionSuggestion,
    pub asset_needs: Vec<AssetNeed>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MotionSuggestion {
    PaperEntrance,
    Drift,
    Parallax,
    HardCut,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Script {
    pub title: String,
    pub hook: String,
    pub narration: String,
    pub claims: Vec<Claim>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PackageState {
    Brief,
    Researching,
    ReviewingSources,
    Generating,
    Editing,
    Ready,
    Failed,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentaryPackage {
    pub version: u32,
    pub id: String,
    pub topic: String,
    pub language: String,
    pub audience: String,
    pub duration_seconds: u8,
    pub state: PackageState,
    #[serde(default)]
    pub research_run_id: Option<String>,
    #[serde(default)]
    pub sources: Vec<SourceSnapshot>,
    #[serde(default)]
    pub script: Option<Script>,
    #[serde(default)]
    pub scenes: Vec<Scene>,
    #[serde(default)]
    pub error: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInput {
    pub topic: String,
    pub language: String,
    pub audience: String,
    pub duration_seconds: u8,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentaryData {
    pub packages: Vec<DocumentaryPackage>,
    pub warnings: Vec<String>,
}

fn now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
fn dir() -> Result<PathBuf, String> {
    let p = crate::projects::config_path()
        .parent()
        .ok_or("config has no parent")?
        .join("documentaries/packages");
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p)
}
fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Err("invalid documentary package id".into())
    } else {
        Ok(())
    }
}
fn path(d: &Path, id: &str) -> Result<PathBuf, String> {
    valid_id(id)?;
    Ok(d.join(format!("{id}.json")))
}
fn write_at(d: &Path, package: &DocumentaryPackage) -> Result<(), String> {
    let target = path(d, &package.id)?;
    let backup = target.with_extension("json.bak");
    let temp = target.with_extension(format!("json.tmp.{}.{}", std::process::id(), now()));
    let result = (|| {
        let bytes = serde_json::to_vec_pretty(package).map_err(|e| e.to_string())?;
        let mut f = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        f.write_all(&bytes)
            .and_then(|_| f.write_all(b"\n"))
            .and_then(|_| f.sync_all())
            .map_err(|e| e.to_string())?;
        if target.exists() {
            std::fs::copy(&target, &backup)
                .and_then(|_| OpenOptions::new().read(true).open(&backup)?.sync_all())
                .map_err(|e| e.to_string())?;
        }
        std::fs::rename(&temp, &target).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}
fn read_one(p: &Path) -> Result<DocumentaryPackage, String> {
    serde_json::from_slice(&std::fs::read(p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn load_at(d: &Path) -> DocumentaryData {
    let mut packages = vec![];
    let mut warnings = vec![];
    let Ok(entries) = std::fs::read_dir(d) else {
        return DocumentaryData { packages, warnings };
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        match read_one(&p).or_else(|_| read_one(&p.with_extension("json.bak"))) {
            Ok(package) if package.version == VERSION => packages.push(package),
            Ok(_) => warnings.push(format!("Unsupported documentary snapshot: {}", p.display())),
            Err(_) => warnings.push(format!(
                "Could not read documentary snapshot: {}",
                p.display()
            )),
        }
    }
    packages.sort_by(|a, b| a.id.cmp(&b.id));
    DocumentaryData { packages, warnings }
}
fn bounded(s: &str) -> bool {
    !s.trim().is_empty() && s.chars().count() <= MAX_TEXT
}
fn validate(p: &DocumentaryPackage) -> Result<(), String> {
    if p.version != VERSION
        || !bounded(&p.topic)
        || !bounded(&p.language)
        || !bounded(&p.audience)
        || !matches!(p.duration_seconds, 30 | 45 | 60)
    {
        return Err("invalid documentary brief".into());
    }
    let source_ids: HashSet<_> = p.sources.iter().map(|s| s.id.as_str()).collect();
    if source_ids.len() != p.sources.len()
        || p.sources.iter().any(|s| {
            !bounded(&s.id) || !bounded(&s.url) || !bounded(&s.canonical_url) || !bounded(&s.title)
        })
    {
        return Err("invalid documentary sources".into());
    }
    if let Some(script) = &p.script {
        if !bounded(&script.title) || !bounded(&script.hook) || !bounded(&script.narration) {
            return Err("invalid script".into());
        }
        let claims: HashSet<_> = script.claims.iter().map(|c| c.id.as_str()).collect();
        if claims.len() != script.claims.len() {
            return Err("duplicate claim id".into());
        }
        for claim in &script.claims {
            if !bounded(&claim.id) || !bounded(&claim.text) {
                return Err("invalid claim".into());
            }
            if claim.status == ClaimStatus::Verified
                && (claim.source_ids.is_empty()
                    || claim
                        .source_ids
                        .iter()
                        .any(|id| !p.sources.iter().any(|s| s.id == *id && s.approved)))
            {
                return Err("verified claims require approved sources".into());
            }
            if claim.status == ClaimStatus::Uncertain && !claim.source_ids.is_empty() {
                return Err("uncertain claims cannot cite sources".into());
            }
        }
        if !(5..=8).contains(&p.scenes.len()) {
            return Err("script requires 5–8 scenes".into());
        }
        for (index, scene) in p.scenes.iter().enumerate() {
            if scene.order != index as u8 + 1
                || !bounded(&scene.id)
                || !bounded(&scene.voiceover)
                || !bounded(&scene.emotional_beat)
                || !bounded(&scene.visual_concept)
                || scene
                    .claim_ids
                    .iter()
                    .any(|id| !claims.contains(id.as_str()))
                || !scene
                    .asset_needs
                    .iter()
                    .any(|a| a.required && a.orientation != Orientation::Audio)
            {
                return Err("invalid scene or required visual asset".into());
            }
            for asset in &scene.asset_needs {
                if !bounded(&asset.id)
                    || !bounded(&asset.description)
                    || !bounded(&asset.purpose)
                    || !bounded(&asset.rights_reminder)
                {
                    return Err("invalid asset need".into());
                }
            }
        }
        if !p
            .scenes
            .iter()
            .flat_map(|s| &s.asset_needs)
            .any(|a| a.kind == AssetKind::Narration && a.required)
        {
            return Err("script requires a narration asset need".into());
        }
    } else if !p.scenes.is_empty() {
        return Err("scenes require script".into());
    }
    Ok(())
}
fn save(app: &tauri::AppHandle, p: &DocumentaryPackage) -> Result<(), String> {
    validate(p)?;
    write_at(&dir()?, p)?;
    let _ = app.emit(
        "documentary-changed",
        serde_json::json!({"package_id":p.id,"state":p.state}),
    );
    Ok(())
}

fn generation_prompt(p: &DocumentaryPackage) -> Result<String, String> {
    let sources: Vec<_> = p
        .sources
        .iter()
        .filter(|source| source.approved)
        .map(|source| serde_json::json!({"id":source.id,"title":source.title,"url":source.url}))
        .collect();
    if sources.is_empty() {
        return Err("approve at least one source before generation".into());
    }
    Ok(format!(
        "Generate a {duration}-second vertical documentary package about {topic} for {audience} in {language}. Use ONLY these approved source IDs for verified claims: {sources}. Return ONLY one JSON object with fields script and scenes. script={{title,hook,narration,claims:[{{id,text,sourceIds,status}}]}}. scenes has 5-8 ordered entries with {{id,order,voiceover,claimIds,onScreenText,emotionalBeat,visualConcept,motionSuggestion,assetNeeds}}. status is verified or uncertain; uncertain sourceIds must be empty. verified sourceIds must be approved IDs. motionSuggestion is paper_entrance, drift, parallax, or hard_cut. Every scene needs a required non-audio visual asset. At least one required narration asset exists. Each asset need is {{id,kind,description,orientation,minimumResolution?,required,purpose,rightsReminder}}. No markdown.",
        duration = p.duration_seconds,
        topic = serde_json::to_string(&p.topic).map_err(|e| e.to_string())?,
        audience = serde_json::to_string(&p.audience).map_err(|e| e.to_string())?,
        language = serde_json::to_string(&p.language).map_err(|e| e.to_string())?,
        sources = serde_json::to_string(&sources).map_err(|e| e.to_string())?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GenerationOutput {
    script: Script,
    scenes: Vec<Scene>,
}

fn parse_generation(raw: &str, base: &DocumentaryPackage) -> Result<DocumentaryPackage, String> {
    let raw = raw.trim();
    if raw.contains("```") {
        return Err("generation must be a JSON object without markdown".into());
    }
    let output: GenerationOutput = serde_json::from_str(raw)
        .map_err(|error| format!("generation JSON is invalid: {error}"))?;
    let mut generated = base.clone();
    generated.script = Some(output.script);
    generated.scenes = output.scenes;
    generated.state = PackageState::Ready;
    generated.error = None;
    validate(&generated)?;
    Ok(generated)
}

fn repair_prompt(output: &str, error: &str) -> String {
    format!(
        "Return a corrected JSON object only. Previous output: {output}\nValidation error: {error}"
    )
}

#[tauri::command]
pub fn generate_documentary_package(
    app: tauri::AppHandle,
    package_id: String,
) -> Result<(), String> {
    let original = {
        let _guard = LOCK.lock().map_err(|_| "documentary store poisoned")?;
        let mut generation_running = GENERATION_RUNNING
            .lock()
            .map_err(|_| "documentary generation lock poisoned")?;
        if *generation_running {
            return Err("documentary package generation is already running".into());
        }
        let mut package = read_one(&path(&dir()?, &package_id)?)?;
        let _ = generation_prompt(&package)?;
        package.state = PackageState::Generating;
        package.error = None;
        save(&app, &package)?;
        *generation_running = true;
        package
    };
    std::thread::spawn(move || generate_documentary_in_background(app, original));
    Ok(())
}

fn generate_documentary_in_background(app: tauri::AppHandle, original: DocumentaryPackage) {
    let result = (|| {
        let prompt = generation_prompt(&original)?;
        let session_id = format!("documentary-generate-{}-{}", original.id, now());
        let first =
            crate::pi_rpc::generate_documentary_once(app.clone(), session_id.clone(), prompt)?;
        match parse_generation(&first, &original) {
            Ok(package) => Ok(package),
            Err(validation_error) => {
                let repaired = crate::pi_rpc::repair_documentary_once(
                    session_id,
                    repair_prompt(&first, &validation_error),
                )?;
                parse_generation(&repaired, &original)
                    .map_err(|error| format!("generation failed after one repair: {error}"))
            }
        }
    })();

    let Ok(_guard) = LOCK.lock() else { return };
    let package = match result {
        Ok(package) => package,
        Err(error) => DocumentaryPackage {
            state: PackageState::Failed,
            error: Some(error),
            ..original
        },
    };
    let _ = save(&app, &package);
    if let Ok(mut generation_running) = GENERATION_RUNNING.lock() {
        *generation_running = false;
    }
}

#[tauri::command]
pub fn create_documentary_package(
    app: tauri::AppHandle,
    input: CreateInput,
) -> Result<DocumentaryPackage, String> {
    let _guard = LOCK.lock().map_err(|_| "documentary store poisoned")?;
    let p = DocumentaryPackage {
        version: VERSION,
        id: format!("documentary-{}", now()),
        topic: input.topic,
        language: input.language,
        audience: input.audience,
        duration_seconds: input.duration_seconds,
        state: PackageState::Brief,
        research_run_id: None,
        sources: vec![],
        script: None,
        scenes: vec![],
        error: None,
    };
    save(&app, &p)?;
    Ok(p)
}
#[tauri::command]
pub fn list_documentary_packages() -> Result<DocumentaryData, String> {
    let _guard = LOCK.lock().map_err(|_| "documentary store poisoned")?;
    Ok(load_at(&dir()?))
}
#[tauri::command]
pub fn get_documentary_package(package_id: String) -> Result<DocumentaryPackage, String> {
    let _guard = LOCK.lock().map_err(|_| "documentary store poisoned")?;
    read_one(&path(&dir()?, &package_id)?)
}
#[tauri::command]
pub fn update_documentary_package(
    app: tauri::AppHandle,
    package: DocumentaryPackage,
) -> Result<DocumentaryPackage, String> {
    let _guard = LOCK.lock().map_err(|_| "documentary store poisoned")?;
    let d = dir()?;
    let existing = read_one(&path(&d, &package.id)?)?;
    if existing.research_run_id != package.research_run_id {
        return Err("research attachment is immutable".into());
    }
    let approved: HashSet<_> = package
        .sources
        .iter()
        .filter(|source| source.approved)
        .map(|source| source.id.as_str())
        .collect();
    if existing.sources.len() != package.sources.len()
        || existing
            .sources
            .iter()
            .zip(&package.sources)
            .any(|(saved, next)| {
                saved.id != next.id
                    || saved.url != next.url
                    || saved.canonical_url != next.canonical_url
                    || saved.title != next.title
                    || saved.cited != next.cited
            })
        || existing
            .sources
            .iter()
            .any(|source| source.approved != approved.contains(source.id.as_str()))
    {
        return Err("research snapshots are immutable; approve sources separately".into());
    }
    save(&app, &package)?;
    Ok(package)
}
#[tauri::command]
pub fn delete_documentary_package(app: tauri::AppHandle, package_id: String) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|_| "documentary store poisoned")?;
    let p = path(&dir()?, &package_id)?;
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(p.with_extension("json.bak"));
    }
    let _ = app.emit(
        "documentary-changed",
        serde_json::json!({"package_id":package_id,"state":"deleted"}),
    );
    Ok(())
}
fn source_snapshot(index: usize, source: &crate::deep_research::Source) -> SourceSnapshot {
    SourceSnapshot {
        id: format!("source-{}", index + 1),
        url: source.url.clone(),
        canonical_url: source.canonical_url.clone(),
        title: if bounded(&source.title) {
            source.title.clone()
        } else if bounded(&source.canonical_url) {
            source.canonical_url.clone()
        } else {
            source.url.clone()
        },
        cited: source.cited,
        approved: false,
    }
}

#[tauri::command]
pub fn attach_documentary_research(
    app: tauri::AppHandle,
    package_id: String,
    research_run_id: String,
) -> Result<DocumentaryPackage, String> {
    let _guard = LOCK.lock().map_err(|_| "documentary store poisoned")?;
    let run = crate::deep_research::completed_documentary_research(&research_run_id)?;
    let d = dir()?;
    let mut p = read_one(&path(&d, &package_id)?)?;
    p.research_run_id = Some(research_run_id);
    p.sources = run
        .sources
        .iter()
        .enumerate()
        .map(|(i, source)| source_snapshot(i, source))
        .collect();
    p.state = PackageState::ReviewingSources;
    p.error = None;
    save(&app, &p)?;
    Ok(p)
}
#[tauri::command]
pub fn approve_documentary_source(
    app: tauri::AppHandle,
    package_id: String,
    source_id: String,
    approved: bool,
) -> Result<DocumentaryPackage, String> {
    let _guard = LOCK.lock().map_err(|_| "documentary store poisoned")?;
    let d = dir()?;
    let mut p = read_one(&path(&d, &package_id)?)?;
    let source = p
        .sources
        .iter_mut()
        .find(|s| s.id == source_id)
        .ok_or("source not found")?;
    source.approved = approved;
    save(&app, &p)?;
    Ok(p)
}
#[tauri::command]
pub fn export_documentary_package(package_id: String, directory: String) -> Result<String, String> {
    let _guard = LOCK.lock().map_err(|_| "documentary store poisoned")?;
    let p = read_one(&path(&dir()?, &package_id)?)?;
    validate(&p)?;
    let base = PathBuf::from(directory);
    if !base.is_absolute() || !base.is_dir() {
        return Err("export directory must be an existing absolute directory".into());
    }
    let output = base.join(&p.id);
    std::fs::create_dir_all(&output).map_err(|e| e.to_string())?;
    let research = format!(
        "# {}\n\n{}\n",
        p.topic,
        p.sources
            .iter()
            .map(|s| format!("- [{}]({})", s.title, s.url))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let script = p
        .script
        .as_ref()
        .map(|s| format!("# {}\n\n{}\n\n{}\n", s.title, s.hook, s.narration))
        .unwrap_or_default();
    let checklist = p
        .scenes
        .iter()
        .flat_map(|s| {
            s.asset_needs.iter().map(move |a| {
                format!(
                    "- [{}] scene {}: {} — {}",
                    if a.required { "required" } else { "optional" },
                    s.order,
                    a.description,
                    a.rights_reminder
                )
            })
        })
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(output.join("research.md"), research).map_err(|e| e.to_string())?;
    std::fs::write(
        output.join("sources.json"),
        serde_json::to_vec_pretty(&p.sources).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(output.join("script.md"), script).map_err(|e| e.to_string())?;
    std::fs::write(
        output.join("scenes.json"),
        serde_json::to_vec_pretty(&p.scenes).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(
        output.join("asset-checklist.md"),
        format!("# Asset checklist\n\n{checklist}\n"),
    )
    .map_err(|e| e.to_string())?;
    Ok(output.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> DocumentaryPackage {
        DocumentaryPackage {
            version: VERSION,
            id: "test".into(),
            topic: "topic".into(),
            language: "en".into(),
            audience: "all".into(),
            duration_seconds: 30,
            state: PackageState::Brief,
            research_run_id: None,
            sources: vec![],
            script: None,
            scenes: vec![],
            error: None,
        }
    }
    #[test]
    fn snapshot_recovers_backup_and_isolates_corruption() {
        let d = std::env::temp_dir().join(format!("crc-doc-{}", now()));
        std::fs::create_dir_all(&d).unwrap();
        let p = sample();
        write_at(&d, &p).unwrap();
        write_at(&d, &p).unwrap();
        std::fs::write(path(&d, "test").unwrap(), "bad").unwrap();
        std::fs::write(path(&d, "bad").unwrap(), "bad").unwrap();
        let data = load_at(&d);
        assert_eq!(data.packages, vec![p]);
        assert_eq!(data.warnings.len(), 1);
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn blank_research_source_title_uses_canonical_url_and_validates() {
        let source = crate::deep_research::Source {
            url: "https://example.com/article".into(),
            canonical_url: "https://example.com/article".into(),
            title: " ".into(),
            cited: true,
        };
        let mut p = sample();
        p.sources = vec![source_snapshot(0, &source)];
        assert_eq!(p.sources[0].title, source.canonical_url);
        assert!(validate(&p).is_ok());
    }
    #[test]
    fn attachment_copy_is_independent() {
        let mut source = SourceSnapshot {
            id: "source-1".into(),
            url: "https://a".into(),
            canonical_url: "https://a".into(),
            title: "A".into(),
            cited: true,
            approved: false,
        };
        let p = sample();
        let copied = source.clone();
        source.title = "changed".into();
        assert_ne!(source, copied);
        assert!(p.sources.is_empty());
    }
    #[test]
    fn validation_requires_approved_sources_for_verified_claims() {
        let mut p = sample();
        p.script = Some(Script {
            title: "t".into(),
            hook: "h".into(),
            narration: "n".into(),
            claims: vec![Claim {
                id: "c".into(),
                text: "fact".into(),
                source_ids: vec!["missing".into()],
                status: ClaimStatus::Verified,
            }],
        });
        assert!(validate(&p).is_err());
    }
    #[test]
    fn generation_rejects_untrusted_output_without_mutating_draft() {
        let p = sample();
        let output = r#"{"script":{"title":"t","hook":"h","narration":"n","claims":[]},"scenes":[{"id":"1","order":1,"voiceover":"v","claimIds":[],"onScreenText":[],"emotionalBeat":"e","visualConcept":"v","motionSuggestion":"unsupported","assetNeeds":[]}]}"#;
        assert!(parse_generation(output, &p).is_err());
        assert_eq!(p, sample());
    }
}
