import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import ChatView from "./ChatView";
import { confirm } from "./ConfirmDialog";
import { deletePromptEngine, listPromptEngines, runtimePrompt, savePromptEngine, type PromptEngine, type PromptEngineInput } from "../lib/prompt-engines";

const blank = (): PromptEngineInput => ({ id: undefined, name: "New Engine", icon: "P", description: "", system_prompt: "", starter_message: "", model: "", thinking: "", research: { enabled: false, mode: "auto", instructions: "" } });
type Run = { id: string; engineId: string; title: string; runtimePrompt: string; sessionFile?: string; model?: string; thinking?: string; interrupted?: boolean };
const RUNS_KEY = "crc-prompt-engine-runs-v1";
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
  const selected = engines.find((engine) => engine.id === selectedId) ?? null;
  const activeRun = runs.find((run) => run.id === activeRunId) ?? null;

  useEffect(() => { listPromptEngines().then((items) => { setEngines(items); setSelectedId((id) => id ?? items[0]?.id ?? null); }).catch((e) => onToast(String(e))); }, [onToast]);
  useEffect(() => localStorage.setItem(RUNS_KEY, JSON.stringify(runs)), [runs]);

  function edit(engine?: PromptEngine) { setDraft(engine ? { ...engine } : blank()); setEditing(true); }
  async function save() {
    if (!draft) return;
    setBusy(true);
    try { const engine = await savePromptEngine(draft); setEngines((items) => [...items.filter((item) => item.id !== engine.id), engine].sort((a, b) => a.name.localeCompare(b.name))); setSelectedId(engine.id); setEditing(false); onToast("Prompt engine saved"); }
    catch (e) { onToast(String(e)); } finally { setBusy(false); }
  }
  async function importPrompt() {
    const picked = await open({ multiple: false, filters: [{ name: "Prompt", extensions: ["pdf", "txt", "md"] }] });
    if (!picked || !draft) return;
    setBusy(true);
    try { const [attachment] = await invoke<Array<{ name: string; content: string }>>("read_chat_attachments", { paths: [picked] }); setDraft((current) => current ? { ...current, system_prompt: attachment.content } : current); onToast(`Imported ${attachment.name}`); }
    catch (e) { onToast(String(e)); } finally { setBusy(false); }
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
    const next = engines.filter((engine) => engine.id !== selected.id); setEngines(next); setSelectedId(next[0]?.id ?? null); setActiveRunId(null); onToast("Prompt engine deleted");
  }

  if (editing && draft) return <div className="prompt-engine-settings">
    <header><div><small>PROMPT ENGINE SETTINGS</small><strong>{draft.id ? "Edit engine" : "Create engine"}</strong></div><button onClick={() => setEditing(false)}>Close</button></header>
    <div className="prompt-engine-form">
      <label>Name<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
      <label>Icon<input maxLength={4} value={draft.icon} onChange={(e) => setDraft({ ...draft, icon: e.target.value })} /></label>
      <label className="wide">Description<input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
      <label className="wide">Starter message<input value={draft.starter_message} onChange={(e) => setDraft({ ...draft, starter_message: e.target.value })} /></label>
      <label>Model<input placeholder="provider/model, optional" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} /></label>
      <label>Thinking<select value={draft.thinking} onChange={(e) => setDraft({ ...draft, thinking: e.target.value })}><option value="">App default</option><option>off</option><option>minimal</option><option>low</option><option>medium</option><option>high</option></select></label>
      <label className="wide prompt-toggle"><input type="checkbox" checked={draft.research.enabled} onChange={(e) => setDraft({ ...draft, research: { ...draft.research, enabled: e.target.checked } })} /> Enable web research for this engine</label>
      {draft.research.enabled ? <><label>Research flow<select value={draft.research.mode} onChange={(e) => setDraft({ ...draft, research: { ...draft.research, mode: e.target.value as "auto" | "review" } })}><option value="auto">Auto continue</option><option value="review">Review sources first</option></select></label><label className="wide">Research instructions<textarea value={draft.research.instructions} onChange={(e) => setDraft({ ...draft, research: { ...draft.research, instructions: e.target.value } })} /></label></> : null}
      <label className="wide">System prompt<div className="prompt-import-row"><button onClick={() => void importPrompt()} disabled={busy}>Import PDF / text</button><span>Import replaces the editor text. Review before saving.</span></div><textarea className="prompt-editor" value={draft.system_prompt} onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })} /></label>
    </div>
    <footer><button onClick={() => setEditing(false)}>Cancel</button><button className="prompt-primary" onClick={() => void save()} disabled={busy || !draft.name.trim() || !draft.system_prompt.trim()}>{busy ? "Saving…" : "Save engine"}</button></footer>
  </div>;

  return <div className="prompt-engines-view">
    <aside className="prompt-engine-library"><header><div><small>LOCAL LIBRARY</small><strong>Prompt Engines</strong></div><button onClick={() => edit()}>＋</button></header>{engines.map((engine) => <button key={engine.id} className={engine.id === selectedId ? "active" : ""} onClick={() => { setSelectedId(engine.id); setActiveRunId(null); }}><b>{engine.icon || "P"}</b><span><strong>{engine.name}</strong><small>{engine.research.enabled ? `Research · ${engine.research.mode}` : "Prompt only"}</small></span></button>)}</aside>
    <section className="prompt-engine-workspace">{selected ? <>{!activeRun ? <div className="prompt-engine-home"><small>PROMPT ENGINE</small><h1>{selected.name}</h1><p>{selected.description || "Reusable local system prompt."}</p><div className="prompt-engine-actions"><button className="prompt-primary" onClick={newRun}>New run</button><button onClick={() => edit(selected)}>Settings</button><button onClick={() => edit({ ...selected, id: `engine-${Date.now()}`, name: `${selected.name} Copy` })}>Duplicate</button><button className="danger" onClick={() => void removeEngine()}>Delete</button></div><h2>Run history</h2><div className="prompt-run-list">{runs.filter((run) => run.engineId === selected.id).map((run) => <button key={run.id} onClick={() => setActiveRunId(run.id)}><span>{run.title}</span><small>{run.sessionFile ? "Saved session" : "New session"}</small></button>)}{runs.every((run) => run.engineId !== selected.id) ? <p>No runs yet.</p> : null}</div></div> : <ChatView projectPath="global" projectName={selected.name} isGit={false} repositories={[]} pipelineType="Personal" chatId={activeRun.id} sessionFile={activeRun.sessionFile} initialModel={activeRun.model} initialThinking={activeRun.thinking} initialInterrupted={activeRun.interrupted} resumableSessions={[]} globalChat customSystemPrompt={activeRun.runtimePrompt || runtimePrompt(selected)} inputPlaceholder={selected.starter_message || "TYPE MESSAGE…"} onSessionFile={(id, sessionFile) => setRuns((items) => items.map((run) => run.id === id ? { ...run, sessionFile } : run))} onFirstMessage={(id, title) => setRuns((items) => items.map((run) => run.id === id ? { ...run, title } : run))} onRuntimeSettings={(id, model, thinking) => setRuns((items) => items.map((run) => run.id === id ? { ...run, model, thinking } : run))} onAgentRunning={(id, interrupted) => setRuns((items) => items.map((run) => run.id === id ? { ...run, interrupted } : run))} onUnread={() => {}} onClose={() => setActiveRunId(null)} onToast={onToast} onOpenPipeline={() => {}} onOpenResearch={() => {}} isActive />}</> : <div className="prompt-engine-home"><h1>No prompt engines</h1><button className="prompt-primary" onClick={() => edit()}>Create engine</button></div>}</section>
  </div>;
}
