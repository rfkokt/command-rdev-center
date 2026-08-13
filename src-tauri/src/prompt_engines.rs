use serde::{Deserialize, Serialize};
use std::{fs::OpenOptions, io::Write, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};

const VERSION: u32 = 1;
const MAX_PROMPT: usize = 1_000_000;
const MAX_FIELD: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ResearchMode { Auto, Review }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResearchSettings {
    pub enabled: bool,
    pub mode: ResearchMode,
    #[serde(default)]
    pub instructions: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PromptEngine {
    pub version: u32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub description: String,
    pub system_prompt: String,
    #[serde(default)]
    pub starter_message: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub thinking: String,
    pub research: ResearchSettings,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Deserialize)]
pub struct SavePromptEngineInput {
    pub id: Option<String>,
    pub name: String,
    pub icon: String,
    pub description: String,
    pub system_prompt: String,
    pub starter_message: String,
    pub model: String,
    pub thinking: String,
    pub research: ResearchSettings,
}

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }
fn dir() -> Result<PathBuf, String> {
    let path = crate::projects::config_path().parent().ok_or("config has no parent")?.join("prompt-engines");
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}
fn valid_id(id: &str) -> bool { !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') }
fn path(id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) { return Err("invalid engine id".into()); }
    Ok(dir()?.join(format!("{id}.json")))
}
fn write_engine(engine: &PromptEngine) -> Result<(), String> {
    let target = path(&engine.id)?;
    let temp = target.with_extension(format!("json.tmp.{}", std::process::id()));
    let bytes = serde_json::to_vec_pretty(engine).map_err(|e| e.to_string())?;
    let mut file = OpenOptions::new().create(true).truncate(true).write(true).open(&temp).map_err(|e| e.to_string())?;
    file.write_all(&bytes).and_then(|_| file.write_all(b"\n")).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &target).map_err(|e| e.to_string())
}
fn documentary() -> PromptEngine {
    let timestamp = now();
    PromptEngine {
        version: VERSION, id: "documentary-engine".into(), name: "Documentary Engine".into(), icon: "D".into(),
        description: "Research-backed 40-second documentary paper collage workflow".into(),
        system_prompt: r#"You are an elite documentary writer and editorial paper collage director. Take a true-story topic through a stateful workflow, one input at a time. Do not use em dashes.

Start by asking exactly: "What's the story? Give me a few lines: the topic, the angle, or the exact idea you want covered."
After the topic, write a factual continuous narration for a 40-second video, 95 to 105 words, with a precise cold open and restrained documentary tone. End on a short cliffhanger. Then wait for `voice` or `proceed`.
On `voice`, provide an ElevenLabs-ready narration and settings: calm deadpan narrator, about 155 wpm, stability 55, similarity 80, low style, speaker boost on. Wait for `proceed`.
On `proceed`, split narration into exactly 10 four-second visual beats and wait for `next`.
On the next turns, produce in order: exactly 10 self-contained 16:9 editorial paper-collage image prompts, exactly 10 matching locked-camera four-second stop-motion animation prompts, then 3 high-contrast thumbnail prompts. Stop after every stage and wait for `next`.
Keep recurring subjects visually identical. Never depict a child's face. Represent real people as obscured or halftone cutouts, never as recognizable photorealistic likenesses. Keep facts accurate, use supplied research evidence, and clearly qualify uncertainty. Output structure and files must follow the user's topic and this workflow."#.into(),
        starter_message: "What's the story? Give me the topic and angle.".into(), model: String::new(), thinking: String::new(),
        research: ResearchSettings { enabled: true, mode: ResearchMode::Auto, instructions: "Research chronology, high-value facts, primary or reputable sources, and important contradictions before answering. Cite source URLs in the research context, then follow the engine output format.".into() },
        created_at: timestamp, updated_at: timestamp,
    }
}
fn ensure_default() -> Result<(), String> { let engine = documentary(); if !path(&engine.id)?.exists() { write_engine(&engine)?; } Ok(()) }
fn validate(input: &SavePromptEngineInput) -> Result<(), String> {
    if input.name.trim().is_empty() { return Err("name required".into()); }
    if input.system_prompt.trim().is_empty() { return Err("system prompt required".into()); }
    if input.system_prompt.len() > MAX_PROMPT { return Err("system prompt exceeds 1 MB".into()); }
    if [&input.name, &input.icon, &input.description, &input.starter_message, &input.model, &input.thinking, &input.research.instructions].iter().any(|v| v.len() > MAX_FIELD) { return Err("engine field is too long".into()); }
    Ok(())
}
fn generate_id() -> String { format!("engine-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()) }

#[tauri::command]
pub fn list_prompt_engines() -> Result<Vec<PromptEngine>, String> {
    ensure_default()?;
    let mut engines = Vec::new();
    for entry in std::fs::read_dir(dir()?).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|v| v.to_str()) != Some("json") { continue; }
        let raw = std::fs::read_to_string(&path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
        let engine = serde_json::from_str(&raw).map_err(|e| format!("Invalid prompt engine {}: {e}", path.display()))?;
        engines.push(engine);
    }
    engines.sort_by(|a: &PromptEngine, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(engines)
}

#[tauri::command]
pub fn save_prompt_engine(input: SavePromptEngineInput) -> Result<PromptEngine, String> {
    validate(&input)?;
    let timestamp = now();
    let id = input.id.unwrap_or_else(generate_id);
    let created_at = if path(&id)?.exists() { std::fs::read_to_string(path(&id)?).ok().and_then(|v| serde_json::from_str::<PromptEngine>(&v).ok()).map(|v| v.created_at).unwrap_or(timestamp) } else { timestamp };
    let engine = PromptEngine { version: VERSION, id, name: input.name.trim().into(), icon: input.icon.trim().into(), description: input.description.trim().into(), system_prompt: input.system_prompt, starter_message: input.starter_message.trim().into(), model: input.model.trim().into(), thinking: input.thinking.trim().into(), research: input.research, created_at, updated_at: timestamp };
    write_engine(&engine)?;
    Ok(engine)
}

#[tauri::command]
pub fn delete_prompt_engine(id: String) -> Result<(), String> {
    let target = path(&id)?;
    if target.exists() { std::fs::remove_file(target).map_err(|e| e.to_string())?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rejects_empty_prompt() {
        let input = SavePromptEngineInput { id: None, name: "x".into(), icon: "".into(), description: "".into(), system_prompt: "".into(), starter_message: "".into(), model: "".into(), thinking: "".into(), research: ResearchSettings { enabled: false, mode: ResearchMode::Auto, instructions: "".into() } };
        assert_eq!(validate(&input), Err("system prompt required".into()));
    }
    #[test] fn default_documentary_is_research_enabled() { assert!(documentary().research.enabled); }
    #[test] fn ids_reject_path_traversal() { assert!(!valid_id("../bad")); }
}
