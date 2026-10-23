import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Actions, Field, Group, Note, Status } from "./settings-ui";
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
    <div className="kset-panel">
      <Note>
        Jev recommends tools and skills for project chats. Shadow records
        suggestions; advisory shares them with the agent. Neither mode runs
        tools or changes permissions.
      </Note>
      <fieldset className="kset-fieldset" disabled={loading || saving}>
        <Group>
          <Field
            label="Routing mode"
            detail="Shadow and advisory send each request to your provider."
          >
            <select
              value={config.mode}
              onChange={(e) =>
                setConfig({ ...config, mode: e.target.value as Config["mode"] })
              }
            >
              <option value="off">Off</option>
              <option value="shadow">Shadow: record only</option>
              <option value="advisory">Advisory: suggest to agent</option>
            </select>
          </Field>
        </Group>
        <Note>
          With routing on, the current request and the available tool and skill
          descriptions go to your provider before each turn, using its API
          allowance.
        </Note>
        <Group>
          <Field label="Decision endpoint">
            <input
              type="url"
              value={config.endpoint}
              onChange={(e) =>
                setConfig({ ...config, endpoint: e.target.value })
              }
            />
          </Field>
          <Field label="Model">
            <input
              value={config.model}
              onChange={(e) => setConfig({ ...config, model: e.target.value })}
            />
          </Field>
          <Field label="API key" detail="Stored in the macOS Keychain.">
            <input
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                config.has_api_key
                  ? "Saved; leave blank to keep"
                  : "Required for shadow or advisory"
              }
            />
          </Field>
          <Field label="Timeout" detail="Milliseconds, 100 to 30000.">
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
          </Field>
        </Group>
        <Note>
          A timeout or unavailable provider leaves the normal agent workflow
          intact. If provider credits run out, Jev switches itself off.
        </Note>
      </fieldset>
      {loading && <div role="status">Loading Jev settings…</div>}
      <Status error={error} success={success} />
      <Actions>
        <button
          type="button"
          className="primary"
          onClick={() => void save()}
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
          {saving ? "Saving…" : "Save"}
        </button>
      </Actions>
    </div>
  );
}
