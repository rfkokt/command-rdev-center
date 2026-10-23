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
    <main className="graphify-settings harness-settings">
      <div className="settings-notice">
        <span>
          Pick the coding agent new chats run. pi keeps every Kern feature;
          other agents connect over ACP and support chat, tools, approvals,
          model switching and resume. Session tree, fork and manual compaction
          remain pi-only, and Deep Research always uses pi.
        </span>
      </div>
      <fieldset className="harness-list" aria-label="Agent harness">
        {harnesses.map((item) => (
          <label key={item.id} className="harness-option">
            <input
              type="radio"
              name="harness"
              value={item.id}
              checked={selected === item.id}
              disabled={!item.available}
              onChange={() => setSelected(item.id)}
            />
            <span>
              {item.label}
              <small>
                {item.protocol === "native" ? "native RPC" : "ACP"} ·{" "}
                {item.available ? (
                  <code>{item.resolved_path}</code>
                ) : (
                  <>
                    not installed —{" "}
                    <code>{item.install_hint || item.command}</code>
                  </>
                )}
              </small>
            </span>
            {item.custom && (
              <button
                type="button"
                className="harness-remove"
                aria-label={`Remove ${item.label}`}
                onClick={() => void removeCustom(item.id)}
              >
                Remove
              </button>
            )}
          </label>
        ))}
      </fieldset>
      <button
        className="save-settings"
        onClick={() => void saveDefault()}
        disabled={selected === current || !chosen?.available}
      >
        USE FOR NEW CHATS
      </button>

      <div className="settings-notice">
        <span>
          Any other ACP agent works too: add its command (for example{" "}
          <code>kimi --acp</code>).
        </span>
      </div>
      <label>
        ID<small>lowercase, digits, dashes</small>
        <input
          value={draft.id}
          onChange={(e) => setDraft({ ...draft, id: e.target.value })}
          placeholder="kimi"
        />
      </label>
      <label>
        NAME
        <input
          value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          placeholder="Kimi CLI"
        />
      </label>
      <label>
        COMMAND<small>executable name or absolute path</small>
        <input
          value={draft.command}
          onChange={(e) => setDraft({ ...draft, command: e.target.value })}
          placeholder="kimi"
        />
      </label>
      <label>
        ARGUMENTS<small>space separated</small>
        <input
          value={draft.args}
          onChange={(e) => setDraft({ ...draft, args: e.target.value })}
          placeholder="--acp"
        />
      </label>
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
      <button
        className="save-settings"
        onClick={() => void addCustom()}
        disabled={!draft.id.trim() || !draft.command.trim()}
      >
        ADD AGENT
      </button>
    </main>
  );
}
