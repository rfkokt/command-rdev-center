import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Actions,
  Field,
  Group,
  ItemRow,
  Note,
  Status,
  Subhead,
} from "./settings-ui";

export type Protocol = "openai-chat" | "openai-responses" | "anthropic";

export type ConnectionProfile = {
  id: string;
  name: string;
  protocol: Protocol;
  base_url: string;
  models: string[];
  has_api_key: boolean;
};

export type ConnectionsView = {
  profiles: ConnectionProfile[];
  assignments: Record<string, string>;
  compatibility: Record<string, Protocol[]>;
  assignment_required: string[];
};

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  "openai-chat": "OpenAI-compatible (Chat Completions)",
  "openai-responses": "OpenAI Responses",
  anthropic: "Anthropic-compatible (Messages)",
};

const PRESETS: Array<{
  label: string;
  name: string;
  protocol: Protocol;
  base_url: string;
}> = [
  {
    label: "OpenRouter",
    name: "OpenRouter",
    protocol: "openai-chat",
    base_url: "https://openrouter.ai/api/v1",
  },
  {
    label: "OpenAI",
    name: "OpenAI",
    protocol: "openai-responses",
    base_url: "https://api.openai.com/v1",
  },
  {
    label: "Anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    base_url: "https://api.anthropic.com",
  },
  {
    label: "Ollama (local)",
    name: "Ollama",
    protocol: "openai-chat",
    base_url: "http://localhost:11434/v1",
  },
];

const HARNESS_LABELS: Record<string, string> = {
  pi: "pi",
  "oh-my-pi": "oh-my-pi",
  opencode: "OpenCode",
  "claude-code": "Claude Code",
  codex: "Codex",
};

type Draft = {
  id: string;
  name: string;
  protocol: Protocol;
  base_url: string;
  models: string;
  apiKey: string;
  isNew: boolean;
  hasKey: boolean;
};

const EMPTY: Draft = {
  id: "",
  name: "",
  protocol: "openai-chat",
  base_url: "",
  models: "",
  apiKey: "",
  isNew: true,
  hasKey: false,
};

export function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function parseModels(text: string) {
  return [
    ...new Set(
      text
        .split(/[\n,]+/)
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
}

/** Model connection profiles shared by every agent harness. */
export default function ConnectionsSettings({
  onToast,
}: {
  onToast: (message: string) => void;
}) {
  const [view, setView] = useState<ConnectionsView | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [fetched, setFetched] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "fetch">("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setView(await invoke<ConnectionsView>("list_connections"));
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function edit(profile: ConnectionProfile) {
    setDraft({
      id: profile.id,
      name: profile.name,
      protocol: profile.protocol,
      base_url: profile.base_url,
      models: profile.models.join("\n"),
      apiKey: "",
      isNew: false,
      hasKey: profile.has_api_key,
    });
    setFetched([]);
    setError("");
  }

  async function fetchModels() {
    setBusy("fetch");
    setError("");
    try {
      const models = await invoke<string[]>("fetch_connection_models", {
        protocol: draft.protocol,
        baseUrl: draft.base_url,
        apiKey: draft.apiKey || null,
        id: draft.isNew ? null : draft.id,
      });
      setFetched(models);
      setFilter("");
      if (!models.length) setError("Provider returned no models.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  }

  function toggleModel(model: string) {
    const current = parseModels(draft.models);
    const next = current.includes(model)
      ? current.filter((item) => item !== model)
      : [...current, model];
    setDraft({ ...draft, models: next.join("\n") });
  }

  async function save() {
    setBusy("save");
    setError("");
    try {
      const id = draft.isNew ? draft.id || slugify(draft.name) : draft.id;
      const next = await invoke<ConnectionsView>("save_connection", {
        profile: {
          id,
          name: draft.name,
          protocol: draft.protocol,
          base_url: draft.base_url,
          models: parseModels(draft.models),
        },
        apiKey: draft.apiKey || null,
      });
      setView(next);
      setDraft(EMPTY);
      setFetched([]);
      onToast(
        `Connection ${draft.name} saved — restart chats to pick up new models.`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  }

  async function remove(profile: ConnectionProfile) {
    try {
      setView(
        await invoke<ConnectionsView>("delete_connection", { id: profile.id }),
      );
      if (draft.id === profile.id) setDraft(EMPTY);
      onToast(`Removed ${profile.name}`);
    } catch (e) {
      setError(String(e));
    }
  }

  async function assign(harness: string, profileId: string) {
    try {
      setView(
        await invoke<ConnectionsView>("set_connection_assignment", {
          harness,
          profileId: profileId || null,
        }),
      );
    } catch (e) {
      setError(String(e));
    }
  }

  const draftModels = parseModels(draft.models);
  const shown = fetched.filter((model) =>
    model.toLowerCase().includes(filter.toLowerCase()),
  );
  const canSave =
    draft.name.trim() &&
    draft.base_url.trim() &&
    (draft.apiKey.trim() || draft.hasKey);

  return (
    <div className="kset-panel">
      <Note>
        Add an endpoint once and every agent can use it. Keys stay in the macOS
        Keychain; agent config files only reference an environment variable Kern
        sets at launch. Models appear in pi, oh-my-pi and OpenCode as{" "}
        <code>kern-&lt;id&gt;/&lt;model&gt;</code>.
      </Note>

      {view && view.profiles.length > 0 && (
        <Group label="Connections">
          {view.profiles.map((profile) => (
            <ItemRow
              key={profile.id}
              title={profile.name}
              detail={
                <>
                  {PROTOCOL_LABELS[profile.protocol]} · {profile.base_url} ·{" "}
                  {profile.models.length} model
                  {profile.models.length === 1 ? "" : "s"}
                  {profile.has_api_key ? "" : " · no key"}
                </>
              }
            >
              <button type="button" onClick={() => edit(profile)}>
                Edit
              </button>
              <button
                type="button"
                className="kset-link-button"
                aria-label={`Delete ${profile.name}`}
                onClick={() => void remove(profile)}
              >
                Delete
              </button>
            </ItemRow>
          ))}
        </Group>
      )}

      <Subhead
        actions={
          draft.isNew ? (
            <div className="kset-chips">
              {PRESETS.map((preset) => (
                <button
                  type="button"
                  key={preset.label}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      name: preset.name,
                      id: slugify(preset.name),
                      protocol: preset.protocol,
                      base_url: preset.base_url,
                    })
                  }
                >
                  {preset.label}
                </button>
              ))}
            </div>
          ) : (
            <button
              type="button"
              className="kset-link-button"
              onClick={() => setDraft(EMPTY)}
            >
              Cancel
            </button>
          )
        }
      >
        {draft.isNew ? "New connection" : `Edit ${draft.name}`}
      </Subhead>
      <Group>
        <Field label="Name">
          <input
            value={draft.name}
            onChange={(e) =>
              setDraft({
                ...draft,
                name: e.target.value,
                id: draft.isNew ? slugify(e.target.value) : draft.id,
              })
            }
            placeholder="OpenRouter"
          />
        </Field>
        <Field label="Protocol">
          <select
            value={draft.protocol}
            onChange={(e) =>
              setDraft({ ...draft, protocol: e.target.value as Protocol })
            }
          >
            {(Object.keys(PROTOCOL_LABELS) as Protocol[]).map((protocol) => (
              <option key={protocol} value={protocol}>
                {PROTOCOL_LABELS[protocol]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Base URL">
          <input
            type="url"
            value={draft.base_url}
            onChange={(e) => setDraft({ ...draft, base_url: e.target.value })}
            placeholder={
              draft.protocol === "anthropic"
                ? "https://api.anthropic.com"
                : "https://openrouter.ai/api/v1"
            }
          />
        </Field>
        <Field label="API key">
          <input
            type="password"
            value={draft.apiKey}
            onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            placeholder={
              draft.hasKey ? "Saved; leave blank to keep" : "Required"
            }
            autoComplete="new-password"
          />
        </Field>
        <div className="kset-row kset-row--wide">
          <span className="kset-row-text">
            <label className="kset-row-title" htmlFor="connection-models">
              Models
            </label>
            <span className="kset-row-desc">
              One per line. The first is the default.
            </span>
          </span>
          <span className="kset-row-control">
            <textarea
              id="connection-models"
              rows={4}
              value={draft.models}
              onChange={(e) => setDraft({ ...draft, models: e.target.value })}
              placeholder={"deepseek/deepseek-v4\nqwen/qwen3-coder"}
            />
            <button
              type="button"
              onClick={() => void fetchModels()}
              disabled={
                busy !== "" ||
                !draft.base_url.trim() ||
                (!draft.apiKey && !draft.hasKey)
              }
            >
              {busy === "fetch" ? "Fetching…" : "Fetch models"}
            </button>
          </span>
          {fetched.length > 0 && (
            <div className="graphify-model-picker">
              <div className="graphify-model-search">
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Search models…"
                  aria-label="Search connection models"
                />
                <small>
                  {draftModels.length} selected · {shown.length} of{" "}
                  {fetched.length}
                </small>
              </div>
              <div className="graphify-model-list">
                {shown.map((model) => (
                  <button
                    type="button"
                    key={model}
                    className={draftModels.includes(model) ? "active" : ""}
                    onClick={() => toggleModel(model)}
                  >
                    <span>{model}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </Group>
      <Status error={error} />
      <Actions>
        <button
          type="button"
          className="primary"
          onClick={() => void save()}
          disabled={!canSave || busy !== ""}
        >
          {busy === "save" ? "Saving…" : "Save connection"}
        </button>
      </Actions>

      {view && view.profiles.length > 0 && (
        <>
          <Subhead>Use in agents</Subhead>
          <Group label="Use in agents">
            {Object.keys(HARNESS_LABELS).map((harness) => {
              const compatible = view.profiles.filter((profile) =>
                (view.compatibility[harness] ?? []).includes(profile.protocol),
              );
              const required = view.assignment_required.includes(harness);
              const detail =
                compatible.length === 0
                  ? `Needs a connection using ${(
                      view.compatibility[harness] ?? []
                    )
                      .map((protocol) => PROTOCOL_LABELS[protocol])
                      .join(" or ")}`
                  : required
                    ? "Routes all requests through the selected connection"
                    : harness === "opencode"
                      ? "All compatible connections listed; pick the default model"
                      : "All compatible connections listed in the model picker";
              return (
                <ItemRow
                  key={harness}
                  title={HARNESS_LABELS[harness]}
                  detail={detail}
                >
                  {required || harness === "opencode" ? (
                    <select
                      aria-label={`Connection for ${HARNESS_LABELS[harness]}`}
                      value={view.assignments[harness] ?? ""}
                      onChange={(e) => void assign(harness, e.target.value)}
                      disabled={compatible.length === 0}
                    >
                      <option value="">
                        {required ? "Own login / env" : "Harness default"}
                      </option>
                      {compatible.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="kset-count">
                      {compatible.length} available
                    </span>
                  )}
                </ItemRow>
              );
            })}
          </Group>
        </>
      )}
    </div>
  );
}
