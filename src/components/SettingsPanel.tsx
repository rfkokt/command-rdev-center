import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const GROUPS = [
  ["Model & Thinking", "defaultProvider, defaultModel, defaultThinkingLevel, hideThinkingBlock, showCacheMissNotices, thinkingBudgets"],
  ["UI & Display", "theme, externalEditor, quietStartup, defaultProjectTrust, collapseChangelog, telemetry, doubleEscapeAction, treeFilterMode, padding, autocomplete, cursor"],
  ["Compaction", "compaction.enabled, reserveTokens, keepRecentTokens; branchSummary"],
  ["Retry", "retry.enabled, maxRetries, baseDelayMs, provider timeouts/retries"],
  ["Delivery & Network", "steeringMode, followUpMode, transport, HTTP/WebSocket timeouts, httpProxy"],
  ["Terminal & Images", "terminal image display/width/clear; image resize/blocking"],
  ["Shell & Sessions", "shellPath, shellCommandPrefix, npmCommand, sessionDir"],
  ["Models & Markdown", "enabledModels, markdown.codeBlockIndent"],
  ["Resources", "packages, extensions, skills, prompts, themes, enableSkillCommands"],
] as const;

export default function SettingsPanel({ projectPath, onClose, onToast }: { projectPath?: string; onClose: () => void; onToast: (message: string) => void }) {
  const [scope, setScope] = useState<"global" | "project">("global");
  const [text, setText] = useState("{}");
  const [saved, setSaved] = useState("{}");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError("");
    invoke<Record<string, unknown>>("get_pi_settings", { scope, projectPath: scope === "project" ? projectPath : null })
      .then((settings) => { const json = JSON.stringify(settings, null, 2); setText(json); setSaved(json); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [scope, projectPath]);

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
    <section className="settings-panel" aria-label="Pi settings">
      <header><div><small>CONFIGURATION</small><strong>PI SETTINGS</strong></div><button onClick={onClose}>ESC</button></header>
      <div className="settings-scope">
        <button className={scope === "global" ? "active" : ""} onClick={() => setScope("global")}>GLOBAL</button>
        <button className={scope === "project" ? "active" : ""} disabled={!projectPath} onClick={() => setScope("project")}>PROJECT</button>
        <span>{scope === "global" ? "~/.pi/agent/settings.json" : `${projectPath}/.pi/settings.json`}</span>
      </div>
      <div className="settings-content">
        <nav>{GROUPS.map(([name, detail]) => <div key={name}><strong>{name}</strong><span>{detail}</span></div>)}</nav>
        <main>
          <div className="settings-notice">Complete Pi settings JSON. Project values override global values. Unknown/custom keys are preserved. Most settings apply to newly started sessions.</div>
          {loading ? <div className="settings-loading">LOADING…</div> : <textarea value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} aria-label="Pi settings JSON" />}
          {error && <div className="settings-error">{error}</div>}
        </main>
      </div>
      <footer><span>{text === saved ? "NO CHANGES" : "UNSAVED CHANGES"}</span><div><button onClick={() => setText(saved)} disabled={text === saved}>RESET</button><button className="save-settings" onClick={save} disabled={loading || text === saved}>SAVE SETTINGS</button></div></footer>
    </section>
  </div>;
}
