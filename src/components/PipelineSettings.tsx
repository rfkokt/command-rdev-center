import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type PipelineStep = { id: string; name: string; command: string; enabled: boolean; failure_policy: "ai_fix" | "ask_user" | "stop" | "continue"; max_attempts: number };
export type PipelineConfig = { preset: "Personal" | "KAI" | "MBI" | "Custom"; steps: PipelineStep[] };

export default function PipelineSettings({ projectPath, onToast }: { projectPath: string; onToast: (message: string) => void }) {
  const [config, setConfig] = useState<PipelineConfig | null>(null);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setConfig(null);
    void invoke<PipelineConfig>("get_pipeline_config", { projectPath, preset: null }).then((next) => {
      if (!active) return;
      setConfig(next); setSaved(JSON.stringify(next)); setError("");
    }).catch((e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [projectPath]);
  if (!config) return <div className="settings-loading">{error || "LOADING…"}</div>;
  const update = (index: number, patch: Partial<PipelineStep>) => setConfig({ ...config, preset: "Custom", steps: config.steps.map((step, i) => i === index ? { ...step, ...patch } : step) });
  const move = (index: number, delta: number) => { const steps = [...config.steps]; const target = index + delta; if (target < 0 || target >= steps.length) return; [steps[index], steps[target]] = [steps[target], steps[index]]; setConfig({ ...config, preset: "Custom", steps }); };
  const dirty = JSON.stringify(config) !== saved;
  async function selectPreset(preset: PipelineConfig["preset"]) {
    try {
      const next = await invoke<PipelineConfig>("get_pipeline_config", { projectPath, preset });
      setConfig(next);
      setError("");
    } catch (e) { setError(String(e)); }
  }
  async function save() { try { await invoke("save_pipeline_config", { projectPath, config }); setSaved(JSON.stringify(config)); setError(""); onToast("Pipeline settings saved."); } catch (e) { setError(String(e)); } }
  return <>
    <div className="graphify-settings pipeline-settings">
      <div className="settings-notice">Commands run from the registered project root. Review commands before saving; custom commands have full local shell access.</div>
      <label htmlFor="pipeline-preset">PRESET</label><select id="pipeline-preset" className="themed-select" value={config.preset} onChange={(e) => void selectPreset(e.target.value as PipelineConfig["preset"])}>{["Personal", "KAI", "MBI", "Custom"].map((preset) => <option key={preset}>{preset}</option>)}</select>
      {config.steps.map((step, index) => <div className="pipeline-step-editor" key={step.id + index}>
        <input type="checkbox" checked={step.enabled} onChange={(e) => update(index, { enabled: e.target.checked })} aria-label={`Enable ${step.name}`} />
        <input value={step.name} onChange={(e) => update(index, { name: e.target.value })} aria-label="Step name" placeholder="Step name" />
        <input value={step.command} onChange={(e) => update(index, { command: e.target.value })} aria-label={`${step.name} command`} placeholder="Shell command" />
        <select aria-label={`${step.name} failure policy`} className="themed-select" value={step.failure_policy} onChange={(e) => update(index, { failure_policy: e.target.value as PipelineStep["failure_policy"] })}>{["ai_fix", "ask_user", "stop", "continue"].map((policy) => <option key={policy}>{policy}</option>)}</select>
        <input type="number" min="1" max="10" value={step.max_attempts} onChange={(e) => update(index, { max_attempts: Number(e.target.value) })} aria-label={`${step.name} max attempts`} />
        <button onClick={() => move(index, -1)} aria-label={`Move ${step.name} up`}>↑</button><button onClick={() => move(index, 1)} aria-label={`Move ${step.name} down`}>↓</button><button onClick={() => setConfig({ ...config, preset: "Custom", steps: config.steps.filter((_, i) => i !== index) })} aria-label={`Remove ${step.name}`}>×</button>
      </div>)}
      <button onClick={() => setConfig({ ...config, preset: "Custom", steps: [...config.steps, { id: `step-${Date.now()}`, name: "New step", command: "echo ready", enabled: true, failure_policy: "ai_fix", max_attempts: 3 }] })}>＋ ADD STEP</button>
      {error && <div className="settings-error">{error}</div>}
    </div>
    <footer><span>{dirty ? "UNSAVED CHANGES" : "NO CHANGES"}</span><div><button onClick={() => setConfig(JSON.parse(saved) as PipelineConfig)} disabled={!dirty}>RESET</button><button className="save-settings" onClick={save} disabled={!dirty}>SAVE SETTINGS</button></div></footer>
  </>;
}
