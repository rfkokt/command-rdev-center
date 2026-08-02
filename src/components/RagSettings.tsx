import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Settings = { enabled: boolean; base_url: string; timeout_secs: number; upload_limit_mb: number; project_paths: string[]; has_token: boolean };
type Project = { name: string; path: string };

export default function RagSettings({ onToast }: { onToast: (message: string) => void }) {
  const [settings, setSettings] = useState<Settings>({ enabled: false, base_url: "", timeout_secs: 20, upload_limit_mb: 25, project_paths: [], has_token: false });
  const [token, setToken] = useState(""); const [projects, setProjects] = useState<Project[]>([]); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { void Promise.all([invoke<Settings>("get_rag_settings"), invoke<Project[]>("list_projects")]).then(([s, p]) => { setSettings(s); setProjects(p); }).catch((e) => setError(String(e))); }, []);
  const update = (patch: Partial<Settings>) => setSettings((current) => ({ ...current, ...patch }));
  async function save() { setBusy(true); setError(""); try { const next = await invoke<Settings>("save_rag_settings", { settings, bearerToken: token || null }); setSettings(next); setToken(""); onToast("RAG settings saved securely."); } catch (e) { setError(String(e)); } finally { setBusy(false); } }
  return <main className="graphify-settings">
    <div className="settings-notice">Global Chat only. Token stays in macOS Keychain; extracted text stays local. Selected project sources include top-level UTF-8 TXT, MD, CSV, and JSON files.</div>
    <label className="settings-toggle"><span>ENABLE RAG<small>Inject bounded keyword-matched source citations into Global Chat</small></span><input type="checkbox" checked={settings.enabled} onChange={(e) => update({ enabled: e.target.checked })} /></label>
    <label>HTTPS BASE URL<input type="url" value={settings.base_url} placeholder="https://extractor.example" onChange={(e) => update({ base_url: e.target.value })} /></label>
    <label>BEARER TOKEN<input type="password" value={token} placeholder={settings.has_token ? "Saved — leave blank to keep" : "Required when enabled"} autoComplete="new-password" onChange={(e) => setToken(e.target.value)} /></label>
    <label>TIMEOUT SECONDS<input type="number" min="1" max="60" value={settings.timeout_secs} onChange={(e) => update({ timeout_secs: Number(e.target.value) })} /></label>
    <label>UPLOAD LIMIT MB<input type="number" min="1" max="25" value={settings.upload_limit_mb} onChange={(e) => update({ upload_limit_mb: Number(e.target.value) })} /></label>
    <div><strong className="caption-uppercase">REGISTERED PROJECT SOURCES</strong>{projects.map((project) => <label className="settings-toggle" key={project.path}><span>{project.name}<small>{project.path}</small></span><input type="checkbox" checked={settings.project_paths.includes(project.path)} onChange={(e) => update({ project_paths: e.target.checked ? [...settings.project_paths, project.path] : settings.project_paths.filter((path) => path !== project.path) })} /></label>)}</div>
    {error && <div className="settings-error" role="alert">{error}</div>}
    <div style={{ display: "flex", gap: "var(--spacing-sm)", flexWrap: "wrap" }}><button className="save-settings" onClick={() => void save()} disabled={busy}>{busy ? "WORKING…" : "SAVE RAG SETTINGS"}</button><button onClick={() => void invoke("test_rag_connection").then(() => onToast("RAG connection OK.")).catch((e) => setError(String(e)))} disabled={busy || !settings.base_url}>TEST CONNECTION</button></div>
  </main>;
}
