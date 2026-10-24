import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Group, ItemRow, Subhead, SwitchField } from "./settings-ui";
import UsageSettings from "./UsageSettings";
import { describeVersion, type AgentUpdate } from "../lib/agent-updates";

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
  const [autoApprove, setAutoApprove] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [updates, setUpdates] = useState<AgentUpdate[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const [updateLog, setUpdateLog] = useState("");

  const load = useCallback(async () => {
    try {
      const [list, approve, update] = await Promise.all([
        invoke<HarnessInfo[]>("list_harnesses"),
        invoke<boolean>("get_auto_approve"),
        invoke<boolean>("get_auto_update"),
      ]);
      setHarnesses(list);
      setAutoApprove(approve === true);
      setAutoUpdate(update === true);
      setSelected(list.find((item) => item.is_default)?.id ?? "pi");
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Separate from `load`: the check hits npm/git and can take seconds.
  const checkUpdates = useCallback(async (refresh: boolean) => {
    setChecking(true);
    try {
      const list = await invoke<AgentUpdate[]>("check_agent_updates", {
        refresh,
      });
      setUpdates(Array.isArray(list) ? list : []);
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void checkUpdates(false);
  }, [load, checkUpdates]);

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

  async function toggleAutoApprove(enabled: boolean) {
    try {
      await invoke("set_auto_approve", { enabled });
      setAutoApprove(enabled);
      onToast(
        enabled
          ? "Agents now run tools without asking."
          : "Agents ask before running tools.",
      );
    } catch (e) {
      setError(String(e));
    }
  }

  async function toggleAutoUpdate(enabled: boolean) {
    try {
      await invoke("set_auto_update", { enabled });
      setAutoUpdate(enabled);
    } catch (e) {
      setError(String(e));
    }
  }

  async function applyUpdate(item: AgentUpdate) {
    setUpdating(item.id);
    setUpdateLog("");
    try {
      const list = await invoke<AgentUpdate[]>("apply_agent_update", {
        id: item.id,
      });
      setUpdates(list);
      onToast(`Updated ${item.label}`);
      await load();
    } catch (e) {
      setUpdateLog(String(e));
    } finally {
      setUpdating(null);
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
        chat, tools, approvals, model switching, resume and compaction (when the
        agent offers /compact); session tree and fork stay pi-only, and Deep
        Research always uses pi.
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

      <Group label="Approvals">
        <SwitchField
          label="Auto-approve tool calls"
          detail="ACP agents run commands and edits without asking. Applies to every chat, including ones already open."
          checked={autoApprove}
          onChange={(enabled) => void toggleAutoApprove(enabled)}
        />
      </Group>

      <Subhead
        actions={
          <button
            type="button"
            disabled={checking || updating !== null}
            onClick={() => void checkUpdates(true)}
          >
            {checking ? "Checking…" : "Check now"}
          </button>
        }
      >
        Updates
      </Subhead>
      <Group label="Agent updates">
        <SwitchField
          label="Auto-install updates"
          detail="When Kern starts, install agent updates it finds instead of only notifying."
          checked={autoUpdate}
          onChange={(enabled) => void toggleAutoUpdate(enabled)}
        />
        {updates === null ? (
          <ItemRow title="Checking installed agents…" />
        ) : (
          updates.map((item) => (
            <ItemRow
              key={item.id}
              title={item.label}
              detail={[
                describeVersion(item),
                item.notice,
                item.detail,
                item.available ? null : "up to date",
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              {item.available && (
                <button
                  type="button"
                  className="kset-row-button"
                  disabled={updating !== null}
                  aria-label={`Update ${item.label}`}
                  onClick={() => void applyUpdate(item)}
                >
                  {updating === item.id ? "Updating…" : "Update"}
                </button>
              )}
            </ItemRow>
          ))
        )}
      </Group>
      {updateLog && (
        <pre className="kset-log kset-log--standalone" role="alert">
          {updateLog}
        </pre>
      )}

      <UsageSettings onToast={onToast} />

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
