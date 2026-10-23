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
import type { ConnectionProfile, ConnectionsView } from "./ConnectionsSettings";

type GraphifyConfig = {
  enabled: boolean;
  base_url: string;
  model: string;
  has_api_key: boolean;
  connection_id?: string | null;
};

export default function GraphifySettings({
  onToast,
}: {
  onToast: (message: string) => void;
}) {
  const [config, setConfig] = useState<GraphifyConfig>({
    enabled: false,
    base_url: "",
    model: "",
    has_api_key: false,
  });
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelSearch, setModelSearch] = useState("");
  const [modelsOpen, setModelsOpen] = useState(false);
  const filteredModels = models.filter((model) =>
    model.toLowerCase().includes(modelSearch.toLowerCase()),
  );

  const [connections, setConnections] = useState<ConnectionProfile[]>([]);
  const connectionId = config.connection_id ?? "";

  useEffect(() => {
    invoke<GraphifyConfig>("get_graphify_settings")
      .then(setConfig)
      .catch((e) => setError(String(e)));
    invoke<ConnectionsView>("list_connections")
      .then((view) =>
        setConnections(
          (view?.profiles ?? []).filter(
            (profile) =>
              profile.protocol !== "anthropic" && profile.has_api_key,
          ),
        ),
      )
      .catch(() => setConnections([]));
  }, []);

  async function fetchModels() {
    setFetching(true);
    setError("");
    try {
      const connection = connections.find(
        (profile) => profile.id === connectionId,
      );
      const next = connection
        ? await invoke<string[]>("fetch_connection_models", {
            protocol: connection.protocol,
            baseUrl: connection.base_url,
            apiKey: null,
            id: connection.id,
          })
        : await invoke<string[]>("fetch_graphify_models", {
            baseUrl: config.base_url,
            apiKey: apiKey || null,
          });
      setModels(next);
      setModelSearch("");
      setModelsOpen(next.length > 0);
      if (!next.length) setError("Provider returned no models.");
    } catch (e) {
      setError(String(e));
    } finally {
      setFetching(false);
    }
  }

  async function save() {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const next = await invoke<GraphifyConfig>("save_graphify_settings", {
        enabled: config.enabled,
        baseUrl: config.base_url,
        model: config.model,
        apiKey: connectionId ? null : apiKey || null,
        connectionId: connectionId || null,
      });
      setConfig(next);
      setApiKey("");
      const message =
        "Graphify settings saved. Restart project chats to apply.";
      setSuccess(message);
      onToast(message);
    } catch (e) {
      setError(`Save failed: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="kset-panel">
      <Group>
        <SwitchField
          label="Enable Graphify"
          detail="Optional. Off means no automatic graph builds, updates or context injection in coding chats."
          checked={config.enabled}
          onChange={(enabled) => setConfig({ ...config, enabled })}
        />
      </Group>
      <Note>
        The provider settings below are used only while Graphify is on. The API
        key is stored in the macOS Keychain, never in the repo or settings JSON.
      </Note>
      <Group>
        {connections.length > 0 && (
          <Field
            label="Connection"
            detail="Reuse a model connection or enter one."
          >
            <select
              value={connectionId}
              onChange={(e) =>
                setConfig({ ...config, connection_id: e.target.value || null })
              }
            >
              <option value="">Custom endpoint</option>
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {!connectionId && (
          <>
            <Field label="Base URL">
              <input
                type="url"
                value={config.base_url}
                onChange={(e) =>
                  setConfig({ ...config, base_url: e.target.value })
                }
                placeholder="https://9router.example/v1"
              />
            </Field>
            <Field label="API key">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  config.has_api_key ? "Saved; leave blank to keep" : "Required"
                }
                autoComplete="new-password"
              />
            </Field>
          </>
        )}
        <div className="kset-row kset-row--wide">
          <span className="kset-row-text">
            <label className="kset-row-title" htmlFor="graphify-model">
              Model
            </label>
          </span>
          <span className="kset-row-control">
            <input
              id="graphify-model"
              value={config.model}
              onFocus={() => {
                if (models.length) {
                  setModelSearch("");
                  setModelsOpen(true);
                }
              }}
              onChange={(e) => {
                setConfig({ ...config, model: e.target.value });
                setModelSearch(e.target.value);
                setModelsOpen(models.length > 0);
              }}
              placeholder="provider/model"
            />
            <button
              type="button"
              onClick={() => void fetchModels()}
              disabled={
                fetching ||
                (!connectionId &&
                  (!config.base_url.trim() || (!apiKey && !config.has_api_key)))
              }
            >
              {fetching ? "Fetching…" : "Fetch models"}
            </button>
          </span>
          {modelsOpen && (
            <div className="graphify-model-picker">
              <div className="graphify-model-search">
                <input
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  placeholder="Search models…"
                  aria-label="Search Graphify models"
                  autoFocus
                />
                <small>
                  {filteredModels.length} of {models.length}
                </small>
              </div>
              <div className="graphify-model-list">
                {filteredModels.map((model) => (
                  <button
                    type="button"
                    key={model}
                    className={model === config.model ? "active" : ""}
                    onClick={() => {
                      setConfig({ ...config, model });
                      setModelSearch("");
                      setModelsOpen(false);
                    }}
                  >
                    <span>{model}</span>
                  </button>
                ))}
                {!filteredModels.length && (
                  <div className="graphify-model-empty">No matching models</div>
                )}
              </div>
            </div>
          )}
        </div>
      </Group>
      <Status error={error} success={success} />
      <Actions>
        <button
          type="button"
          className="primary"
          onClick={() => void save()}
          disabled={saving}
          aria-busy={saving}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </Actions>
    </div>
  );
}
