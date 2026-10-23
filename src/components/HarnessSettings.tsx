import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type HarnessInfo = {
  id: string;
  label: string;
  protocol: "native" | "acp";
  command: string;
  resolved_path: string | null;
  available: boolean;
  install_hint: string;
  is_default: boolean;
  custom: boolean;
  /** Kern can install it with npm. */
  installable?: boolean;
};

type CustomDraft = { id: string; label: string; command: string; args: string };
const EMPTY_DRAFT: CustomDraft = { id: "", label: "", command: "", args: "" };

/** Agent harness picker: which coding agent new chats run (pi, OpenCode, Claude Code, …). */
export default function HarnessSettings({
  onToast,
}: {
  onToast: (message: string) => void;
}) {
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const [selected, setSelected] = useState("pi");
  const [draft, setDraft] = useState<CustomDraft>(EMPTY_DRAFT);
  const [error, setError] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);
  const [installLog, setInstallLog] = useState("");

  const load = useCallback(async () => {
    try {
      const list = await invoke<HarnessInfo[]>("list_harnesses");
      setHarnesses(list);
      setSelected(list.find((item) => item.is_default)?.id ?? "pi");
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = harnesses.find((item) => item.is_default)?.id ?? "pi";
  const chosen = harnesses.find((item) => item.id === selected);

  async function saveDefault() {
    try {
      await invoke("set_default_harness", { id: selected });
      onToast(
        `New chats use ${chosen?.label ?? selected}. Existing chats keep their own agent.`,
      );
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function install(item: HarnessInfo) {
    setInstalling(item.id);
    setInstallLog("");
    try {
      const list = await invoke<HarnessInfo[]>("install_harness", {
        id: item.id,
      });
      setHarnesses(list);
      onToast(`${item.label} installed.`);
    } catch (e) {
      setInstallLog(String(e));
    } finally {
      setInstalling(null);
    }
  }

  async function addCustom() {
    try {
      await invoke("save_custom_harness", {
        harness: {
          id: draft.id.trim(),
          label: draft.label.trim() || draft.id.trim(),
          command: draft.command.trim(),
          args: draft.args.split(/\s+/).filter(Boolean),
          install_hint: "",
        },
      });
      setDraft(EMPTY_DRAFT);
      onToast(`Added ${draft.label.trim() || draft.id.trim()}`);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function removeCustom(id: string) {
    try {
      await invoke("delete_custom_harness", { id });
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="harness-settings">
      <p className="kset-note">
        pi keeps every Kern feature. Other agents connect over ACP and support
        chat, tools, approvals, model switching and resume; session tree, fork
        and manual compaction stay pi-only, and Deep Research always uses pi.
      </p>
      <fieldset className="kset-group kset-radios" aria-label="Agent harness">
        {harnesses.map((item) => (
          <label
            key={item.id}
            className={`kset-row kset-radio${item.available ? "" : " unavailable"}`}
          >
            <input
              type="radio"
              name="harness"
              value={item.id}
              checked={selected === item.id}
              disabled={!item.available}
              onChange={() => setSelected(item.id)}
            />
            <span className="kset-row-text">
              <span className="kset-row-title">
                {item.label}
                {item.is_default && <span className="kset-tag">Default</span>}
              </span>
              <span className="kset-row-desc">
                {item.protocol === "native" ? "native RPC" : "ACP"} ·{" "}
                {item.available ? (
                  <code>{item.resolved_path}</code>
                ) : (
                  <>
                    not installed
                    {!item.installable && (
                      <>
                        {" "}
                        — <code>{item.install_hint || item.command}</code>
                      </>
                    )}
                  </>
                )}
              </span>
            </span>
            {!item.available && item.installable && (
              <button
                type="button"
                className="kset-row-button"
                disabled={installing !== null}
                title={item.install_hint}
                aria-label={`Install ${item.label}`}
                onClick={(event) => {
                  event.preventDefault();
                  void install(item);
                }}
              >
                {installing === item.id ? "Installing…" : "Install"}
              </button>
            )}
            {item.custom && (
              <button
                type="button"
                className="kset-link-button"
                aria-label={`Remove ${item.label}`}
                onClick={(event) => {
                  event.preventDefault();
                  void removeCustom(item.id);
                }}
              >
                Remove
              </button>
            )}
          </label>
        ))}
      </fieldset>
      {installLog && (
        <pre className="kset-log kset-log--standalone" role="alert">
          {installLog}
        </pre>
      )}
      <div className="kset-actions-row">
        <button
          type="button"
          className="primary"
          onClick={() => void saveDefault()}
          disabled={selected === current || !chosen?.available}
        >
          Use for new chats
        </button>
        <span>Existing chats keep the agent they started with.</span>
      </div>

      <h3 className="kset-subhead">Add another ACP agent</h3>
      <div className="kset-group">
        <div className="kset-row">
          <div className="kset-row-text">
            <label htmlFor="harness-id">ID</label>
            <p>Lowercase letters, digits and dashes.</p>
          </div>
          <div className="kset-row-control">
            <input
              id="harness-id"
              value={draft.id}
              onChange={(e) => setDraft({ ...draft, id: e.target.value })}
              placeholder="kimi"
            />
          </div>
        </div>
        <div className="kset-row">
          <div className="kset-row-text">
            <label htmlFor="harness-name">Name</label>
          </div>
          <div className="kset-row-control">
            <input
              id="harness-name"
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              placeholder="Kimi CLI"
            />
          </div>
        </div>
        <div className="kset-row">
          <div className="kset-row-text">
            <label htmlFor="harness-command">Command</label>
            <p>Executable name or absolute path.</p>
          </div>
          <div className="kset-row-control">
            <input
              id="harness-command"
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              placeholder="kimi"
            />
          </div>
        </div>
        <div className="kset-row">
          <div className="kset-row-text">
            <label htmlFor="harness-args">Arguments</label>
            <p>Space separated.</p>
          </div>
          <div className="kset-row-control">
            <input
              id="harness-args"
              value={draft.args}
              onChange={(e) => setDraft({ ...draft, args: e.target.value })}
              placeholder="--acp"
            />
          </div>
        </div>
      </div>
      {error && (
        <div className="kset-inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="kset-actions-row">
        <button
          type="button"
          onClick={() => void addCustom()}
          disabled={!draft.id.trim() || !draft.command.trim()}
        >
          Add agent
        </button>
      </div>
    </div>
  );
}
