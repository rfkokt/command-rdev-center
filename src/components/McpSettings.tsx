import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type McpSettings = { enabled: boolean; url: string };

export default function McpSettings({ onToast }: { onToast: (message: string) => void }) {
  const [settings, setSettings] = useState<McpSettings>({ enabled: false, url: "https://mcp.figma.com/mcp" });
  const [saved, setSaved] = useState<McpSettings | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    invoke<McpSettings>("get_figma_mcp_settings").then((value) => { setSettings(value); setSaved(value); }).catch((e) => setError(String(e)));
  }, []);

  async function save() {
    try {
      await invoke("save_figma_mcp_settings", { enabled: settings.enabled, url: settings.url });
      setSaved(settings); setError("");
      onToast("Figma MCP saved — restart chat, then run /mcp-auth figma.");
    } catch (e) { setError(String(e)); }
  }

  const changed = !saved || saved.enabled !== settings.enabled || saved.url !== settings.url;
  return <main className="graphify-settings">
    <div className="settings-notice">Uses Pi MCP Adapter. Figma authorizes in your browser; no token is stored by Command RDEV Center.</div>
    <label className="settings-toggle"><span>FIGMA MCP<small>Enable the official Figma remote MCP server for new chats</small></span><input type="checkbox" checked={settings.enabled} onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })} /></label>
    <label>SERVER URL<small>Remote Streamable HTTP endpoint</small><input type="url" value={settings.url} onChange={(e) => setSettings({ ...settings, url: e.target.value })} placeholder="https://mcp.figma.com/mcp" /></label>
    <div className="settings-notice">After saving, start a new chat and run <code>/mcp-auth figma</code>.</div>
    {error && <div className="settings-error" role="alert">{error}</div>}
    <button className="save-settings" onClick={save} disabled={!changed}>SAVE MCP</button>
  </main>;
}
