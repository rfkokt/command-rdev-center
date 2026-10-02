import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Config = {
  mode: "off" | "shadow" | "advisory";
  endpoint: string;
  model: string;
  timeout_ms: number;
  has_api_key: boolean;
};

export default function JevSettings({
  onToast,
}: {
  onToast: (message: string) => void;
}) {
  const [config, setConfig] = useState<Config>({
    mode: "off",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-1.13.0",
    timeout_ms: 2500,
    has_api_key: false,
  });
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState("");
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen("jev-settings-changed", () => {
      if (!active) return;
      setConfig((current) => ({ ...current, mode: "off" }));
      setSuccess(
        "Jev automatically switched Off because provider credits/billing ran out. Re-enable after topping up.",
      );
    })
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      })
      .catch(() => {});
    invoke<Config>("get_jev_settings")
      .then((value) => {
        if (active) setConfig(value);
      })
      .catch((e) => {
        if (active) setError(String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
  async function save() {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      setConfig(
        await invoke<Config>("save_jev_settings", {
          settings: config,
          apiKey: apiKey || null,
        }),
      );
      setApiKey("");
      const message =
        "Jev settings saved — restart project chat sessions to apply.";
      setSuccess(message);
      onToast(message);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <main className="graphify-settings">
      <div className="settings-notice">
        Jev recommends tools and skills for project chats. Shadow records
        suggestions; advisory shares them with the agent. Neither mode runs
        tools or changes permissions.
      </div>
      <fieldset
        disabled={loading || saving}
        style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 16 }}
      >
        <label>
          ROUTING MODE
          <select
            value={config.mode}
            onChange={(e) =>
              setConfig({ ...config, mode: e.target.value as Config["mode"] })
            }
          >
            <option value="off">Off — no Jev requests</option>
            <option value="shadow">Shadow — record suggestions only</option>
            <option value="advisory">Advisory — suggest to agent</option>
          </select>
        </label>
        <div className="settings-notice">
          Enabling routing sends the current request and available tool/skill
          descriptions to your configured provider before each turn and uses its
          API allowance. Project rules, file ranking, and compaction are planned
          separately.
        </div>
        <label>
          DECISION ENDPOINT
          <input
            type="url"
            value={config.endpoint}
            onChange={(e) => setConfig({ ...config, endpoint: e.target.value })}
          />
        </label>
        <label>
          MODEL
          <input
            value={config.model}
            onChange={(e) => setConfig({ ...config, model: e.target.value })}
          />
        </label>
        <label>
          API KEY
          <input
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              config.has_api_key
                ? "Saved — leave blank to keep current key"
                : "Required for shadow or advisory"
            }
          />
        </label>
        <div className="settings-notice">
          API key is stored in macOS Keychain. A timeout or unavailable provider
          leaves the usual agent workflow intact. Exhausted provider
          credits/billing automatically switch Jev Off; re-enable after topping
          up.
        </div>
        <label>
          TIMEOUT (MS)
          <input
            type="number"
            min={100}
            max={30000}
            step={100}
            value={config.timeout_ms}
            onChange={(e) =>
              setConfig({ ...config, timeout_ms: Number(e.target.value) })
            }
          />
        </label>
      </fieldset>
      {loading && <div role="status">Loading Jev settings…</div>}
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="settings-success" role="status">
          {success}
        </div>
      )}
      <button
        className="save-settings"
        onClick={save}
        disabled={
          loading ||
          saving ||
          !config.endpoint.trim() ||
          !config.model.trim() ||
          !Number.isInteger(config.timeout_ms) ||
          config.timeout_ms < 100 ||
          config.timeout_ms > 30000 ||
          (config.mode !== "off" && !apiKey.trim() && !config.has_api_key)
        }
        aria-busy={saving}
      >
        {saving ? "SAVING…" : "SAVE JEV SETTINGS"}
      </button>
    </main>
  );
}
