import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Actions,
  Field,
  Group,
  Note,
  Status,
  SwitchField,
} from "./settings-ui";

type McpSettings = { enabled: boolean; url: string };

export default function McpSettings({
  onToast,
}: {
  onToast: (message: string) => void;
}) {
  const [settings, setSettings] = useState<McpSettings>({
    enabled: false,
    url: "https://mcp.figma.com/mcp",
  });
  const [saved, setSaved] = useState<McpSettings | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    invoke<McpSettings>("get_figma_mcp_settings")
      .then((value) => {
        setSettings(value);
        setSaved(value);
      })
      .catch((e) => setError(String(e)));
  }, []);

  async function save() {
    try {
      await invoke("save_figma_mcp_settings", {
        enabled: settings.enabled,
        url: settings.url,
      });
      setSaved(settings);
      setError("");
      onToast("Figma MCP saved — restart chat, then run /mcp-auth figma.");
    } catch (e) {
      setError(String(e));
    }
  }

  const changed =
    !saved || saved.enabled !== settings.enabled || saved.url !== settings.url;
  return (
    <div className="kset-panel">
      <Note>
        Uses the pi MCP adapter. Figma signs you in through the browser; Kern
        Studio stores no token.
      </Note>
      <Group>
        <SwitchField
          label="Figma MCP"
          detail="Enable the official Figma remote MCP server for new chats."
          checked={settings.enabled}
          onChange={(enabled) => setSettings({ ...settings, enabled })}
        />
        <Field label="Server URL" detail="Remote Streamable HTTP endpoint.">
          <input
            type="url"
            value={settings.url}
            onChange={(e) => setSettings({ ...settings, url: e.target.value })}
            placeholder="https://mcp.figma.com/mcp"
          />
        </Field>
      </Group>
      <Note>
        After saving, start a new chat and run <code>/mcp-auth figma</code>.
      </Note>
      <Status error={error} />
      <Actions>
        <button
          type="button"
          className="primary"
          onClick={() => void save()}
          disabled={!changed}
        >
          Save
        </button>
      </Actions>
    </div>
  );
}
