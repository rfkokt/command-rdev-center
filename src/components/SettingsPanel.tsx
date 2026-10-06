import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import GraphifySettings from "./GraphifySettings";
import JevSettings from "./JevSettings";
import McpSettings from "./McpSettings";
import PipelineSettings from "./PipelineSettings";
import RagSettings from "./RagSettings";
import { useModalFocus } from "./useModalFocus";
import CustomSelect from "./CustomSelect";

type PiRuntimeStatus = {
  health: "healthy" | "partial" | "missing";
  path?: string;
  installed_version?: string;
  latest_version?: string;
};

const GROUPS = [
  [
    "Model & Thinking",
    "Default AI provider, models & reasoning effort",
    [
      "defaultProvider",
      "defaultModel",
      "defaultThinkingLevel",
      "thinkingBudgets",
    ],
  ],
  [
    "UI & Display",
    "Theme, appearance, editor & layout preferences",
    ["theme", "externalEditor", "quietStartup", "padding"],
  ],
  [
    "Compaction",
    "Context window trimming & token preservation",
    ["compaction", "branchSummary"],
  ],
  [
    "Retry & Recovery",
    "Exponential backoff, retries & timeouts",
    ["retry", "maxRetries", "baseDelayMs"],
  ],
  [
    "Delivery & Network",
    "Stream steering, follow-up & HTTP proxies",
    ["steeringMode", "followUpMode", "transport", "httpProxy"],
  ],
  [
    "Terminal & Images",
    "Inline rendering, widths & image pipelines",
    ["terminal", "image"],
  ],
  [
    "Shell & Sessions",
    "Shell paths, npm prefixes & session storage",
    ["shellPath", "shellCommandPrefix", "npmCommand", "sessionDir"],
  ],
  [
    "Models & Markdown",
    "Enabled models & markdown formatting",
    ["enabledModels", "markdown"],
  ],
  [
    "Resources",
    "Extensions, skills, prompts & custom themes",
    ["packages", "extensions", "skills", "prompts", "themes"],
  ],
] as const;

export default function SettingsPanel({
  projectPath,
  projectName,
  initialPage = "pi",
  onClose,
  onToast,
}: {
  projectPath?: string;
  projectName?: string;
  initialPage?: "pi" | "pipeline";
  onClose: () => void;
  onToast: (message: string) => void;
}) {
  const [page, setPage] = useState<
    "pi" | "graphify" | "jev" | "mcp" | "rag" | "pipeline"
  >(initialPage);
  const [scope, setScope] = useState<"global" | "project">("global");
  const [text, setText] = useState("{}");
  const [saved, setSaved] = useState("{}");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [activeGroup, setActiveGroup] = useState("");
  const [mode, setMode] = useState<"form" | "json">("form");
  const [backlogDir, setBacklogDir] = useState("");
  const [runtime, setRuntime] = useState<PiRuntimeStatus | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeLog, setRuntimeLog] = useState("");

  const editorRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useModalFocus<HTMLElement>(onClose);

  useEffect(() => {
    void invoke<string>("get_backlog_dir")
      .then(setBacklogDir)
      .catch((e) => setError(String(e)));
    void invoke<PiRuntimeStatus>("get_pi_runtime_status")
      .then(setRuntime)
      .catch((e) => setRuntimeLog(String(e)));
  }, []);

  useEffect(() => {
    setLoading(true);
    setError("");
    invoke<Record<string, unknown>>("get_pi_settings", {
      scope,
      projectPath: scope === "project" ? projectPath : null,
    })
      .then((settings) => {
        const json = JSON.stringify(settings, null, 2);
        setText(json);
        setSaved(json);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [scope, projectPath]);

  function settingsObject() {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  function updateSetting(key: string, value: unknown) {
    const settings = settingsObject();
    if (value === "") delete settings[key];
    else settings[key] = value;
    setText(JSON.stringify(settings, null, 2));
    setError("");
  }

  function jumpToGroup(name: string, keys: readonly string[]) {
    setActiveGroup(name);
    if (mode === "form") {
      document
        .getElementById(`setting-${keys[0]}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const editor = editorRef.current;
    const index = keys
      .map((key) => text.indexOf(`"${key}"`))
      .find((position) => position >= 0);
    if (!editor || index === undefined)
      return onToast(`${name}: no configured values in this scope.`);
    editor.focus();
    editor.setSelectionRange(index, index + text.slice(index).indexOf(":") + 1);
    editor.scrollTop = (editor.scrollHeight * index) / text.length;
  }

  async function chooseSessionDir() {
    const path = await open({
      directory: true,
      multiple: false,
      title: "Choose Pi Session Storage",
    });
    if (!path) return;
    try {
      const settings = JSON.parse(text) as Record<string, unknown>;
      setText(JSON.stringify({ ...settings, sessionDir: path }, null, 2));
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }

  async function chooseBacklogDir() {
    const path = await open({
      directory: true,
      multiple: false,
      title: "Choose Backlog & Error Report Storage",
    });
    if (!path) return;
    try {
      setBacklogDir(await invoke<string>("save_backlog_dir", { path }));
      onToast("Backlog storage saved.");
    } catch (e) {
      setError(String(e));
    }
  }

  async function updateRuntime() {
    setRuntimeBusy(true);
    setRuntimeLog("Installing the latest Pi runtime…");
    try {
      const next = await invoke<PiRuntimeStatus>("update_pi_runtime");
      setRuntime(next);
      setRuntimeLog(
        `Pi ${next.installed_version || ""} is healthy. Reload active chats.`,
      );
      onToast("Pi updated — reload active chats.");
    } catch (e) {
      setRuntimeLog(String(e));
    } finally {
      setRuntimeBusy(false);
    }
  }

  async function syncExtensions() {
    setRuntimeBusy(true);
    setRuntimeLog("Syncing Kern Studio extensions…");
    try {
      const path = await invoke<string>("sync_pi_extensions");
      setRuntimeLog(`Extensions synced to ${path}. Reload active chats.`);
      onToast("Pi extensions synced — reload active chats.");
    } catch (e) {
      setRuntimeLog(String(e));
    } finally {
      setRuntimeBusy(false);
    }
  }

  async function save() {
    try {
      const settings = JSON.parse(text) as unknown;
      if (!settings || Array.isArray(settings) || typeof settings !== "object")
        throw new Error("Root must be a JSON object");
      await invoke("save_pi_settings", {
        scope,
        projectPath: scope === "project" ? projectPath : null,
        settings,
      });
      window.dispatchEvent(
        new CustomEvent("pi-settings-saved", { detail: settings }),
      );
      const formatted = JSON.stringify(settings, null, 2);
      setText(formatted);
      setSaved(formatted);
      setError("");
      onToast("Pi settings saved — restart sessions for non-live settings.");
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="settings-backdrop">
      <section
        ref={panelRef}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
      >
        <header>
          <div className="settings-header-left">
            <span className="settings-header-badge">Configuration</span>
            <div className="settings-title-wrap">
              <strong id="settings-title">
                {page === "pi"
                  ? "Pi Settings"
                  : page === "graphify"
                    ? "Graphify Settings"
                    : page === "jev"
                      ? "Jev Settings"
                      : page === "mcp"
                        ? "MCP Settings"
                        : page === "rag"
                          ? "RAG Settings"
                          : "Pipeline Settings"}
              </strong>
              <span className="settings-page-tag">{page.toUpperCase()}</span>
            </div>
          </div>
          <button
            type="button"
            className="settings-close-button"
            onClick={onClose}
            aria-label="Close settings"
          >
            <span className="esc-key">ESC</span>
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M1 1l12 12M13 1L1 13" />
            </svg>
          </button>
        </header>

        <div className="settings-scope">
          <div className="settings-scope-nav" role="tablist">
            <button
              type="button"
              className={`settings-scope-tab ${page === "pi" ? "active" : ""}`}
              onClick={() => setPage("pi")}
            >
              Pi
            </button>
            <button
              type="button"
              className={`settings-scope-tab ${page === "graphify" ? "active" : ""}`}
              onClick={() => setPage("graphify")}
            >
              Graphify
            </button>
            <button
              type="button"
              className={`settings-scope-tab ${page === "jev" ? "active" : ""}`}
              onClick={() => setPage("jev")}
            >
              Jev
            </button>
            <button
              type="button"
              className={`settings-scope-tab ${page === "mcp" ? "active" : ""}`}
              onClick={() => setPage("mcp")}
            >
              MCP
            </button>
            <button
              type="button"
              className={`settings-scope-tab ${page === "rag" ? "active" : ""}`}
              onClick={() => setPage("rag")}
            >
              RAG
            </button>
            <button
              type="button"
              className={`settings-scope-tab ${page === "pipeline" ? "active" : ""}`}
              disabled={!projectPath}
              onClick={() => setPage("pipeline")}
            >
              Pipeline
            </button>
          </div>
          {page === "pi" && (
            <div className="settings-scope-right">
              <div
                className="settings-scope-switch"
                role="group"
                aria-label="Settings scope"
              >
                <button
                  type="button"
                  className={scope === "global" ? "active" : ""}
                  onClick={() => setScope("global")}
                >
                  Global
                </button>
                <button
                  type="button"
                  className={scope === "project" ? "active" : ""}
                  disabled={!projectPath}
                  onClick={() => setScope("project")}
                >
                  Project
                </button>
              </div>
              <span
                className="settings-scope-path"
                title={
                  scope === "global"
                    ? "~/.pi/agent/settings.json"
                    : `${projectPath}/.pi/settings.json`
                }
              >
                {scope === "global"
                  ? "~/.pi/agent/settings.json"
                  : `${projectPath}/.pi/settings.json`}
              </span>
            </div>
          )}
        </div>

        {page === "graphify" ? (
          <GraphifySettings onToast={onToast} />
        ) : page === "jev" ? (
          <JevSettings onToast={onToast} />
        ) : page === "mcp" ? (
          <McpSettings onToast={onToast} />
        ) : page === "rag" ? (
          <RagSettings onToast={onToast} />
        ) : page === "pipeline" && projectPath ? (
          <PipelineSettings
            projectPath={projectPath}
            projectName={projectName}
            onToast={onToast}
          />
        ) : page === "pipeline" ? (
          <div className="pipeline-project-empty">
            <strong>SELECT A PROJECT</strong>
            <span>
              Choose the pipeline shortcut beside a project, then configure its
              steps here.
            </span>
          </div>
        ) : (
          <>
            <div className="settings-content">
              <nav className="settings-groups-nav">
                {GROUPS.map(([name, detail, keys]) => (
                  <button
                    type="button"
                    className={`settings-group-btn ${activeGroup === name ? "active" : ""}`}
                    key={name}
                    onClick={() => jumpToGroup(name, keys)}
                  >
                    <div className="settings-group-info">
                      <strong>{name}</strong>
                      <small>{detail}</small>
                    </div>
                  </button>
                ))}
              </nav>
              <main className="settings-main">
                <div className="settings-main-top">
                  <div className="settings-mode" role="tablist">
                    <button
                      type="button"
                      className={mode === "form" ? "active" : ""}
                      onClick={() => setMode("form")}
                    >
                      Form View
                    </button>
                    <button
                      type="button"
                      className={mode === "json" ? "active" : ""}
                      onClick={() => setMode("json")}
                    >
                      JSON · Advanced
                    </button>
                  </div>
                  <div className="settings-notice">
                    <span>
                      Project values override global values. Unknown/custom keys
                      are preserved. Most settings apply to newly started
                      sessions.
                    </span>
                  </div>
                </div>

                {scope === "global" && (
                  <section className="pi-runtime-card">
                    <div className="pi-runtime-info">
                      <div className="pi-runtime-header">
                        <small>PI RUNTIME</small>
                        <span
                          className={`pi-runtime-badge ${
                            runtime?.health === "healthy"
                              ? "healthy"
                              : runtime?.health === "partial"
                                ? "partial"
                                : "missing"
                          }`}
                        >
                          <span className="pulse-dot" />
                          {runtime?.health?.toUpperCase() || "CHECKING…"}
                        </span>
                      </div>
                      <div className="pi-runtime-meta">
                        <span className="pi-version-tag">
                          {runtime?.installed_version || "Not installed"}
                        </span>
                        {runtime?.latest_version && (
                          <span className="pi-latest-tag">
                            Latest {runtime.latest_version}
                          </span>
                        )}
                        <code className="pi-binary-path">
                          {runtime?.path || "Pi binary not found"}
                        </code>
                      </div>
                    </div>
                    <div className="pi-runtime-actions">
                      <button
                        type="button"
                        className="toolbar-button"
                        disabled={runtimeBusy}
                        onClick={() =>
                          void invoke<PiRuntimeStatus>("get_pi_runtime_status")
                            .then(setRuntime)
                            .catch((e) => setRuntimeLog(String(e)))
                        }
                      >
                        Check
                      </button>
                      <button
                        type="button"
                        className="toolbar-button toolbar-button-primary"
                        disabled={runtimeBusy}
                        onClick={updateRuntime}
                      >
                        {runtime?.health === "healthy"
                          ? "Update / Repair Pi"
                          : "Install / Repair Pi"}
                      </button>
                      <button
                        type="button"
                        className="toolbar-button"
                        disabled={runtimeBusy}
                        onClick={syncExtensions}
                      >
                        Sync Extensions
                      </button>
                    </div>
                    {runtimeLog && <pre className="pi-runtime-log">{runtimeLog}</pre>}
                  </section>
                )}

                {loading ? (
                  <div className="settings-loading">
                    <span className="pulse-dot" /> Loading settings…
                  </div>
                ) : mode === "json" ? (
                  <textarea
                    ref={editorRef}
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    spellCheck={false}
                    aria-label="Pi settings JSON"
                  />
                ) : (
                  <div className="settings-form">
                    {(() => {
                      const settings = settingsObject();
                      return (
                        <>
                          <label id="setting-defaultProvider">
                            <span className="field-label-group">
                              <span className="field-title">DEFAULT PROVIDER</span>
                              <small className="field-desc">
                                Provider used for new sessions
                              </small>
                            </span>
                            <input
                              value={String(settings.defaultProvider ?? "")}
                              onChange={(e) =>
                                updateSetting("defaultProvider", e.target.value)
                              }
                              placeholder="e.g. anthropic"
                            />
                          </label>

                          <label id="setting-defaultModel">
                            <span className="field-label-group">
                              <span className="field-title">DEFAULT MODEL</span>
                              <small className="field-desc">
                                Model ID used for new sessions
                              </small>
                            </span>
                            <input
                              value={String(settings.defaultModel ?? "")}
                              onChange={(e) =>
                                updateSetting("defaultModel", e.target.value)
                              }
                              placeholder="provider model ID"
                            />
                          </label>

                          <label id="setting-defaultThinkingLevel">
                            <span className="field-label-group">
                              <span className="field-title">THINKING LEVEL</span>
                              <small className="field-desc">
                                Default reasoning effort
                              </small>
                            </span>
                            <CustomSelect
                              value={String(
                                settings.defaultThinkingLevel ?? "",
                              )}
                              onChange={(val) =>
                                updateSetting("defaultThinkingLevel", val)
                              }
                              ariaLabel="Default reasoning effort"
                              placement="bottom"
                              options={[
                                {
                                  value: "",
                                  label: "Pi default",
                                  description: "Use Pi runtime default setting",
                                },
                                {
                                  value: "off",
                                  label: "off",
                                  description: "Direct response without reasoning",
                                },
                                {
                                  value: "minimal",
                                  label: "minimal",
                                  description: "Quick shallow checks",
                                },
                                {
                                  value: "low",
                                  label: "low",
                                  description: "Light reasoning",
                                },
                                {
                                  value: "medium",
                                  label: "medium",
                                  description: "Balanced reasoning effort",
                                },
                                {
                                  value: "high",
                                  label: "high",
                                  description: "Deep analysis and planning",
                                },
                                {
                                  value: "xhigh",
                                  label: "xhigh",
                                  description: "Maximum reasoning effort",
                                },
                                {
                                  value: "max",
                                  label: "max",
                                  description: "Exhaustive reasoning effort",
                                },
                              ]}
                            />
                          </label>

                          {[
                            [
                              "hideThinkingBlock",
                              "HIDE THINKING",
                              "Hide reasoning blocks in chat output",
                            ],
                            [
                              "showCacheMissNotices",
                              "CACHE MISS NOTICES",
                              "Show indicator for prompt cache misses",
                            ],
                            [
                              "quietStartup",
                              "QUIET STARTUP",
                              "Suppress non-critical engine startup banner",
                            ],
                            [
                              "telemetry",
                              "TELEMETRY",
                              "Allow anonymous diagnostics and telemetry",
                            ],
                            [
                              "enableSkillCommands",
                              "SKILL COMMANDS",
                              "Expose installed skills directly as chat slash commands",
                            ],
                          ].map(([key, title, detail]) => (
                            <label
                              className="settings-toggle"
                              id={`setting-${key}`}
                              key={key}
                            >
                              <span className="field-label-group">
                                <span className="field-title">{title}</span>
                                <small className="field-desc">{detail}</small>
                              </span>
                              <div className="opendots-switch">
                                <input
                                  type="checkbox"
                                  checked={settings[key] === true}
                                  onChange={(e) =>
                                    updateSetting(key, e.target.checked)
                                  }
                                />
                                <span className="opendots-slider" />
                              </div>
                            </label>
                          ))}

                          <label id="setting-theme">
                            <span className="field-label-group">
                              <span className="field-title">THEME</span>
                              <small className="field-desc">
                                Installed Pi theme name
                              </small>
                            </span>
                            <input
                              value={String(settings.theme ?? "")}
                              onChange={(e) =>
                                updateSetting("theme", e.target.value)
                              }
                              placeholder="Pi default"
                            />
                          </label>

                          <label id="setting-externalEditor">
                            <span className="field-label-group">
                              <span className="field-title">EXTERNAL EDITOR</span>
                              <small className="field-desc">
                                Command to launch external text editor
                              </small>
                            </span>
                            <input
                              value={String(settings.externalEditor ?? "")}
                              onChange={(e) =>
                                updateSetting("externalEditor", e.target.value)
                              }
                              placeholder="e.g. code --wait"
                            />
                          </label>

                          <label id="setting-shellPath">
                            <span className="field-label-group">
                              <span className="field-title">SHELL PATH</span>
                              <small className="field-desc">
                                Default shell executable path
                              </small>
                            </span>
                            <input
                              value={String(settings.shellPath ?? "")}
                              onChange={(e) =>
                                updateSetting("shellPath", e.target.value)
                              }
                              placeholder="System default"
                            />
                          </label>

                          {scope === "global" && (
                            <>
                              <div
                                className="session-storage-setting"
                                id="setting-sessionDir"
                              >
                                <div className="storage-info">
                                  <div className="field-label-group">
                                    <span className="field-title">
                                      SESSION STORAGE
                                    </span>
                                    <span className="storage-path">
                                      {String(
                                        settings.sessionDir ||
                                          "~/.pi/agent/sessions",
                                      )}
                                    </span>
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  className="toolbar-button"
                                  onClick={chooseSessionDir}
                                >
                                  Choose Folder
                                </button>
                              </div>
                              <div className="session-storage-setting">
                                <div className="storage-info">
                                  <div className="field-label-group">
                                    <span className="field-title">
                                      BACKLOG & ERROR REPORTS
                                    </span>
                                    <span className="storage-path">
                                      {backlogDir || "Loading…"}
                                    </span>
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  className="toolbar-button"
                                  onClick={chooseBacklogDir}
                                >
                                  Choose Folder
                                </button>
                              </div>
                            </>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
                {error && <div className="settings-error">{error}</div>}
              </main>
            </div>
            <footer className="settings-footer">
              <div className="settings-footer-status">
                <span
                  className={`status-indicator-dot ${
                    text === saved ? "clean" : "dirty"
                  }`}
                />
                <span>
                  {text === saved
                    ? "All settings saved"
                    : "Unsaved changes pending"}
                </span>
              </div>
              <div className="settings-footer-actions">
                <button
                  type="button"
                  className="toolbar-button"
                  onClick={() => setText(saved)}
                  disabled={text === saved}
                >
                  Reset
                </button>
                <button
                  type="button"
                  className="toolbar-button toolbar-button-primary save-settings"
                  onClick={save}
                  disabled={loading || text === saved}
                >
                  Save Settings
                </button>
              </div>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
