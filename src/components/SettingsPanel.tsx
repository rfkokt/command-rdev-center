import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import GraphifySettings from "./GraphifySettings";
import McpSettings from "./McpSettings";
import PipelineSettings from "./PipelineSettings";
import RagSettings from "./RagSettings";
import { useModalFocus } from "./useModalFocus";

type PiRuntimeStatus = { health: "healthy" | "partial" | "missing"; path?: string; installed_version?: string; latest_version?: string };

const GROUPS = [
  ["Model & Thinking", "defaultProvider, defaultModel, defaultThinkingLevel, hideThinkingBlock, showCacheMissNotices, thinkingBudgets", ["defaultProvider", "defaultModel", "defaultThinkingLevel", "thinkingBudgets"]],
  ["UI & Display", "theme, externalEditor, quietStartup, defaultProjectTrust, collapseChangelog, telemetry, doubleEscapeAction, treeFilterMode, padding, autocomplete, cursor", ["theme", "externalEditor", "quietStartup", "padding"]],
  ["Compaction", "compaction.enabled, reserveTokens, keepRecentTokens; branchSummary", ["compaction", "branchSummary"]],
  ["Retry", "retry.enabled, maxRetries, baseDelayMs, provider timeouts/retries", ["retry", "maxRetries", "baseDelayMs"]],
  ["Delivery & Network", "steeringMode, followUpMode, transport, HTTP/WebSocket timeouts, httpProxy", ["steeringMode", "followUpMode", "transport", "httpProxy"]],
  ["Terminal & Images", "terminal image display/width/clear; image resize/blocking", ["terminal", "image"]],
  ["Shell & Sessions", "shellPath, shellCommandPrefix, npmCommand, sessionDir", ["shellPath", "shellCommandPrefix", "npmCommand", "sessionDir"]],
  ["Models & Markdown", "enabledModels, markdown.codeBlockIndent", ["enabledModels", "markdown"]],
  ["Resources", "packages, extensions, skills, prompts, themes, enableSkillCommands", ["packages", "extensions", "skills", "prompts", "themes"]],
] as const;

export default function SettingsPanel({ projectPath, projectName, initialPage = "pi", onClose, onToast }: { projectPath?: string; projectName?: string; initialPage?: "pi" | "pipeline"; onClose: () => void; onToast: (message: string) => void }) {
  const [page, setPage] = useState<"pi" | "graphify" | "mcp" | "rag" | "pipeline">(initialPage);
  const [scope, setScope] = useState<"global" | "project">("global");
  const [text, setText] = useState("{}");
  const [saved, setSaved] = useState("{}");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [activeGroup, setActiveGroup] = useState("");
  const [mode, setMode] = useState<"form" | "json">("form");
  const [backlogDir, setBacklogDir] = useState("");
  const [runtime, setRuntime] = useState<PiRuntimeStatus | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeLog, setRuntimeLog] = useState("");

  const editorRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useModalFocus<HTMLElement>(onClose);

  useEffect(() => {
    void invoke<string>("get_backlog_dir").then(setBacklogDir).catch((e) => setError(String(e)));
    void invoke<PiRuntimeStatus>("get_pi_runtime_status").then(setRuntime).catch((e) => setRuntimeLog(String(e)));
  }, []);

  useEffect(() => {
    setLoading(true);
    setError("");
    invoke<Record<string, unknown>>("get_pi_settings", { scope, projectPath: scope === "project" ? projectPath : null })
      .then((settings) => { const json = JSON.stringify(settings, null, 2); setText(json); setSaved(json); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [scope, projectPath]);

  function settingsObject() {
    try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
  }

  function updateSetting(key: string, value: unknown) {
    const settings = settingsObject();
    if (value === "") delete settings[key]; else settings[key] = value;
    setText(JSON.stringify(settings, null, 2));
    setError("");
  }

  function jumpToGroup(name: string, keys: readonly string[]) {
    setActiveGroup(name);
    if (mode === "form") {
      document.getElementById(`setting-${keys[0]}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const editor = editorRef.current;
    const index = keys.map((key) => text.indexOf(`"${key}"`)).find((position) => position >= 0);
    if (!editor || index === undefined) return onToast(`${name}: no configured values in this scope.`);
    editor.focus();
    editor.setSelectionRange(index, index + text.slice(index).indexOf(":") + 1);
    editor.scrollTop = editor.scrollHeight * index / text.length;
  }

  async function chooseSessionDir() {
    const path = await open({ directory: true, multiple: false, title: "Choose Pi Session Storage" });
    if (!path) return;
    try {
      const settings = JSON.parse(text) as Record<string, unknown>;
      setText(JSON.stringify({ ...settings, sessionDir: path }, null, 2));
      setError("");
    } catch (e) { setError(String(e)); }
  }

  async function chooseBacklogDir() {
    const path = await open({ directory: true, multiple: false, title: "Choose Backlog & Error Report Storage" });
    if (!path) return;
    try {
      setBacklogDir(await invoke<string>("save_backlog_dir", { path }));
      onToast("Backlog storage saved.");
    } catch (e) { setError(String(e)); }
  }

  async function updateRuntime() {
    setRuntimeBusy(true); setRuntimeLog("Installing the latest Pi runtime…");
    try {
      const next = await invoke<PiRuntimeStatus>("update_pi_runtime");
      setRuntime(next); setRuntimeLog(`Pi ${next.installed_version || ""} is healthy. Reload active chats.`); onToast("Pi updated — reload active chats.");
    } catch (e) { setRuntimeLog(String(e)); } finally { setRuntimeBusy(false); }
  }

  async function syncExtensions() {
    setRuntimeBusy(true); setRuntimeLog("Syncing Kern Studio extensions…");
    try {
      const path = await invoke<string>("sync_pi_extensions");
      setRuntimeLog(`Extensions synced to ${path}. Reload active chats.`); onToast("Pi extensions synced — reload active chats.");
    } catch (e) { setRuntimeLog(String(e)); } finally { setRuntimeBusy(false); }
  }

  async function save() {
    try {
      const settings = JSON.parse(text) as unknown;
      if (!settings || Array.isArray(settings) || typeof settings !== "object") throw new Error("Root must be a JSON object");
      await invoke("save_pi_settings", { scope, projectPath: scope === "project" ? projectPath : null, settings });
      window.dispatchEvent(new CustomEvent("pi-settings-saved", { detail: settings }));
      const formatted = JSON.stringify(settings, null, 2);
      setText(formatted); setSaved(formatted); setError("");
      onToast("Pi settings saved — restart sessions for non-live settings.");
    } catch (e) { setError(String(e)); }
  }

  return <div className="settings-backdrop">
    <section ref={panelRef} className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1}>
      <header><div><small>CONFIGURATION</small><strong id="settings-title">{page === "pi" ? "PI SETTINGS" : page === "graphify" ? "GRAPHIFY SETTINGS" : page === "mcp" ? "MCP SETTINGS" : page === "rag" ? "RAG SETTINGS" : "PIPELINE SETTINGS"}</strong></div><button onClick={onClose} aria-label="Close settings">ESC</button></header>
      <div className="settings-scope">
        <button className={page === "pi" ? "active" : ""} onClick={() => setPage("pi")}>PI</button>
        <button className={page === "graphify" ? "active" : ""} onClick={() => setPage("graphify")}>GRAPHIFY</button>
        <button className={page === "mcp" ? "active" : ""} onClick={() => setPage("mcp")}>MCP</button>
        <button className={page === "rag" ? "active" : ""} onClick={() => setPage("rag")}>RAG</button>
        <button className={page === "pipeline" ? "active" : ""} disabled={!projectPath} onClick={() => setPage("pipeline")}>PIPELINE</button>
        {page === "pi" && <><button className={scope === "global" ? "active" : ""} onClick={() => setScope("global")}>GLOBAL</button><button className={scope === "project" ? "active" : ""} disabled={!projectPath} onClick={() => setScope("project")}>PROJECT</button><span>{scope === "global" ? "~/.pi/agent/settings.json" : `${projectPath}/.pi/settings.json`}</span></>}
      </div>
      {page === "graphify" ? <GraphifySettings onToast={onToast} /> : page === "mcp" ? <McpSettings onToast={onToast} /> : page === "rag" ? <RagSettings onToast={onToast} /> : page === "pipeline" && projectPath ? <PipelineSettings projectPath={projectPath} projectName={projectName} onToast={onToast} /> : page === "pipeline" ? <div className="pipeline-project-empty"><strong>SELECT A PROJECT</strong><span>Choose the pipeline shortcut beside a project, then configure its steps here.</span></div> : <><div className="settings-content">
        <nav>{GROUPS.map(([name, detail, keys]) => <button type="button" className={activeGroup === name ? "active" : ""} key={name} onClick={() => jumpToGroup(name, keys)}><strong>{name}</strong><span>{detail}</span></button>)}</nav>
        <main>
          <div className="settings-mode"><button className={mode === "form" ? "active" : ""} onClick={() => setMode("form")}>FORM</button><button className={mode === "json" ? "active" : ""} onClick={() => setMode("json")}>JSON · ADVANCED</button></div>
          <div className="settings-notice">Project values override global values. Unknown/custom keys are preserved. Most settings apply to newly started sessions.</div>
          {scope === "global" && <section className="pi-runtime-card">
            <div><small>PI RUNTIME</small><strong>{runtime?.health?.toUpperCase() || "CHECKING…"}</strong><span>{runtime?.installed_version || "Not installed"}{runtime?.latest_version ? ` · Latest ${runtime.latest_version}` : ""}</span><code>{runtime?.path || "Pi binary not found"}</code></div>
            <div><button disabled={runtimeBusy} onClick={() => void invoke<PiRuntimeStatus>("get_pi_runtime_status").then(setRuntime).catch((e) => setRuntimeLog(String(e)))}>CHECK</button><button disabled={runtimeBusy} onClick={updateRuntime}>{runtime?.health === "healthy" ? "UPDATE / REPAIR PI" : "INSTALL / REPAIR PI"}</button><button disabled={runtimeBusy} onClick={syncExtensions}>SYNC EXTENSIONS</button></div>
            {runtimeLog && <pre>{runtimeLog}</pre>}
          </section>}
          {loading ? <div className="settings-loading">LOADING…</div> : mode === "json" ? <textarea ref={editorRef} value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} aria-label="Pi settings JSON" /> : <div className="settings-form">
            {(() => { const settings = settingsObject(); return <>
              <label id="setting-defaultProvider"><span>DEFAULT PROVIDER<small>Provider used for new sessions</small></span><input value={String(settings.defaultProvider ?? "")} onChange={(e) => updateSetting("defaultProvider", e.target.value)} placeholder="e.g. anthropic" /></label>
              <label id="setting-defaultModel"><span>DEFAULT MODEL<small>Model ID used for new sessions</small></span><input value={String(settings.defaultModel ?? "")} onChange={(e) => updateSetting("defaultModel", e.target.value)} placeholder="provider model ID" /></label>
              <label id="setting-defaultThinkingLevel"><span>THINKING LEVEL<small>Default reasoning effort</small></span><select className="themed-select" value={String(settings.defaultThinkingLevel ?? "")} onChange={(e) => updateSetting("defaultThinkingLevel", e.target.value)}><option value="">Pi default</option>{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((v) => <option key={v}>{v}</option>)}</select></label>
              {[ ["hideThinkingBlock", "HIDE THINKING", "Hide reasoning blocks"], ["showCacheMissNotices", "CACHE MISS NOTICES", "Show cache status"], ["quietStartup", "QUIET STARTUP", "Reduce startup messages"], ["telemetry", "TELEMETRY", "Allow anonymous telemetry"], ["enableSkillCommands", "SKILL COMMANDS", "Expose skills as commands"] ].map(([key, title, detail]) => <label className="settings-toggle" id={`setting-${key}`} key={key}><span>{title}<small>{detail}</small></span><input type="checkbox" checked={settings[key] === true} onChange={(e) => updateSetting(key, e.target.checked)} /></label>)}
              <label id="setting-theme"><span>THEME<small>Installed Pi theme name</small></span><input value={String(settings.theme ?? "")} onChange={(e) => updateSetting("theme", e.target.value)} placeholder="Pi default" /></label>
              <label id="setting-externalEditor"><span>EXTERNAL EDITOR<small>Editor command</small></span><input value={String(settings.externalEditor ?? "")} onChange={(e) => updateSetting("externalEditor", e.target.value)} placeholder="e.g. code --wait" /></label>
              <label id="setting-shellPath"><span>SHELL PATH<small>Shell executable</small></span><input value={String(settings.shellPath ?? "")} onChange={(e) => updateSetting("shellPath", e.target.value)} placeholder="System default" /></label>
              {scope === "global" && <><div className="session-storage-setting" id="setting-sessionDir"><div><strong>SESSION STORAGE</strong><span>{String(settings.sessionDir || "~/.pi/agent/sessions")}</span></div><button onClick={chooseSessionDir}>CHOOSE FOLDER</button></div><div className="session-storage-setting"><div><strong>BACKLOG & ERROR REPORTS</strong><span>{backlogDir || "Loading…"}</span></div><button onClick={chooseBacklogDir}>CHOOSE FOLDER</button></div></>}
            </>; })()}
          </div>}
          {error && <div className="settings-error">{error}</div>}
        </main>
      </div>
      <footer><span>{text === saved ? "NO CHANGES" : "UNSAVED CHANGES"}</span><div><button onClick={() => setText(saved)} disabled={text === saved}>RESET</button><button className="save-settings" onClick={save} disabled={loading || text === saved}>SAVE SETTINGS</button></div></footer></>}
    </section>
  </div>;
}
