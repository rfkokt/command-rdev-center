import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Actions,
  Field,
  Group,
  Note,
  Status,
  Subhead,
  SwitchField,
} from "./settings-ui";

type Settings = {
  enabled: boolean;
  base_url: string;
  timeout_secs: number;
  upload_limit_mb: number;
  project_paths: string[];
  has_token: boolean;
};
type Project = { name: string; path: string };

export default function RagSettings({
  onToast,
}: {
  onToast: (message: string) => void;
}) {
  const [settings, setSettings] = useState<Settings>({
    enabled: false,
    base_url: "",
    timeout_secs: 20,
    upload_limit_mb: 25,
    project_paths: [],
    has_token: false,
  });
  const [token, setToken] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void Promise.all([
      invoke<Settings>("get_rag_settings"),
      invoke<Project[]>("list_projects"),
    ])
      .then(([s, p]) => {
        setSettings(s);
        setProjects(p);
      })
      .catch((e) => setError(String(e)));
  }, []);
  const update = (patch: Partial<Settings>) =>
    setSettings((current) => ({ ...current, ...patch }));
  async function save() {
    setBusy(true);
    setError("");
    try {
      const next = await invoke<Settings>("save_rag_settings", {
        settings,
        bearerToken: token || null,
      });
      setSettings(next);
      setToken("");
      onToast("RAG settings saved securely.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="kset-panel">
      <Note>
        Global Chat only. The token stays in the macOS Keychain and extracted
        text stays on this machine. Project sources include top-level UTF-8 TXT,
        MD, CSV and JSON files.
      </Note>
      <Group>
        <SwitchField
          label="Enable RAG"
          detail="Add keyword-matched source citations to Global Chat."
          checked={settings.enabled}
          onChange={(enabled) => update({ enabled })}
        />
        <Field label="Extractor URL" detail="HTTPS base URL.">
          <input
            type="url"
            value={settings.base_url}
            placeholder="https://extractor.example"
            onChange={(e) => update({ base_url: e.target.value })}
          />
        </Field>
        <Field label="Bearer token">
          <input
            type="password"
            value={token}
            placeholder={
              settings.has_token
                ? "Saved; leave blank to keep"
                : "Required when enabled"
            }
            autoComplete="new-password"
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
        <Field label="Timeout" detail="Seconds, 1 to 60.">
          <input
            type="number"
            min="1"
            max="60"
            value={settings.timeout_secs}
            onChange={(e) => update({ timeout_secs: Number(e.target.value) })}
          />
        </Field>
        <Field label="Upload limit" detail="Megabytes, 1 to 25.">
          <input
            type="number"
            min="1"
            max="25"
            value={settings.upload_limit_mb}
            onChange={(e) =>
              update({ upload_limit_mb: Number(e.target.value) })
            }
          />
        </Field>
      </Group>
      <Subhead>Project sources</Subhead>
      {projects.length ? (
        <Group label="Project sources">
          {projects.map((project) => (
            <SwitchField
              key={project.path}
              label={project.name}
              detail={<code>{project.path}</code>}
              checked={settings.project_paths.includes(project.path)}
              onChange={(checked) =>
                update({
                  project_paths: checked
                    ? [...settings.project_paths, project.path]
                    : settings.project_paths.filter(
                        (path) => path !== project.path,
                      ),
                })
              }
            />
          ))}
        </Group>
      ) : (
        <Note>Add a project in the sidebar to use it as a source.</Note>
      )}
      <Status error={error} />
      <Actions>
        <button
          type="button"
          className="primary"
          onClick={() => void save()}
          disabled={busy}
        >
          {busy ? "Working…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() =>
            void invoke("test_rag_connection")
              .then(() => onToast("RAG connection OK."))
              .catch((e) => setError(String(e)))
          }
          disabled={busy || !settings.base_url}
        >
          Test connection
        </button>
      </Actions>
    </div>
  );
}
