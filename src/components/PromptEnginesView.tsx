import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import ChatView from "./ChatView";
import ListPicker from "./ListPicker";
import ModelPicker from "./ModelPicker";
import { confirm } from "./ConfirmDialog";
import { deletePromptEngine, listPromptEngines, runtimePrompt, savePromptEngine, type PromptEngine, type PromptEngineInput } from "../lib/prompt-engines";

const blank = (): PromptEngineInput => ({ id: undefined, name: "New Engine", icon: "P", description: "", system_prompt: "", starter_message: "", model: "", thinking: "", research: { enabled: false, mode: "auto", instructions: "" } });
type Run = { id: string; engineId: string; title: string; runtimePrompt: string; sessionFile?: string; model?: string; thinking?: string; interrupted?: boolean };
const RUNS_KEY = "crc-prompt-engine-runs-v1";
const noop = () => {};
function savedRuns(): Run[] {
  try {
    const value = JSON.parse(localStorage.getItem(RUNS_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((run): run is Run => Boolean(run && typeof run === "object" && "id" in run && "engineId" in run)) : [];
  } catch { return []; }
}

export default function PromptEnginesView({ onToast }: { onToast: (message: string) => void }) {
  const [engines, setEngines] = useState<PromptEngine[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PromptEngineInput | null>(null);
  const [runs, setRuns] = useState<Run[]>(savedRuns);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const selected = engines.find((engine) => engine.id === selectedId) ?? null;
  const activeRun = runs.find((run) => run.id === activeRunId) ?? null;

  useEffect(() => { listPromptEngines().then((items) => { setEngines(items); setSelectedId((id) => id ?? items[0]?.id ?? null); }).catch((e) => onToast(String(e))); }, [onToast]);
  useEffect(() => { invoke<string[]>("list_available_models").then(setModels).catch((e) => onToast(`Models: ${String(e)}`)); }, [onToast]);
  useEffect(() => localStorage.setItem(RUNS_KEY, JSON.stringify(runs)), [runs]);

  function edit(engine?: PromptEngine) { setDraft(engine ? { ...engine } : blank()); setEditing(true); }
  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      const engine = await savePromptEngine(draft);
      setEngines((items) => [...items.filter((item) => item.id !== engine.id), engine].sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedId(engine.id);
      setEditing(false);
      onToast("Prompt engine saved");
    } catch (e) { onToast(String(e)); } finally { setBusy(false); }
  }
  async function importPrompt() {
    const picked = await open({ multiple: false, filters: [{ name: "Prompt", extensions: ["pdf", "txt", "md"] }] });
    if (!picked || !draft) return;
    setBusy(true);
    try {
      const [attachment] = await invoke<Array<{ name: string; content: string }>>("read_chat_attachments", { paths: [picked] });
      setDraft((current) => current ? { ...current, system_prompt: attachment.content } : current);
      onToast(`Imported ${attachment.name}`);
    } catch (e) { onToast(String(e)); } finally { setBusy(false); }
  }
  function newRun() {
    if (!selected) return;
    const id = `engine-${selected.id}-${Date.now()}`;
    setRuns((items) => [...items, { id, engineId: selected.id, title: selected.starter_message || "Untitled run", runtimePrompt: runtimePrompt(selected), model: selected.model, thinking: selected.thinking }]);
    setActiveRunId(id);
  }
  async function removeEngine() {
    if (!selected || !await confirm({ title: "Delete prompt engine", message: `Delete ${selected.name}? Existing Pi session files remain on disk.`, confirmLabel: "Delete", cancelLabel: "Cancel", danger: true })) return;
    await deletePromptEngine(selected.id);
    const next = engines.filter((engine) => engine.id !== selected.id);
    setEngines(next);
    setSelectedId(next[0]?.id ?? null);
    setActiveRunId(null);
    onToast("Prompt engine deleted");
  }
  const saveRunSession = useCallback((id: string, sessionFile: string) => setRuns((items) => items.map((run) => run.id === id ? { ...run, sessionFile } : run)), []);
  const saveRunTitle = useCallback((id: string, title: string) => setRuns((items) => items.map((run) => run.id === id ? { ...run, title } : run)), []);
  const saveRunRuntime = useCallback((id: string, model: string, thinking: string) => setRuns((items) => items.map((run) => run.id === id ? { ...run, model, thinking } : run)), []);
  const saveRunAgentState = useCallback((id: string, interrupted: boolean) => setRuns((items) => items.map((run) => run.id === id ? { ...run, interrupted } : run)), []);
  const closeRun = useCallback(() => setActiveRunId(null), []);

  if (editing && draft) return <section className="prompt-engine-settings" aria-labelledby="prompt-engine-settings-title">
    <header className="prompt-engine-header">
      <div><small>CONFIGURATION</small><strong id="prompt-engine-settings-title">{draft.id ? "EDIT PROMPT ENGINE" : "NEW PROMPT ENGINE"}</strong></div>
      <button className="prompt-header-action" onClick={() => setEditing(false)} aria-label="Close prompt engine settings">ESC</button>
    </header>
    <div className="prompt-engine-form">
      <section className="prompt-form-section">
        <header><strong>IDENTITY</strong><span>Name and describe this engine in the local library.</span></header>
        <div className="prompt-fields two-column">
          <label><span>NAME<small>Displayed in the engine library and run header</small></span><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
          <label><span>ICON<small>Up to four characters</small></span><input maxLength={4} value={draft.icon} onChange={(e) => setDraft({ ...draft, icon: e.target.value })} /></label>
          <label className="wide"><span>DESCRIPTION<small>Explain the engine purpose in one short sentence</small></span><input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
          <label className="wide"><span>STARTER MESSAGE<small>Placeholder shown when a new run starts</small></span><input value={draft.starter_message} onChange={(e) => setDraft({ ...draft, starter_message: e.target.value })} /></label>
        </div>
      </section>

      <section className="prompt-form-section">
        <header><strong>RUNTIME</strong><span>Optional overrides. Empty values use the app defaults.</span></header>
        <div className="prompt-fields two-column">
          <label><span>MODEL<small>Same provider and model catalog used by Chat</small></span><button type="button" className="prompt-model-trigger" onClick={() => setModelPickerOpen(true)}><span>{draft.model || "App default"}</span><b>CHOOSE</b></button></label>
          <ListPicker label="THINKING LEVEL" value={draft.thinking} options={["off", "minimal", "low", "medium", "high", "xhigh", "max"]} allLabel="App default" onChange={(thinking) => setDraft({ ...draft, thinking })} />
        </div>
      </section>

      <section className="prompt-form-section">
        <header><strong>RESEARCH</strong><span>Research stays inside this engine and does not create Deep Research reports.</span></header>
        <div className="prompt-fields">
          <label className="settings-toggle"><span>ENABLE WEB RESEARCH<small>Give this engine access to web research before prompt output</small></span><input type="checkbox" checked={draft.research.enabled} onChange={(e) => setDraft({ ...draft, research: { ...draft.research, enabled: e.target.checked } })} /></label>
          {draft.research.enabled ? <>
            <ListPicker label="RESEARCH FLOW" value={draft.research.mode} options={["auto", "review"]} includeAll={false} onChange={(mode) => setDraft({ ...draft, research: { ...draft.research, mode: mode as "auto" | "review" } })} />
            <label><span>RESEARCH INSTRUCTIONS<small>Source preferences and evidence requirements for this engine</small></span><textarea value={draft.research.instructions} onChange={(e) => setDraft({ ...draft, research: { ...draft.research, instructions: e.target.value } })} /></label>
          </> : null}
        </div>
      </section>

      <section className="prompt-form-section prompt-section-editor">
        <header><strong>SYSTEM PROMPT</strong><span>Output format and workflow are controlled entirely by this prompt.</span></header>
        <div className="prompt-import-row"><button className="prompt-secondary" onClick={() => void importPrompt()} disabled={busy}>IMPORT PDF / TEXT</button><span>Import replaces the editor contents. Review before saving.</span></div>
        <label className="prompt-editor-field"><span className="sr-only">System prompt</span><textarea className="prompt-editor" spellCheck={false} value={draft.system_prompt} onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })} /></label>
      </section>
    </div>
    <footer className="prompt-engine-footer"><span>{busy ? "WORKING…" : "LOCAL ENGINE CONFIGURATION"}</span><div><button onClick={() => setEditing(false)}>CANCEL</button><button className="save-settings" onClick={() => void save()} disabled={busy || !draft.name.trim() || !draft.system_prompt.trim()}>{busy ? "SAVING…" : "SAVE ENGINE"}</button></div></footer>
    {modelPickerOpen && <ModelPicker value={draft.model} models={models} onChange={(model) => setDraft({ ...draft, model })} onClose={() => setModelPickerOpen(false)} />}
  </section>;

  return <div className="prompt-engines-view">
    <aside className="prompt-engine-library" aria-label="Prompt engine library">
      <header><div><small>LOCAL LIBRARY</small><strong>PROMPT ENGINES</strong></div><button className="small-icon-button" onClick={() => edit()} title="Create prompt engine" aria-label="Create prompt engine">＋</button></header>
      <div className="prompt-engine-library-list">{engines.map((engine) => <button key={engine.id} className={engine.id === selectedId ? "active" : ""} aria-current={engine.id === selectedId ? "page" : undefined} onClick={() => { setSelectedId(engine.id); setActiveRunId(null); }}><b>{engine.icon || "P"}</b><span><strong>{engine.name}</strong><small>{engine.research.enabled ? `Research · ${engine.research.mode === "auto" ? "auto" : "review first"}` : "Prompt only"}</small></span></button>)}</div>
    </aside>
    <section className="prompt-engine-workspace">
      {selected ? !activeRun ? <div className="prompt-engine-home">
        <div className="prompt-engine-status"><span>{selected.icon || "P"}</span><div><small>PROMPT ENGINE</small><h1>{selected.name}</h1></div></div>
        <p>{selected.description || "Reusable local system prompt."}</p>
        <div className="prompt-engine-meta"><span>{selected.research.enabled ? `RESEARCH · ${selected.research.mode.toUpperCase()}` : "PROMPT ONLY"}</span><span>{selected.model || "APP DEFAULT MODEL"}</span><span>{selected.thinking ? `THINKING · ${selected.thinking.toUpperCase()}` : "APP DEFAULT THINKING"}</span></div>
        <div className="prompt-engine-actions"><button className="save-settings" onClick={newRun}>NEW RUN</button><button className="prompt-secondary" onClick={() => edit(selected)}>SETTINGS</button><button className="prompt-secondary" onClick={() => edit({ ...selected, id: `engine-${Date.now()}`, name: `${selected.name} Copy` })}>DUPLICATE</button><button className="prompt-danger" onClick={() => void removeEngine()}>DELETE</button></div>
        <div className="prompt-run-heading"><strong>RUN HISTORY</strong><span>{runs.filter((run) => run.engineId === selected.id).length} local runs</span></div>
        <div className="prompt-run-list">{runs.filter((run) => run.engineId === selected.id).map((run) => <button key={run.id} onClick={() => setActiveRunId(run.id)}><span><strong>{run.title}</strong><small>{run.sessionFile ? "Saved Pi session" : "New session"}</small></span><b aria-hidden="true">›</b></button>)}{runs.every((run) => run.engineId !== selected.id) ? <div className="prompt-run-empty"><strong>NO RUNS YET</strong><span>Start a run to create isolated engine history.</span></div> : null}</div>
      </div> : <ChatView projectPath="global" projectName={selected.name} isGit={false} repositories={[]} pipelineType="Personal" chatId={activeRun.id} sessionFile={activeRun.sessionFile} initialModel={activeRun.model} initialThinking={activeRun.thinking} initialInterrupted={activeRun.interrupted} resumableSessions={[]} globalChat customSystemPrompt={activeRun.runtimePrompt || runtimePrompt(selected)} inputPlaceholder={selected.starter_message || "TYPE MESSAGE…"} onSessionFile={saveRunSession} onFirstMessage={saveRunTitle} onRuntimeSettings={saveRunRuntime} onAgentRunning={saveRunAgentState} onUnread={noop} onClose={closeRun} onToast={onToast} onOpenPipeline={noop} onOpenResearch={noop} isActive /> : <div className="prompt-engine-empty"><strong>NO PROMPT ENGINES</strong><span>Create a local engine from pasted text or an imported prompt file.</span><button className="save-settings" onClick={() => edit()}>CREATE ENGINE</button></div>}
    </section>
  </div>;
}
