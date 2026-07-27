import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type GraphifyConfig = { base_url: string; model: string; has_api_key: boolean };

export default function GraphifySettings({ onToast }: { onToast: (message: string) => void }) {
  const [config, setConfig] = useState<GraphifyConfig>({ base_url: "", model: "", has_api_key: false });
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelSearch, setModelSearch] = useState("");
  const [modelsOpen, setModelsOpen] = useState(false);
  const filteredModels = models.filter((model) => model.toLowerCase().includes(modelSearch.toLowerCase()));

  useEffect(() => {
    invoke<GraphifyConfig>("get_graphify_settings").then(setConfig).catch((e) => setError(String(e)));
  }, []);

  async function fetchModels() {
    setFetching(true);
    setError("");
    try {
      const next = await invoke<string[]>("fetch_graphify_models", { baseUrl: config.base_url, apiKey: apiKey || null });
      setModels(next);
      setModelSearch("");
      setModelsOpen(next.length > 0);
      if (!next.length) setError("Provider returned no models.");
    } catch (e) {
      setError(String(e));
    } finally {
      setFetching(false);
    }
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const next = await invoke<GraphifyConfig>("save_graphify_settings", {
        baseUrl: config.base_url,
        model: config.model,
        apiKey: apiKey || null,
      });
      setConfig(next);
      setApiKey("");
      onToast("Graphify provider saved securely in macOS Keychain.");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return <main className="graphify-settings">
    <div className="settings-notice">OpenAI-compatible provider for semantic document extraction. API key is stored in macOS Keychain, never in this repo or settings JSON.</div>
    <label>BASE URL<input type="url" value={config.base_url} onChange={(e) => setConfig({ ...config, base_url: e.target.value })} placeholder="https://9router.example/v1" /></label>
    <label>API KEY<input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={config.has_api_key ? "Saved — leave blank to keep current key" : "Required"} autoComplete="new-password" /></label>
    <div className="graphify-model-field"><label htmlFor="graphify-model">MODEL</label><div className="graphify-model-row"><input id="graphify-model" value={config.model} onFocus={() => { if (models.length) { setModelSearch(""); setModelsOpen(true); } }} onChange={(e) => { setConfig({ ...config, model: e.target.value }); setModelSearch(e.target.value); setModelsOpen(models.length > 0); }} placeholder="provider/model" /><button type="button" onClick={fetchModels} disabled={fetching || !config.base_url.trim() || (!apiKey && !config.has_api_key)}>{fetching ? "FETCHING…" : "FETCH MODELS"}</button></div>{modelsOpen && <div className="graphify-model-picker"><div className="graphify-model-search"><span>⌕</span><input value={modelSearch} onChange={(e) => setModelSearch(e.target.value)} placeholder="Search models…" aria-label="Search Graphify models" autoFocus /></div><div className="graphify-model-list">{filteredModels.map((model) => <button type="button" key={model} className={model === config.model ? "active" : ""} onClick={() => { setConfig({ ...config, model }); setModelSearch(""); setModelsOpen(false); }}><span>{model}</span>{model === config.model && <b>✓</b>}</button>)}{!filteredModels.length && <div className="graphify-model-empty">NO MATCHING MODELS</div>}</div><small>{filteredModels.length} / {models.length} MODELS</small></div>}</div>
    {error && <div className="settings-error">{error}</div>}
    <button className="save-settings" onClick={save} disabled={saving || !config.base_url.trim() || !config.model.trim() || (!apiKey && !config.has_api_key)}>{saving ? "SAVING…" : "SAVE GRAPHIFY SETTINGS"}</button>
  </main>;
}
