import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useModalFocus } from "./useModalFocus";
import CustomSelect from "./CustomSelect";

// Each section loads its own code (and its own backend calls) only when it is
// opened, so opening Settings does not mount eight panels' worth of work.
const ConnectionsSettings = lazy(() => import("./ConnectionsSettings"));
const GraphifySettings = lazy(() => import("./GraphifySettings"));
const PrReviewSettings = lazy(() => import("./PrReviewSettings"));
const HarnessSettings = lazy(() => import("./HarnessSettings"));
const JevSettings = lazy(() => import("./JevSettings"));
const McpSettings = lazy(() => import("./McpSettings"));
const PipelineSettings = lazy(() => import("./PipelineSettings"));
const RagSettings = lazy(() => import("./RagSettings"));

type PiRuntimeStatus = {
  health: "healthy" | "partial" | "missing";
  path?: string;
  installed_version?: string;
  latest_version?: string;
};

type Section =
  | "pi-model"
  | "pi-general"
  | "pi-runtime"
  | "pi-json"
  | "agent"
  | "connections"
  | "mcp"
  | "rag"
  | "graphify"
  | "jev"
  | "pipeline";

const SECTIONS: Record<Section, { title: string; detail: string }> = {
  "pi-model": {
    title: "Model and thinking",
    detail: "Default provider, model and reasoning effort for new sessions.",
  },
  "pi-general": {
    title: "General",
    detail: "Theme, editor, shell and chat behaviour.",
  },
  "pi-runtime": {
    title: "Runtime and storage",
    detail: "The pi binary Kern runs, and where sessions and reports are kept.",
  },
  "pi-json": {
    title: "Edit as JSON",
    detail: "Every pi setting, including ones without a form field.",
  },
  agent: {
    title: "Agent harness",
    detail:
      "Which coding agent new chats run: pi, Claude Code, OpenCode, Hermes and more.",
  },
  connections: {
    title: "Model connections",
    detail: "API keys and endpoints shared by every agent harness.",
  },
  mcp: { title: "MCP servers", detail: "Tools exposed to agents over MCP." },
  rag: { title: "RAG", detail: "Knowledge retrieval for chats." },
  graphify: {
    title: "Graphify",
    detail: "Code graph indexing for projects.",
  },
  jev: { title: "Jev", detail: "Jev integration settings." },
  pipeline: {
    title: "Pipeline",
    detail: "Steps that run for the selected project.",
  },
};

const NAV: Array<{ label: string; items: Section[] }> = [
  { label: "Pi", items: ["pi-model", "pi-general", "pi-runtime", "pi-json"] },
  { label: "Agents", items: ["agent", "connections"] },
  { label: "Integrations", items: ["mcp", "rag", "graphify", "jev"] },
  { label: "Project", items: ["pipeline"] },
];

const NAV_LABEL: Partial<Record<Section, string>> = {
  "pi-model": "Model and thinking",
  "pi-runtime": "Runtime and storage",
  agent: "Agent harness",
  connections: "Connections",
};

/** Pi keys that only the JSON editor covers, grouped for quick jumps. */
const JSON_ONLY: Array<[string, readonly string[]]> = [
  ["Compaction", ["compaction", "branchSummary"]],
  ["Retry", ["retry", "maxRetries", "baseDelayMs"]],
  ["Delivery", ["steeringMode", "followUpMode", "transport", "httpProxy"]],
  ["Terminal and images", ["terminal", "image"]],
  ["Shell", ["shellCommandPrefix", "npmCommand"]],
  ["Models", ["enabledModels", "markdown", "thinkingBudgets"]],
  ["Resources", ["packages", "extensions", "skills", "prompts", "themes"]],
];

const THINKING_OPTIONS = [
  { value: "", label: "Pi default", description: "Use the runtime default" },
  { value: "off", label: "off", description: "Answer without reasoning" },
  { value: "minimal", label: "minimal", description: "Quick shallow checks" },
  { value: "low", label: "low", description: "Light reasoning" },
  { value: "medium", label: "medium", description: "Balanced effort" },
  { value: "high", label: "high", description: "Deep analysis and planning" },
  { value: "xhigh", label: "xhigh", description: "Maximum effort" },
  { value: "max", label: "max", description: "Exhaustive reasoning" },
];

const TOGGLES: Array<[string, string, string]> = [
  [
    "kernTaskVerification",
    "Task verification",
    "Require task contracts, recorded checks and reports in new pi sessions. Default: explicit verification requests or Pipeline only. Per chat: /kern-verification on|off|auto.",
  ],
  [
    "enableSkillCommands",
    "Skill commands",
    "Expose installed skills as slash commands in chat.",
  ],
  ["quietStartup", "Quiet startup", "Hide the non-critical startup banner."],
  [
    "showCacheMissNotices",
    "Cache miss notices",
    "Show a marker when the prompt cache misses.",
  ],
  ["telemetry", "Telemetry", "Send anonymous diagnostics."],
];

// Survives closing the dialog, so reopening shows the last known status
// immediately and refreshes it in the background.
let runtimeCache: PiRuntimeStatus | null = null;

function Row({
  id,
  title,
  detail,
  children,
}: {
  id: string;
  title: string;
  detail?: string;
  children: ReactNode;
}) {
  return (
    <div className="kset-row" id={`setting-${id}`}>
      <div className="kset-row-text">
        <label htmlFor={`field-${id}`}>{title}</label>
        {detail && <p>{detail}</p>}
      </div>
      <div className="kset-row-control">{children}</div>
    </div>
  );
}

function Switch({
  id,
  checked,
  onChange,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <span className="kset-switch">
      <input
        id={`field-${id}`}
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span aria-hidden="true" />
    </span>
  );
}

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
  const [section, setSection] = useState<Section>(
    initialPage === "pipeline" ? "pipeline" : "pi-model",
  );
  const [scope, setScope] = useState<"global" | "project">("global");
  const [text, setText] = useState("{}");
  const [saved, setSaved] = useState("{}");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [backlogDir, setBacklogDir] = useState("");
  const [notificationSound, setNotificationSound] = useState(() => {
    try {
      return localStorage.getItem("kern:notification-sound") !== "false";
    } catch {
      return true;
    }
  });
  const [runtime, setRuntime] = useState<PiRuntimeStatus | null>(runtimeCache);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeLog, setRuntimeLog] = useState("");

  const editorRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useModalFocus<HTMLElement>(onClose);

  const isPiForm =
    section === "pi-model" || section === "pi-general" || section === "pi-json";
  const dirty = text !== saved;

  async function refreshRuntime(refresh = false) {
    try {
      const next = await invoke<PiRuntimeStatus>("get_pi_runtime_status", {
        refresh,
      });
      runtimeCache = next;
      setRuntime(next);
    } catch (e) {
      setRuntimeLog(String(e));
    }
  }

  useEffect(() => {
    void refreshRuntime();
    void invoke<string>("get_backlog_dir")
      .then(setBacklogDir)
      .catch((e) => setError(String(e)));
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

  const settings = useMemo(() => {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  }, [text]);

  function updateSetting(key: string, value: unknown) {
    const next = { ...(settings ?? {}) };
    if (value === "") delete next[key];
    else next[key] = value;
    setText(JSON.stringify(next, null, 2));
    setError("");
  }

  function jumpToKeys(name: string, keys: readonly string[]) {
    const editor = editorRef.current;
    const index = keys
      .map((key) => text.indexOf(`"${key}"`))
      .find((position) => position >= 0);
    if (!editor || index === undefined)
      return onToast(`${name}: nothing set in this scope yet.`);
    editor.focus();
    editor.setSelectionRange(index, index + text.slice(index).indexOf(":") + 1);
    editor.scrollTop = (editor.scrollHeight * index) / text.length;
  }

  async function chooseSessionDir() {
    const path = await open({
      directory: true,
      multiple: false,
      title: "Choose pi session storage",
    });
    if (!path) return;
    updateSetting("sessionDir", path);
  }

  async function chooseBacklogDir() {
    const path = await open({
      directory: true,
      multiple: false,
      title: "Choose backlog and error report storage",
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
    setRuntimeLog("Installing or repairing pi…");
    try {
      const next = await invoke<PiRuntimeStatus>("update_pi_runtime");
      runtimeCache = next;
      setRuntime(next);
      setRuntimeLog("");
      onToast(`pi ${next.installed_version ?? ""} is ready.`);
    } catch (e) {
      setRuntimeLog(String(e));
    } finally {
      setRuntimeBusy(false);
    }
  }

  async function syncExtensions() {
    setRuntimeBusy(true);
    try {
      const path = await invoke<string>("sync_pi_extensions");
      onToast(`Extensions synced to ${path}`);
    } catch (e) {
      setRuntimeLog(String(e));
    } finally {
      setRuntimeBusy(false);
    }
  }

  async function save() {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
        throw new Error("Root must be a JSON object");
      await invoke("save_pi_settings", {
        scope,
        projectPath: scope === "project" ? projectPath : null,
        settings: parsed,
      });
      window.dispatchEvent(
        new CustomEvent("pi-settings-saved", { detail: parsed }),
      );
      const formatted = JSON.stringify(parsed, null, 2);
      setText(formatted);
      setSaved(formatted);
      setError("");
      onToast("Pi settings saved. Restart sessions for non-live settings.");
    } catch (e) {
      setError(String(e));
    }
  }

  const value = (key: string) => String(settings?.[key] ?? "");
  const scopePath =
    scope === "global"
      ? "~/.pi/agent/settings.json"
      : `${projectPath}/.pi/settings.json`;

  function renderPiForm() {
    if (loading) return <div className="kset-loading">Loading settings…</div>;
    if (section === "pi-json")
      return (
        <>
          <div className="kset-chips" aria-label="Jump to">
            {JSON_ONLY.map(([name, keys]) => (
              <button
                type="button"
                key={name}
                onClick={() => jumpToKeys(name, keys)}
              >
                {name}
              </button>
            ))}
          </div>
          <textarea
            ref={editorRef}
            className="kset-json"
            value={text}
            onChange={(event) => setText(event.target.value)}
            spellCheck={false}
            aria-label="Pi settings JSON"
          />
          {settings === null && (
            <p className="kset-inline-error">
              Not valid JSON yet. The form sections show the last valid state.
            </p>
          )}
        </>
      );
    if (!settings)
      return (
        <p className="kset-inline-error">
          The JSON has a syntax error. Fix it in Edit as JSON first.
        </p>
      );
    if (section === "pi-model")
      return (
        <div className="kset-group">
          <Row
            id="defaultProvider"
            title="Provider"
            detail="Provider for new sessions."
          >
            <input
              id="field-defaultProvider"
              value={value("defaultProvider")}
              onChange={(e) => updateSetting("defaultProvider", e.target.value)}
              placeholder="anthropic"
            />
          </Row>
          <Row
            id="defaultModel"
            title="Model"
            detail="Model ID for new sessions."
          >
            <input
              id="field-defaultModel"
              value={value("defaultModel")}
              onChange={(e) => updateSetting("defaultModel", e.target.value)}
              placeholder="claude-opus-5-5"
            />
          </Row>
          <Row
            id="defaultThinkingLevel"
            title="Thinking level"
            detail="Default reasoning effort."
          >
            <CustomSelect
              value={value("defaultThinkingLevel")}
              onChange={(next) => updateSetting("defaultThinkingLevel", next)}
              ariaLabel="Default reasoning effort"
              placement="bottom"
              options={THINKING_OPTIONS}
            />
          </Row>
          <Row
            id="hideThinkingBlock"
            title="Hide thinking"
            detail="Collapse reasoning blocks in chat."
          >
            <Switch
              id="hideThinkingBlock"
              checked={settings.hideThinkingBlock === true}
              onChange={(next) => updateSetting("hideThinkingBlock", next)}
            />
          </Row>
        </div>
      );
    return (
      <>
        <div className="kset-group">
          <Row id="theme" title="Theme" detail="Installed pi theme name.">
            <input
              id="field-theme"
              value={value("theme")}
              onChange={(e) => updateSetting("theme", e.target.value)}
              placeholder="Pi default"
            />
          </Row>
          <Row
            id="externalEditor"
            title="External editor"
            detail="Command that opens files for editing."
          >
            <input
              id="field-externalEditor"
              value={value("externalEditor")}
              onChange={(e) => updateSetting("externalEditor", e.target.value)}
              placeholder="code --wait"
            />
          </Row>
          <Row
            id="shellPath"
            title="Shell"
            detail="Shell executable for tools."
          >
            <input
              id="field-shellPath"
              value={value("shellPath")}
              onChange={(e) => updateSetting("shellPath", e.target.value)}
              placeholder="System default"
            />
          </Row>
        </div>
        <div className="kset-group">
          {TOGGLES.map(([key, title, detail]) => (
            <Row id={key} key={key} title={title} detail={detail}>
              <Switch
                id={key}
                checked={settings[key] === true}
                onChange={(next) => updateSetting(key, next)}
              />
            </Row>
          ))}
        </div>
      </>
    );
  }

  function renderRuntime() {
    const health = runtime?.health ?? "checking";
    const outdated =
      runtime?.installed_version &&
      runtime.latest_version &&
      !runtime.installed_version.includes(runtime.latest_version);
    return (
      <>
        <div className="kset-group">
          <div className="kset-row">
            <div className="kset-row-text">
              <span className="kset-row-title">
                pi {runtime?.installed_version ?? ""}
                <span className={`kset-health ${health}`}>
                  {health === "checking" ? "Checking…" : health}
                </span>
              </span>
              <p>
                <code>{runtime?.path ?? "pi binary not found"}</code>
                {runtime?.latest_version &&
                  (outdated
                    ? ` · ${runtime.latest_version} available`
                    : " · up to date")}
              </p>
            </div>
            <div className="kset-row-control kset-actions">
              <button
                type="button"
                disabled={runtimeBusy}
                onClick={() => void refreshRuntime(true)}
              >
                Check
              </button>
              <button
                type="button"
                className={outdated || health !== "healthy" ? "primary" : ""}
                disabled={runtimeBusy}
                onClick={() => void updateRuntime()}
              >
                {health === "healthy" ? "Update" : "Install"}
              </button>
            </div>
          </div>
          <Row
            id="syncExtensions"
            title="Extensions"
            detail="Copy Kern's pi extensions into the pi config folder."
          >
            <button
              id="field-syncExtensions"
              type="button"
              disabled={runtimeBusy}
              onClick={() => void syncExtensions()}
            >
              Sync
            </button>
          </Row>
          {runtimeLog && <pre className="kset-log">{runtimeLog}</pre>}
        </div>
        <div className="kset-group">
          <Row
            id="sessionDir"
            title="Session storage"
            detail={String(settings?.sessionDir || "~/.pi/agent/sessions")}
          >
            <button
              id="field-sessionDir"
              type="button"
              onClick={() => void chooseSessionDir()}
            >
              Choose…
            </button>
          </Row>
          <Row
            id="backlogDir"
            title="Backlog and error reports"
            detail={backlogDir || "Loading…"}
          >
            <button
              id="field-backlogDir"
              type="button"
              onClick={() => void chooseBacklogDir()}
            >
              Choose…
            </button>
          </Row>
        </div>
      </>
    );
  }

  function renderSection() {
    switch (section) {
      case "agent":
        return (
          <>
            <HarnessSettings onToast={onToast} />
            <PrReviewSettings />
          </>
        );
      case "connections":
        return <ConnectionsSettings onToast={onToast} />;
      case "mcp":
        return <McpSettings onToast={onToast} />;
      case "rag":
        return <RagSettings onToast={onToast} />;
      case "graphify":
        return <GraphifySettings onToast={onToast} />;
      case "jev":
        return <JevSettings onToast={onToast} />;
      case "pipeline":
        return projectPath ? (
          <PipelineSettings
            projectPath={projectPath}
            projectName={projectName}
            onToast={onToast}
          />
        ) : (
          <p className="kset-empty">
            Select a project first, then open its pipeline from the project
            menu.
          </p>
        );
      case "pi-runtime":
        return renderRuntime();
      default:
        return renderPiForm();
    }
  }

  return (
    <div
      className="kset-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={panelRef}
        className="kset"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
      >
        <nav className="kset-nav" aria-label="Settings sections">
          <strong id="settings-title" className="kset-nav-title">
            Settings
          </strong>
          {NAV.map((group) => (
            <div className="kset-nav-group" key={group.label}>
              <span className="kset-nav-label">{group.label}</span>
              {group.items.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={section === item ? "active" : ""}
                  aria-current={section === item ? "page" : undefined}
                  disabled={item === "pipeline" && !projectPath}
                  onClick={() => setSection(item)}
                >
                  {NAV_LABEL[item] ?? SECTIONS[item].title}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="kset-body">
          <label>
            <input
              type="checkbox"
              checked={notificationSound}
              onChange={(event) => {
                const enabled = event.target.checked;
                try {
                  localStorage.setItem(
                    "kern:notification-sound",
                    String(enabled),
                  );
                  setNotificationSound(enabled);
                } catch {
                  setError("Could not save notification sound preference");
                }
              }}
            />{" "}
            Notification sounds
          </label>
          <header className="kset-head">
            <div>
              <h2>{SECTIONS[section].title}</h2>
              <p>{SECTIONS[section].detail}</p>
            </div>
            {isPiForm && (
              <div className="kset-scope">
                <div role="group" aria-label="Settings scope">
                  <button
                    type="button"
                    className={scope === "global" ? "active" : ""}
                    aria-pressed={scope === "global"}
                    onClick={() => setScope("global")}
                  >
                    Global
                  </button>
                  <button
                    type="button"
                    className={scope === "project" ? "active" : ""}
                    aria-pressed={scope === "project"}
                    disabled={!projectPath}
                    title={projectPath ? undefined : "Open a project first"}
                    onClick={() => setScope("project")}
                  >
                    Project
                  </button>
                </div>
                <code title={scopePath}>{scopePath}</code>
              </div>
            )}
            <button
              type="button"
              className="kset-close"
              onClick={onClose}
              aria-label="Close settings"
              title="Close (Esc)"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M1 1l12 12M13 1L1 13" />
              </svg>
            </button>
          </header>

          <div className="kset-scroll">
            <Suspense fallback={<div className="kset-loading">Loading…</div>}>
              {renderSection()}
            </Suspense>
            {error && (
              <div className="kset-inline-error" role="alert">
                {error}
              </div>
            )}
          </div>

          {isPiForm && (
            <footer className="kset-foot">
              <span className={`kset-status ${dirty ? "dirty" : ""}`}>
                {dirty
                  ? scope === "project"
                    ? "Unsaved project overrides"
                    : "Unsaved changes"
                  : "Saved"}
              </span>
              <button
                type="button"
                onClick={() => setText(saved)}
                disabled={!dirty}
              >
                Discard
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void save()}
                disabled={loading || !dirty || settings === null}
              >
                Save
              </button>
            </footer>
          )}
        </div>
      </section>
    </div>
  );
}
