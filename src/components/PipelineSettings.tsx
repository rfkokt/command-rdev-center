import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type PipelineStep = { id: string; name: string; mode?: "shell" | "ai_commit" | "confirm"; command: string; enabled: boolean; failure_policy: "ai_fix" | "ask_user" | "stop" | "continue"; max_attempts: number; prompt?: string; options?: string[] };
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

const CONFIG_KEYS = ["preset", "steps"];
const REQUIRED_STEP_KEYS = ["command", "enabled", "failure_policy", "id", "max_attempts", "name"];
const OPTIONAL_STEP_KEYS = ["mode", "prompt", "options"];
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).sort().join() === [...keys].sort().join();
}
function consultantDraft(text: string): PipelineConfig | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1];
  if (!fenced || fenced.length > 100_000) return null;
  try {
    const value: unknown = JSON.parse(fenced);
    if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value as Record<string, unknown>, CONFIG_KEYS)) return null;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.preset !== "string" || !["Personal", "KAI", "MBI", "Custom"].includes(candidate.preset) || !Array.isArray(candidate.steps) || candidate.steps.length > 50) return null;
    if (candidate.steps.some((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return true;
      const keys = Object.keys(raw as Record<string, unknown>);
      if (REQUIRED_STEP_KEYS.some((key) => !keys.includes(key)) || keys.some((key) => !REQUIRED_STEP_KEYS.includes(key) && !OPTIONAL_STEP_KEYS.includes(key))) return true;
      const step = raw as Record<string, unknown>;
      return (step.mode !== undefined && !["shell", "ai_commit", "confirm"].includes(String(step.mode)))
        || (step.prompt !== undefined && typeof step.prompt !== "string")
        || (step.options !== undefined && (!Array.isArray(step.options) || step.options.some((option) => typeof option !== "string")))
        || typeof step.id !== "string" || !step.id.trim() || step.id.length > 100
        || typeof step.name !== "string" || !step.name.trim() || step.name.length > 200
        || typeof step.command !== "string" || !step.command.trim() || step.command.length > 2_000
        || typeof step.enabled !== "boolean"
        || typeof step.failure_policy !== "string" || !["ai_fix", "ask_user", "stop", "continue"].includes(step.failure_policy)
        || typeof step.max_attempts !== "number" || !Number.isInteger(step.max_attempts) || step.max_attempts < 1 || step.max_attempts > 10;
    })) return null;
    return value as PipelineConfig;
  } catch {
    return null;
  }
}

export default function PipelineSettings({ projectPath, projectName, onToast }: { projectPath: string; projectName?: string; onToast: (message: string) => void }) {
  const [config, setConfig] = useState<PipelineConfig | null>(null);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [consultOpen, setConsultOpen] = useState(false);
  const [consultInput, setConsultInput] = useState("");
  const [consultMessages, setConsultMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const [consultBusy, setConsultBusy] = useState(false);
  const [consultError, setConsultError] = useState("");
  const [draft, setDraft] = useState<PipelineConfig | null>(null);
  const consultantId = useRef("");
  const consultantStarted = useRef(false);
  const consultantText = useRef("");
  const consultantListeners = useRef<UnlistenFn[]>([]);
  const consultantGeneration = useRef(0);
  const consultInputRef = useRef<HTMLTextAreaElement>(null);
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

  useEffect(() => {
    resetConsultant();
    setConsultOpen(false);
    setConsultMessages([]);
    setDraft(null);
    return resetConsultant;
  }, [projectPath]);

  useEffect(() => {
    if (!consultOpen) return;
    consultInputRef.current?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") closeConsultant(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [consultOpen]);

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
  const invalid = config.steps.some((step) => !step.name.trim() || ((step.mode ?? "shell") !== "ai_commit" && !step.command.trim()) || step.max_attempts < 1 || step.max_attempts > 10);

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

  function resetConsultant() {
    consultantGeneration.current += 1;
    consultantListeners.current.forEach((unlisten) => unlisten());
    consultantListeners.current = [];
    const sessionId = consultantId.current;
    consultantId.current = "";
    consultantStarted.current = false;
    consultantText.current = "";
    if (sessionId) void invoke("kill_pi_session", { sessionId });
  }

  async function startConsultant() {
    if (consultantStarted.current || consultBusy) return;
    resetConsultant();
    const generation = consultantGeneration.current;
    const sessionId = `pipeline-consult-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    consultantId.current = sessionId;
    consultantStarted.current = true;
    setConsultBusy(true);
    setConsultError("");
    try {
      const eventUnlisten = await listen<{ session_id: string; raw: string }>("pi-rpc-event", (event) => {
        if (event.payload.session_id !== sessionId) return;
        try {
          const rpc = JSON.parse(event.payload.raw) as Record<string, unknown>;
          if (generation !== consultantGeneration.current) return;
          if (rpc.type === "message_update") {
            const update = rpc.assistantMessageEvent as Record<string, unknown> | undefined;
            if (update?.type === "text_delta") consultantText.current = (consultantText.current + String(update.delta ?? "")).slice(-100_000);
          }
          if (rpc.type === "agent_settled") {
            const text = consultantText.current.trim();
            if (text) setConsultMessages((messages) => [...messages, { role: "assistant", text }]);
            setDraft(consultantDraft(text));
            consultantText.current = "";
            setConsultBusy(false);
          }
        } catch { /* ignore unrelated RPC frames */ }
      });
      const errorUnlisten = await listen<{ session_id: string; error: string }>("pi-rpc-error", (event) => {
        if (event.payload.session_id === sessionId) { setConsultError(event.payload.error); setConsultBusy(false); }
      });
      if (generation !== consultantGeneration.current) { eventUnlisten(); errorUnlisten(); return; }
      consultantListeners.current.push(eventUnlisten, errorUnlisten);
      await invoke("spawn_pi_rpc", { sessionId, cwd: projectPath, model: null, provider: null, thinking: "medium", noSession: true, sessionFile: null, graphReportPath: null, tools: ["read", "grep", "find", "ls"] });
      if (generation !== consultantGeneration.current) { resetConsultant(); return; }
      const system = `You are a read-only pipeline configuration consultant for ${projectName ?? projectPath}. Inspect project manifests and scripts with read/grep/find/ls before proposing commands. This app runs chat-triggered pipelines inside the active isolated Git worktree; dashboard-triggered pipelines run at the registered project root. Commands must work in clean or dirty worktrees unless a step explicitly requires changes. Never invent environment variables such as AI_CONVENTIONAL_COMMIT_MESSAGE or CONFIRMED_TAG unless the user configured their values. Ask concise questions until you understand desired validation, build, git, deploy, failure and confirmation steps. Never modify files or run commands. When ready, include exactly one fenced JSON object matching this TypeScript shape: {preset:\"Personal\"|\"KAI\"|\"MBI\"|\"Custom\",steps:[{id:string,name:string,mode:"shell"|"ai_commit"|"confirm",command:string,prompt:string,options:string[],enabled:boolean,failure_policy:\"ai_fix\"|\"ask_user\"|\"stop\"|\"continue\",max_attempts:number}]}. Commands may be proposed but are never executed or saved automatically. Current config: ${JSON.stringify(config)}. Begin with the most important missing question.`;
      await invoke("send_pi_command", { sessionId, jsonLine: JSON.stringify({ type: "prompt", message: system }) });
    } catch (e) {
      if (generation === consultantGeneration.current) {
        setConsultError(String(e));
        setConsultBusy(false);
        resetConsultant();
      }
    }
  }

  async function sendConsultMessage() {
    const message = consultInput.trim();
    if (!message || consultBusy) return;
    setConsultMessages((messages) => [...messages, { role: "user", text: message }]);
    setConsultInput("");
    setDraft(null);
    setConsultBusy(true);
    consultantText.current = "";
    try {
      await invoke("send_pi_command", { sessionId: consultantId.current, jsonLine: JSON.stringify({ type: "prompt", message }) });
    } catch (e) {
      setConsultError(String(e));
      setConsultBusy(false);
      resetConsultant();
    }
  }

  function closeConsultant() {
    resetConsultant();
    setConsultOpen(false);
    setConsultBusy(false);
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
        <div className="pipeline-preset-actions"><button className="pipeline-consult-button" onClick={() => { setConsultOpen(true); void startConsultant(); }}>✦ CONSULT AI</button><select id="pipeline-preset" className="themed-select" value={config.preset} onChange={(event) => void selectPreset(event.target.value as PipelineConfig["preset"])}>{PRESETS.map((preset) => <option key={preset}>{preset}</option>)}</select></div>
      </section>

      <div className="pipeline-step-header" aria-hidden="true"><span>ON</span><span>STEP</span><span>COMMAND</span><span>ON FAILURE</span><span>TRIES</span><span>ORDER</span></div>
      <div className="pipeline-step-list">
        {config.steps.map((step, index) => <article className={`pipeline-step-editor ${step.enabled ? "" : "disabled"}`} key={step.id}>
          <label className="pipeline-step-toggle"><input type="checkbox" checked={step.enabled} onChange={(event) => update(index, { enabled: event.target.checked })} aria-label={`Enable ${step.name}`} /><span /><b>ENABLED</b></label>
          <label><span className="mobile-field-label">STEP</span><input value={step.name} onChange={(event) => update(index, { name: event.target.value })} aria-label={`Step ${index + 1} name`} placeholder="Step name" /></label>
          <label><span className="mobile-field-label">MODE</span><select className="themed-select" aria-label={`${step.name} mode`} value={step.mode ?? "shell"} onChange={(event) => update(index, { mode: event.target.value as PipelineStep["mode"] })}><option value="shell">Shell</option><option value="ai_commit">AI commit</option><option value="confirm">Confirm</option></select></label>
          <label><span className="mobile-field-label">COMMAND</span><input className="pipeline-command-input" value={step.command} onChange={(event) => update(index, { command: event.target.value })} aria-label={`${step.name} command`} placeholder={(step.mode ?? "shell") === "ai_commit" ? "Handled safely by app" : "Shell command"} disabled={(step.mode ?? "shell") === "ai_commit"} spellCheck={false} /></label>
          {(step.mode ?? "shell") !== "shell" && <label><span className="mobile-field-label">PROMPT / OPTIONS</span><input value={step.prompt ?? ""} onChange={(event) => update(index, { prompt: event.target.value })} placeholder="Prompt" />{step.mode === "confirm" && <input value={(step.options ?? []).join(", ")} onChange={(event) => update(index, { options: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} placeholder="patch, minor, major" />}</label>}
          <label><span className="mobile-field-label">ON FAILURE</span><select aria-label={`${step.name} failure policy`} className="themed-select" value={step.failure_policy} title={POLICIES.find((policy) => policy.value === step.failure_policy)?.detail} onChange={(event) => update(index, { failure_policy: event.target.value as PipelineStep["failure_policy"] })}>{POLICIES.map((policy) => <option key={policy.value} value={policy.value}>{policy.label}</option>)}</select></label>
          <label><span className="mobile-field-label">TRIES</span><input type="number" min="1" max="10" value={step.max_attempts} onChange={(event) => update(index, { max_attempts: Number(event.target.value) })} aria-label={`${step.name} max attempts`} /></label>
          <div className="pipeline-step-actions">
            <button onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move ${step.name} up`} title="Move up">↑</button>
            <button onClick={() => move(index, 1)} disabled={index === config.steps.length - 1} aria-label={`Move ${step.name} down`} title="Move down">↓</button>
            <button className="pipeline-remove-step" onClick={() => setConfig({ ...config, preset: "Custom", steps: config.steps.filter((_, i) => i !== index) })} aria-label={`Remove ${step.name}`} title="Remove step">×</button>
          </div>
        </article>)}
      </div>

      <button className="pipeline-add-step" onClick={() => setConfig({ ...config, preset: "Custom", steps: [...config.steps, { id: stepId(), name: "New step", mode: "shell", command: "", enabled: true, failure_policy: "ai_fix", max_attempts: 3 }] })}>＋ ADD STEP</button>

      <details className="pipeline-policy-guide"><summary>FAILURE POLICY HELP</summary><div>{POLICIES.map((policy) => <p key={policy.value}><b>{policy.label}</b><span>{policy.detail}</span></p>)}</div></details>
      {invalid && <div className="settings-error" role="alert">Every step needs a name, command, and 1–10 attempts.</div>}
      {error && <div className="settings-error" role="alert">{error}</div>}
    </div>
    {consultOpen && <aside className="pipeline-consult-drawer" role="dialog" aria-modal="true" aria-label="AI pipeline consultant">
      <header><div><small>PROJECT COPILOT</small><strong>PIPELINE CONSULTANT</strong></div><button onClick={closeConsultant} aria-label="Close pipeline consultant">×</button></header>
      <div className="pipeline-consult-copy">Describe what should happen before push, merge, deploy, or release. The AI asks questions, then returns a draft for review.</div>
      <div className="pipeline-consult-chat">{consultMessages.map((message, index) => <article className={message.role} key={index}><small>{message.role === "user" ? "YOU" : "AI"}</small><p>{message.text}</p></article>)}</div>
      <div className="pipeline-consult-status" role="status" aria-live="polite">{consultBusy ? "AI IS THINKING…" : consultError ? "CONSULTATION ERROR" : draft ? "DRAFT READY FOR REVIEW" : "READY"}</div>
      {draft && <section className="pipeline-consult-draft"><header><div><strong>DRAFT READY</strong><span>{draft.steps.length} steps · commands are not run or saved yet</span></div><button onClick={() => { setConfig({ ...draft, preset: "Custom" }); setDraft(null); }}>APPLY TO FORM</button></header><ol>{draft.steps.map((step) => <li key={step.id}><b>{step.enabled ? "✓" : "○"} {step.name}</b><code>{step.command}</code></li>)}</ol></section>}
      {consultError && <div className="settings-error" role="alert">{consultError}</div>}
      <footer><textarea ref={consultInputRef} value={consultInput} onChange={(event) => setConsultInput(event.target.value)} placeholder="Example: test and build first, ask before pushing to main…" aria-label="Pipeline consultation message" /><button onClick={() => void sendConsultMessage()} disabled={!consultInput.trim() || consultBusy}>SEND</button></footer>
    </aside>}
    <footer><span>{dirty ? `UNSAVED · ${projectName ?? "PROJECT"}` : `SAVED · ${projectName ?? "PROJECT"}`}</span><div><button onClick={() => setConfig(JSON.parse(saved) as PipelineConfig)} disabled={!dirty || saving}>RESET</button><button className="save-settings" onClick={save} disabled={!dirty || invalid || saving}>{saving ? "SAVING…" : "SAVE TO PROJECT"}</button></div></footer>
  </>;
}
