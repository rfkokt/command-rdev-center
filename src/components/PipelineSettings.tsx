import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type PipelineStep = { id: string; name: string; command: string; enabled: boolean; failure_policy: "ai_fix" | "ask_user" | "stop" | "continue"; max_attempts: number };
export type PipelineConfig = { preset: "Personal" | "KAI" | "MBI" | "Custom"; steps: PipelineStep[] };

const PRESETS: PipelineConfig["preset"][] = ["Personal", "KAI", "MBI", "Custom"];
const POLICIES: Array<{ value: PipelineStep["failure_policy"]; label: string; detail: string }> = [
  { value: "ai_fix", label: "AI fix", detail: "Pause, let the active agent diagnose, then retry." },
  { value: "ask_user", label: "Ask user", detail: "Pause for approval. Best for push, merge, deploy, and release." },
  { value: "stop", label: "Stop", detail: "End the pipeline immediately." },
  { value: "continue", label: "Continue", detail: "Record the failure and run the next step." },
];

function stepId() {
  return `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export default function PipelineSettings({ projectPath, projectName, onToast }: { projectPath: string; projectName?: string; onToast: (message: string) => void }) {
  const [config, setConfig] = useState<PipelineConfig | null>(null);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    let active = true;
    const request = ++requestRef.current;
    setConfig(null);
    void invoke<PipelineConfig>("get_pipeline_config", { projectPath, preset: null }).then((next) => {
      if (!active || request !== requestRef.current) return;
      setConfig(next);
      setSaved(JSON.stringify(next));
      setError("");
    }).catch((e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [projectPath]);

  if (!config) return <div className="settings-loading">{error || "LOADING PIPELINE…"}</div>;

  const update = (index: number, patch: Partial<PipelineStep>) => setConfig({ ...config, preset: "Custom", steps: config.steps.map((step, i) => i === index ? { ...step, ...patch } : step) });
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= config.steps.length) return;
    const steps = [...config.steps];
    [steps[index], steps[target]] = [steps[target], steps[index]];
    setConfig({ ...config, preset: "Custom", steps });
  };
  const dirty = JSON.stringify(config) !== saved;
  const enabledCount = config.steps.filter((step) => step.enabled).length;
  const invalid = config.steps.some((step) => !step.name.trim() || !step.command.trim() || step.max_attempts < 1 || step.max_attempts > 10);

  async function selectPreset(preset: PipelineConfig["preset"]) {
    if (preset === "Custom") return setConfig((current) => current && { ...current, preset });
    if (dirty && !window.confirm(`Replace unsaved steps with the ${preset} preset?`)) return;
    const request = ++requestRef.current;
    try {
      const next = await invoke<PipelineConfig>("get_pipeline_config", { projectPath, preset });
      if (request !== requestRef.current) return;
      setConfig(next);
      setError("");
    } catch (e) { setError(String(e)); }
  }

  async function save() {
    setSaving(true);
    try {
      await invoke("save_pipeline_config", { projectPath, config });
      setSaved(JSON.stringify(config));
      setError("");
      onToast(`Pipeline saved for ${projectName ?? projectPath}.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return <>
    <div className="pipeline-settings">
      <section className="pipeline-target">
        <div><small>APPLIES TO PROJECT</small><strong>{projectName ?? projectPath.split("/").pop()}</strong><span>{projectPath}</span></div>
        <div className="pipeline-summary"><strong>{enabledCount}</strong><span>of {config.steps.length} steps enabled</span></div>
      </section>

      <div className="settings-notice"><strong>LOCAL SHELL ACCESS</strong><span>Commands run from this registered project root. Review every command before saving.</span></div>

      <section className="pipeline-preset-section">
        <div><label htmlFor="pipeline-preset">STARTING PRESET</label><span>Choose a template, then customize any step. Editing switches the preset to Custom.</span></div>
        <select id="pipeline-preset" className="themed-select" value={config.preset} onChange={(event) => void selectPreset(event.target.value as PipelineConfig["preset"])}>{PRESETS.map((preset) => <option key={preset}>{preset}</option>)}</select>
      </section>

      <div className="pipeline-step-header" aria-hidden="true"><span>ON</span><span>STEP</span><span>COMMAND</span><span>ON FAILURE</span><span>TRIES</span><span>ORDER</span></div>
      <div className="pipeline-step-list">
        {config.steps.map((step, index) => <article className={`pipeline-step-editor ${step.enabled ? "" : "disabled"}`} key={step.id}>
          <label className="pipeline-step-toggle"><input type="checkbox" checked={step.enabled} onChange={(event) => update(index, { enabled: event.target.checked })} aria-label={`Enable ${step.name}`} /><span /><b>ENABLED</b></label>
          <label><span className="mobile-field-label">STEP</span><input value={step.name} onChange={(event) => update(index, { name: event.target.value })} aria-label={`Step ${index + 1} name`} placeholder="Step name" /></label>
          <label><span className="mobile-field-label">COMMAND</span><input className="pipeline-command-input" value={step.command} onChange={(event) => update(index, { command: event.target.value })} aria-label={`${step.name} command`} placeholder="Shell command" spellCheck={false} /></label>
          <label><span className="mobile-field-label">ON FAILURE</span><select aria-label={`${step.name} failure policy`} className="themed-select" value={step.failure_policy} title={POLICIES.find((policy) => policy.value === step.failure_policy)?.detail} onChange={(event) => update(index, { failure_policy: event.target.value as PipelineStep["failure_policy"] })}>{POLICIES.map((policy) => <option key={policy.value} value={policy.value}>{policy.label}</option>)}</select></label>
          <label><span className="mobile-field-label">TRIES</span><input type="number" min="1" max="10" value={step.max_attempts} onChange={(event) => update(index, { max_attempts: Number(event.target.value) })} aria-label={`${step.name} max attempts`} /></label>
          <div className="pipeline-step-actions">
            <button onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move ${step.name} up`} title="Move up">↑</button>
            <button onClick={() => move(index, 1)} disabled={index === config.steps.length - 1} aria-label={`Move ${step.name} down`} title="Move down">↓</button>
            <button className="pipeline-remove-step" onClick={() => setConfig({ ...config, preset: "Custom", steps: config.steps.filter((_, i) => i !== index) })} aria-label={`Remove ${step.name}`} title="Remove step">×</button>
          </div>
        </article>)}
      </div>

      <button className="pipeline-add-step" onClick={() => setConfig({ ...config, preset: "Custom", steps: [...config.steps, { id: stepId(), name: "New step", command: "", enabled: true, failure_policy: "ai_fix", max_attempts: 3 }] })}>＋ ADD STEP</button>

      <details className="pipeline-policy-guide"><summary>FAILURE POLICY HELP</summary><div>{POLICIES.map((policy) => <p key={policy.value}><b>{policy.label}</b><span>{policy.detail}</span></p>)}</div></details>
      {invalid && <div className="settings-error" role="alert">Every step needs a name, command, and 1–10 attempts.</div>}
      {error && <div className="settings-error" role="alert">{error}</div>}
    </div>
    <footer><span>{dirty ? `UNSAVED · ${projectName ?? "PROJECT"}` : `SAVED · ${projectName ?? "PROJECT"}`}</span><div><button onClick={() => setConfig(JSON.parse(saved) as PipelineConfig)} disabled={!dirty || saving}>RESET</button><button className="save-settings" onClick={save} disabled={!dirty || invalid || saving}>{saving ? "SAVING…" : "SAVE TO PROJECT"}</button></div></footer>
  </>;
}
