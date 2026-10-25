import "@fontsource/merriweather/400.css";
import "@fontsource/merriweather/400-italic.css";
import "@fontsource/merriweather/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource-variable/lilex";
import "@fontsource-variable/instrument-sans/wdth.css";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { exit } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

import ProjectList, { type ProjectInfo } from "./components/ProjectList";
import ChatView from "./components/ChatView";
const KanbanBoard = lazy(() => import("./components/KanbanBoard"));
const SettingsPanel = lazy(() => import("./components/SettingsPanel"));
const PipelineView = lazy(() => import("./components/PipelineView"));
const RagKnowledge = lazy(() => import("./components/RagKnowledge"));
const SkillsView = lazy(() => import("./components/SkillsView"));
const DeepResearchView = lazy(() => import("./components/DeepResearchView"));
const PromptEnginesView = lazy(() => import("./components/PromptEnginesView"));
import { ConfirmHost } from "./components/ConfirmDialog";
import { checkAgentUpdatesOnStartup } from "./lib/agent-updates";
import { startQuotaPolling } from "./lib/quota";
import {
  BookIcon,
  ChatIcon,
  ExternalIcon,
  PanelIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  SettingsIcon,
  SparkIcon,
  BlurIcon,
  CopyIcon,
} from "./components/Icons";
import {
  APPEARANCE_KEY,
  COLOR_THEME_KEY,
  applyAppearance,
  applyColorTheme,
  readAppearance,
  type Appearance,
} from "./theme";
import { Mascot } from "./components/Mascot";
import BackgroundMotion from "./components/BackgroundMotion";
import "./App.css";
import "./core-workspace.css";
import "./application-redesign.css";
import "./prompt-engines.css";
import "./layout-overhaul.css";
import "./zed-theme.css";
import "./minimal-layout.css";
import "./zed-project-panel.css";
import "./kern-theme.css";
import "./quiet-native.css";
// OpenDots design system & animations — takes priority
import "./opendots.css";
import "./kern-refine.css";
import "./night-shift.css";
import "./sidebar-rail.css";
import "./typography.css";
import "./settings.css";
import "./toast.css";
import "./composer.css";
import "./right-sidebar.css";
import "./run-card.css";

type Config = {
  pi_path: string;
  project_root: string;
  default_provider: string;
  default_model: string;
  default_thinking: string;
};

type Tab = {
  id: string;
  project: ProjectInfo;
  global?: boolean;
  title?: string;
  sessionFile?: string;
  model?: string;
  thinking?: string;
  interrupted?: boolean;
  harness?: string;
  unread?: number;
  initialPrompt?: string;
  initialDraft?: string;
};
type KanbanTaskContext = {
  no?: string | number;
  url?: string;
  deskripsi?: string;
  pic?: string;
  status?: string;
  notes?: string;
};
const GLOBAL_PROJECT: ProjectInfo = {
  name: "GLOBAL CHAT",
  path: "global",
  kinds: [],
  mtime_ms: 0,
  is_git: false,
};

type Dashboard =
  | "kanban"
  | "pipeline"
  | "knowledge"
  | "skills"
  | "research"
  | "engines";

const DASHBOARD_TITLES: Record<Dashboard, string> = {
  kanban: "Tasks",
  pipeline: "Pipeline",
  knowledge: "Knowledge",
  skills: "Skills",
  research: "Deep research",
  engines: "Prompt engines",
};

const CHAT_TABS_KEY = "crc-chat-tabs";
/** Toasts that report a failure get the red bar instead of amber. */
const TOAST_ERROR =
  /\b(error|failed|failure|unavailable|couldn't|could not|cannot|timed out)\b/i;
const SIDEBAR_WIDTH_KEY = "crc-sidebar-width";
// Width covers the 48px icon rail plus the session panel.
const SIDEBAR_MIN_WIDTH = 260;
const SIDEBAR_MAX_WIDTH = 420;

function savedSidebarWidth() {
  const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  const width = saved === null ? NaN : Number(saved);
  return Number.isFinite(width)
    ? Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width))
    : 296;
}

function savedTabs(): Tab[] {
  try {
    return JSON.parse(localStorage.getItem(CHAT_TABS_KEY) ?? "[]") as Tab[];
  } catch {
    return [];
  }
}

/** `/resume` can only switch between sessions of the same agent harness. */
export function sameSessionHarness(candidate: string, current?: string) {
  if (!current) return true;
  const harness = (file: string) =>
    file.startsWith("acp:") ? file.split(":")[1] : "pi";
  return harness(candidate) === harness(current);
}

export default function App() {
  const [configErr, setConfigErr] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>(savedTabs);
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);
  const [activeTabId, setActiveTabId] = useState<string | null>(() => {
    const tabs = savedTabs();
    return tabs[tabs.length - 1]?.id ?? null;
  });
  const [mountedTabIds, setMountedTabIds] = useState<Set<string>>(() => {
    const tabs = savedTabs();
    const active = tabs[tabs.length - 1]?.id;
    return new Set(active ? [active] : []);
  });

  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const [selectedProject, setSelectedProject] = useState<ProjectInfo | null>(
    null,
  );
  const [toasts, setToasts] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<"pi" | "pipeline">("pi");
  const [settingsProject, setSettingsProject] = useState<ProjectInfo | null>(
    null,
  );
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [researchRunId, setResearchRunId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [availableVersion, setAvailableVersion] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(savedSidebarWidth);
  const [appearance, setAppearance] = useState<Appearance>(readAppearance);
  const [bgBlurred, setBgBlurred] = useState(() => {
    try {
      return localStorage.getItem("crc_bg_blurred") === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("crc_bg_blurred", String(bgBlurred));
    } catch {}
    window.dispatchEvent(
      new CustomEvent("crc-bg-blur-changed", {
        detail: { blurred: bgBlurred },
      }),
    );
  }, [bgBlurred]);

  const sidebarDragRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );

  const addToast = useCallback((msg: string) => {
    setToasts((prev) => [...prev, msg].slice(-6));
    setTimeout(() => setToasts((prev) => prev.slice(1)), 6000);
  }, []);

  const fetchConfig = () => {
    setConfigErr(null);
    invoke<Config>("get_config").catch((e) => setConfigErr(String(e)));
  };

  useEffect(() => {
    fetchConfig();
    // Tabs are instance-local: they cannot authorize deleting another instance's worktrees.
    // Worktree removal is an explicit user action, never startup housekeeping.
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
    check()
      .then((update) => {
        if (!update) return;
        setAvailableVersion(update.version);
        addToast(`Update ${update.version} is available`);
      })
      .catch(() => {});
    // Agent CLIs drift independently of the app; check them off the
    // startup path so launch is not waiting on npm/git.
    const agentCheck = setTimeout(() => {
      void checkAgentUpdatesOnStartup(addToast);
    }, 5000);
    // Quota resets (scheduled, redeemed or granted) surface as toasts.
    const stopQuota = startQuotaPolling(addToast);
    return () => {
      clearTimeout(agentCheck);
      stopQuota();
    };
  }, [addToast]);

  useEffect(() => {
    localStorage.setItem(CHAT_TABS_KEY, JSON.stringify(tabs));
  }, [tabs]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyAppearance(appearance, media.matches);
    update();
    if (appearance === "system") media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [appearance]);

  useEffect(() => {
    // One theme now (Night shift); clear the retired Classic/Kern choice.
    localStorage.removeItem(COLOR_THEME_KEY);
    applyColorTheme("classic");
  }, []);

  function chooseAppearance(value: Appearance) {
    setAppearance(value);
    if (value === "system") localStorage.removeItem(APPEARANCE_KEY);
    else localStorage.setItem(APPEARANCE_KEY, value);
  }

  const saveSessionFile = useCallback((tabId: string, sessionFile: string) => {
    setTabs((prev) =>
      prev.map((item) => (item.id === tabId ? { ...item, sessionFile } : item)),
    );
  }, []);

  const saveHarness = useCallback((tabId: string, harness: string) => {
    setTabs((prev) =>
      prev.map((item) => (item.id === tabId ? { ...item, harness } : item)),
    );
  }, []);

  const saveTitle = useCallback((tabId: string, title: string) => {
    setTabs((prev) =>
      prev.map((item) =>
        item.id === tabId && !item.title ? { ...item, title } : item,
      ),
    );
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("crc-agent-prompt", {
          detail: { text: title, tabId },
        }),
      );
    }
  }, []);

  const saveRuntimeSettings = useCallback(
    (tabId: string, model: string, thinking: string) => {
      setTabs((prev) =>
        prev.map((item) =>
          item.id === tabId ? { ...item, model, thinking } : item,
        ),
      );
    },
    [],
  );

  const saveAgentRunning = useCallback(
    (tabId: string, interrupted: boolean) => {
      setTabs((prev) =>
        prev.map((item) =>
          item.id === tabId ? { ...item, interrupted } : item,
        ),
      );
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("crc-agent-running", {
            detail: { running: interrupted, tabId },
          }),
        );
      }
    },
    [],
  );

  const markUnread = useCallback((tabId: string) => {
    setTabs((prev) =>
      prev.map((item) =>
        item.id === tabId && item.id !== activeTabIdRef.current
          ? { ...item, unread: (item.unread || 0) + 1 }
          : item,
      ),
    );
  }, []);

  function activateTab(tabId: string) {
    setTabs((prev) =>
      prev.map((item) => (item.id === tabId ? { ...item, unread: 0 } : item)),
    );
    setMountedTabIds((ids) => new Set(ids).add(tabId));
    setActiveTabId(tabId);
  }

  function openProject(project: ProjectInfo) {
    setDashboard(null);
    setSelectedProject(project);
    const existing = [...tabs]
      .reverse()
      .find((tab) => tab.project.path === project.path);
    if (existing) return activateTab(existing.id);
    newConversation(project);
  }

  function newGlobalChat() {
    setDashboard(null);
    setSelectedProject(null);
    const id = `global-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setTabs((prev) => [...prev, { id, project: GLOBAL_PROJECT, global: true }]);
    setMountedTabIds((ids) => new Set(ids).add(id));
    setActiveTabId(id);
  }

  function openGlobalChat() {
    setDashboard(null);
    setSelectedProject(null);
    const latest = [...tabs].reverse().find((tab) => tab.global);
    if (latest) return activateTab(latest.id);
    newGlobalChat();
  }

  useEffect(() => {
    const useSkill = (event: Event) => {
      const name = (event as CustomEvent<string>).detail;
      if (!name) return;
      setDashboard(null);
      const tab =
        tabs.find((item) => item.id === activeTabIdRef.current) ??
        tabs[tabs.length - 1];
      if (tab) {
        activateTab(tab.id);
        window.setTimeout(
          () =>
            window.dispatchEvent(
              new CustomEvent("crc-skill-ready", { detail: name }),
            ),
          50,
        );
      } else {
        const id = `global-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        setSelectedProject(null);
        setTabs((prev) => [
          ...prev,
          {
            id,
            project: GLOBAL_PROJECT,
            global: true,
            initialPrompt: `/skill:${name}`,
          },
        ]);
        setActiveTabId(id);
      }
    };
    window.addEventListener("crc-use-skill", useSkill);
    return () => window.removeEventListener("crc-use-skill", useSkill);
  }, [tabs]);

  function newTaskConversation(task: KanbanTaskContext) {
    if (!workspaceProject) return;
    const prompt = [
      "Kerjakan task project berikut. Gunakan detail task sebagai requirement utama dan periksa codebase sebelum mengubah file.",
      "",
      "## Task",
      task.deskripsi || "Untitled task",
      "",
      "## Metadata",
      `- Task: #${task.no ?? "—"}`,
      `- Project: ${workspaceProject.name}`,
      `- PIC: ${task.pic || "Unassigned"}`,
      `- Status: ${task.status || "Unknown"}`,
      "- Source: Google Sheets",
      task.url ? `- Source URL: ${task.url}` : "",
      task.notes ? `\n## Notes\n${task.notes}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const id = `${workspaceProject.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setTabs((prev) => [
      ...prev,
      {
        id,
        project: workspaceProject,
        title: `#${task.no ?? "Task"} ${task.deskripsi || "Task"}`
          .replace(/\s+/g, " ")
          .slice(0, 60),
        initialPrompt: prompt,
      },
    ]);
    setActiveTabId(id);
    setSelectedProject(workspaceProject);
    setDashboard(null);
  }

  function newConversation(project = selectedProject) {
    if (!project) return;
    const id = `${project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setTabs((prev) => [...prev, { id, project }]);
    setSelectedProject(project);
    setMountedTabIds((ids) => new Set(ids).add(id));
    setActiveTabId(id);
  }

  function closeTab(tabId: string) {
    setTabs((prev) => {
      const next = prev.filter((tab) => tab.id !== tabId);
      if (activeTabId === tabId)
        setActiveTabId(next[next.length - 1]?.id ?? null);
      return next;
    });
    setMountedTabIds((ids) => {
      const next = new Set(ids);
      next.delete(tabId);
      return next;
    });
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const workspaceProject =
    selectedProject ??
    (activeTab && !activeTab.global ? activeTab.project : null);

  async function installUpdate() {
    setUpdating(true);
    try {
      const update = await check();
      if (!update) {
        setAvailableVersion("");
        return addToast("App is up to date");
      }
      setAvailableVersion(update.version);
      addToast(`Downloading update ${update.version}…`);
      await update.downloadAndInstall();
      await exit(0);
    } catch (error) {
      addToast(`Update failed: ${String(error)}`);
    } finally {
      setUpdating(false);
    }
  }

  async function openInVsCode() {
    if (!workspaceProject) return;
    try {
      await invoke("open_vscode", { path: workspaceProject.path });
    } catch (error) {
      addToast(`Could not open VS Code: ${String(error)}`);
    }
  }

  async function checkForUpdate() {
    setUpdating(true);
    try {
      const update = await check();
      setAvailableVersion(update?.version ?? "");
      addToast(
        update ? `Update ${update.version} is available` : "App is up to date",
      );
    } catch (error) {
      addToast(`Update check failed: ${String(error)}`);
    } finally {
      setUpdating(false);
    }
  }

  return (
    <main
      className={`app-shell ${sidebarOpen ? "" : "sidebar-hidden"}`}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <a className="skip-link" href="#workspace-content">
        Skip to workspace
      </a>
      <aside
        className="sidebar sidebar--rail glass-surface"
        aria-label="Projects and sessions"
      >
        <div
          className="sidebar-resize-handle"
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={(e) => {
            e.preventDefault();
            sidebarDragRef.current = {
              startX: e.clientX,
              startWidth: sidebarWidth,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!sidebarDragRef.current) return;
            const { startX, startWidth } = sidebarDragRef.current;
            setSidebarWidth(
              Math.max(
                SIDEBAR_MIN_WIDTH,
                Math.min(SIDEBAR_MAX_WIDTH, startWidth + (e.clientX - startX)),
              ),
            );
          }}
          onPointerUp={(e) => {
            sidebarDragRef.current = null;
            e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onPointerCancel={(e) => {
            sidebarDragRef.current = null;
            e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft")
              setSidebarWidth((width) =>
                Math.max(SIDEBAR_MIN_WIDTH, width - 10),
              );
            if (e.key === "ArrowRight")
              setSidebarWidth((width) =>
                Math.min(SIDEBAR_MAX_WIDTH, width + 10),
              );
          }}
        />
        <nav className="sidebar-rail" aria-label="Workspace views">
          <span className="dotted-logo rail-logo" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          {(
            [
              [null, "Chat", ChatIcon],
              ["engines", "Prompt Engines", SparkIcon],
              ["research", "Deep Research", SearchIcon],
              ["knowledge", "Knowledge", BookIcon],
              ["skills", "Skills", SparkIcon],
            ] as const
          ).map(([view, label, Icon]) => (
            <button
              key={label}
              title={label}
              aria-label={label}
              className={`rail-button ${dashboard === view ? "active" : ""}`}
              aria-current={dashboard === view ? "page" : undefined}
              onClick={() => setDashboard(view)}
            >
              <Icon />
            </button>
          ))}
          <div className="rail-spacer" />
          <button
            className={`rail-button${bgBlurred ? " is-active" : ""}`}
            onClick={() => setBgBlurred((prev) => !prev)}
            title={
              bgBlurred
                ? "Show the office background"
                : "Blur the office background"
            }
            aria-label="Blur background"
            aria-pressed={bgBlurred}
          >
            <BlurIcon active={bgBlurred} />
          </button>
          <button
            className={`rail-button${availableVersion ? " has-update" : ""}`}
            title={
              updating
                ? "Checking update…"
                : availableVersion
                  ? `Update ${availableVersion} available`
                  : "Check Update"
            }
            aria-label={
              updating
                ? "Checking update…"
                : availableVersion
                  ? `Update ${availableVersion} available`
                  : "Check Update"
            }
            disabled={updating}
            onClick={() => void checkForUpdate()}
          >
            <RefreshIcon />
          </button>
          <button
            title="Settings"
            aria-label="Settings"
            className="rail-button"
            onClick={() => {
              setSettingsProject(selectedProject ?? activeTab?.project ?? null);
              setSettingsPage("pi");
              setSettingsOpen(true);
            }}
          >
            <SettingsIcon />
          </button>
        </nav>
        <div className="sidebar-panel">
          <div className="sidebar-brand">
            <span className="wordmark-text">
              <strong>Kern</strong>
              <small>Studio</small>
            </span>
            <button
              className="sidebar-brand-action"
              onClick={() => {
                if (workspaceProject) {
                  newConversation(workspaceProject);
                } else {
                  newGlobalChat();
                }
              }}
              title="New chat"
              aria-label="New chat"
            >
              <PlusIcon />
            </button>
            <button
              className="sidebar-brand-action"
              onClick={() => setSidebarOpen(false)}
              title="Hide sidebar"
              aria-label="Hide sidebar"
            >
              <PanelIcon />
            </button>
          </div>
          <div className="sidebar-scroll">
            {configErr && (
              <div className="sidebar-error" role="alert">
                Config error: {configErr}{" "}
                <button onClick={fetchConfig}>Retry</button>
              </div>
            )}
            <ProjectList
              onOpen={openProject}
              onSelect={(project) => {
                setDashboard(null);
                setSelectedProject(project);
              }}
              tabs={tabs.filter((tab) => !tab.global)}
              activeTabId={activeTabId}
              onResume={(id, project) => {
                setDashboard(null);
                setSelectedProject(project);
                activateTab(id);
              }}
              onNewSession={newConversation}
              onToast={addToast}
              onPipelineSettings={(project) => {
                setSelectedProject(project);
                setSettingsProject(project);
                setSettingsPage("pipeline");
                setSettingsOpen(true);
              }}
            />
            <div className="projects-panel">
              <div className="projects-heading">
                <span>Global chat</span>
                <button
                  onClick={newGlobalChat}
                  title="New Global Chat"
                  aria-label="New Global Chat"
                >
                  <PlusIcon />
                </button>
              </div>
              <div className="project-sessions">
                <div>
                  {tabs
                    .filter((tab) => tab.global)
                    .map((tab) => (
                      <button
                        key={tab.id}
                        className={`conversation-row ${tab.id === activeTabId ? "active" : ""}`}
                        onClick={() => {
                          setDashboard(null);
                          setSelectedProject(null);
                          activateTab(tab.id);
                        }}
                      >
                        <span>{tab.title ?? "Untitled session"}</span>
                        {tab.interrupted ? (
                          <span
                            className="agent-working-mark"
                            aria-label="Agent working"
                          >
                            <i />
                            <i />
                            <i />
                          </span>
                        ) : (
                          !!tab.unread && (
                            <span className="unread-badge">{tab.unread}</span>
                          )
                        )}
                      </button>
                    ))}
                </div>
              </div>
              {tabs.every((tab) => !tab.global) && (
                <button className="settings-button" onClick={openGlobalChat}>
                  <ChatIcon className="settings-icon" />
                  <span>Open global chat</span>
                </button>
              )}
            </div>
          </div>
          <div className="sidebar-panel-footer">
            <div
              className="appearance-control"
              role="group"
              aria-label="Appearance"
            >
              {(["system", "light", "dark"] as const).map((value) => (
                <button
                  key={value}
                  className={appearance === value ? "active" : ""}
                  aria-pressed={appearance === value}
                  title={value === "system" ? "Follow system" : value}
                  onClick={() => chooseAppearance(value)}
                >
                  {value === "system"
                    ? "System"
                    : value === "light"
                      ? "Light"
                      : "Dark"}
                </button>
              ))}
            </div>
            {appVersion && <small className="app-version">v{appVersion}</small>}
          </div>
        </div>
      </aside>

      <section className="workspace">
        {/* Behind an open chat the office lives in the Office side panel
            instead, so it is not rendered (and hidden) twice. */}
        {(!activeTab || dashboard !== null) && (
          <BackgroundMotion
            activeTabId={activeTab?.id}
            isWorking={Boolean(activeTab?.interrupted)}
            isBlurred={bgBlurred}
          />
        )}
        <header className="app-toolbar glass-surface">
          {!sidebarOpen && (
            <button
              className="sidebar-toggle"
              onClick={() => setSidebarOpen(true)}
              title="Show sidebar"
              aria-label="Show sidebar"
            >
              <PanelIcon />
            </button>
          )}
          <div className="workspace-title">
            <Mascot
              small
              identity={activeTab?.id ?? workspaceProject?.name ?? "kern"}
              state={activeTab?.interrupted ? "working" : "idle"}
              decorative
            />
            <div>
              <strong>
                {dashboard
                  ? DASHBOARD_TITLES[dashboard]
                  : (activeTab?.title ??
                    (activeTab?.global
                      ? "Global chat"
                      : activeTab?.project.name) ??
                    "No session open")}
              </strong>
              <small>
                {dashboard
                  ? (workspaceProject?.name ?? "Workspace")
                  : activeTab?.global
                    ? "Global chat"
                    : (activeTab?.project.name ??
                      "Pick a project or start a chat")}
              </small>
            </div>
            {activeTab && dashboard === null && (
              <span
                className={`mode-badge ${activeTab.interrupted ? "live" : ""}`}
              >
                <span className="pulse-dot" />
                {activeTab.interrupted ? "Working" : "Ready"}
              </span>
            )}
          </div>
          <div className="toolbar-chat-slot" ref={setHeaderSlot} />
          <div className="toolbar-actions">
            {workspaceProject && (
              <nav
                className="project-workspace-nav"
                aria-label={`${workspaceProject.name} views`}
              >
                <button
                  className={dashboard === "kanban" ? "active" : ""}
                  onClick={() => setDashboard("kanban")}
                  aria-current={dashboard === "kanban" ? "page" : undefined}
                >
                  Tasks
                </button>
                <button
                  className={dashboard === "pipeline" ? "active" : ""}
                  onClick={() => setDashboard("pipeline")}
                  aria-current={dashboard === "pipeline" ? "page" : undefined}
                >
                  Pipeline
                </button>
              </nav>
            )}
            {(availableVersion || updating) && (
              <button
                className="toolbar-button toolbar-button-secondary"
                onClick={installUpdate}
                disabled={updating}
                aria-busy={updating}
                aria-label={
                  updating ? "UPDATING" : `UPDATE v${availableVersion}`
                }
              >
                <span>
                  {updating ? "Updating…" : `Update v${availableVersion}`}
                </span>
              </button>
            )}
            {workspaceProject && (
              <button
                className="toolbar-button toolbar-button-secondary"
                onClick={() => void openInVsCode()}
              >
                <span>Open VS Code</span>
                <ExternalIcon />
              </button>
            )}
          </div>
        </header>

        <div className="workspace-body" id="workspace-content" tabIndex={-1}>
          {dashboard === "kanban" && (
            <Suspense
              fallback={
                <div className="session-loading" role="status">
                  Loading kanban…
                </div>
              }
            >
              <KanbanBoard
                projectName={workspaceProject?.name}
                onWorkTask={newTaskConversation}
              />
            </Suspense>
          )}
          {dashboard === "pipeline" && (
            <Suspense
              fallback={
                <div className="session-loading" role="status">
                  Loading pipeline…
                </div>
              }
            >
              <PipelineView
                projectPath={workspaceProject?.path}
                projectName={workspaceProject?.name}
              />
            </Suspense>
          )}
          {dashboard === "knowledge" && (
            <Suspense
              fallback={
                <div className="session-loading" role="status">
                  Loading knowledge…
                </div>
              }
            >
              <RagKnowledge onToast={addToast} />
            </Suspense>
          )}
          {dashboard === "skills" && (
            <Suspense
              fallback={
                <div className="session-loading" role="status">
                  Loading skills…
                </div>
              }
            >
              <SkillsView />
            </Suspense>
          )}
          {dashboard === "research" && (
            <Suspense
              fallback={
                <div className="session-loading" role="status">
                  Loading reports…
                </div>
              }
            >
              <DeepResearchView
                initialRunId={researchRunId}
                originChatId={activeTab?.id}
                originSessionId={activeTab ? `chat-${activeTab.id}` : undefined}
                onStartInChat={() => {
                  if (!activeTab) return;
                  setTabs((current) =>
                    current.map((tab) =>
                      tab.id === activeTab.id
                        ? { ...tab, initialDraft: "/research " }
                        : tab,
                    ),
                  );
                  activateTab(activeTab.id);
                  setDashboard(null);
                }}
                onContinueInChat={(run) => {
                  const tabId = run.origin_chat_id;
                  if (!tabId || !tabs.some((tab) => tab.id === tabId)) return;
                  activateTab(tabId);
                  setDashboard(null);
                }}
              />
            </Suspense>
          )}
          {dashboard === "engines" && (
            <Suspense
              fallback={
                <div className="session-loading" role="status">
                  Loading prompt engines…
                </div>
              }
            >
              <PromptEnginesView onToast={addToast} />
            </Suspense>
          )}
          {activeTab
            ? tabs
                .filter((tab) => mountedTabIds.has(tab.id))
                .map((tab) => {
                  const isHidden = dashboard !== null || tab.id !== activeTabId;
                  return (
                    <div
                      key={tab.id}
                      className={`chat-session${isHidden ? " is-hidden" : ""}`}
                      hidden={isHidden}
                      style={{
                        ...(isHidden ? { display: "none" } : undefined),
                        width: "100%",
                        maxWidth: "100%",
                        minWidth: 0,
                        overflowX: "hidden",
                        overscrollBehaviorX: "none",
                      }}
                    >
                      <ChatView
                        projectPath={tab.project.path}
                        projectName={tab.project.name}
                        isGit={tab.project.is_git}
                        repositories={tab.project.repositories ?? []}
                        globalChat={tab.global}
                        pipelineType={tab.project.pipeline_type ?? "Personal"}
                        chatId={tab.id}
                        sessionFile={tab.sessionFile}
                        initialModel={tab.model}
                        initialThinking={tab.thinking}
                        initialInterrupted={tab.interrupted}
                        initialHarness={tab.harness}
                        onHarnessChange={saveHarness}
                        resumableSessions={tabs
                          .filter(
                            (candidate) =>
                              candidate.id !== tab.id &&
                              candidate.global === tab.global &&
                              candidate.project.path === tab.project.path &&
                              candidate.sessionFile &&
                              sameSessionHarness(
                                candidate.sessionFile,
                                tab.sessionFile,
                              ),
                          )
                          .map((candidate) => ({
                            title: candidate.title ?? "Untitled session",
                            sessionFile: candidate.sessionFile!,
                          }))}
                        onSessionFile={saveSessionFile}
                        onFirstMessage={saveTitle}
                        onRuntimeSettings={saveRuntimeSettings}
                        onAgentRunning={saveAgentRunning}
                        onUnread={markUnread}
                        onClose={() => closeTab(tab.id)}
                        onToast={addToast}
                        initialPrompt={tab.initialPrompt}
                        initialDraft={tab.initialDraft}
                        onInitialPromptConsumed={() =>
                          setTabs((prev) =>
                            prev.map((item) =>
                              item.id === tab.id
                                ? { ...item, initialPrompt: undefined }
                                : item,
                            ),
                          )
                        }
                        onInitialDraftConsumed={() =>
                          setTabs((prev) =>
                            prev.map((item) =>
                              item.id === tab.id
                                ? { ...item, initialDraft: undefined }
                                : item,
                            ),
                          )
                        }
                        onOpenPipeline={() => {
                          setSelectedProject(tab.project);
                          setDashboard("pipeline");
                        }}
                        onOpenResearch={(runId) => {
                          setResearchRunId(runId);
                          setDashboard("research");
                        }}
                        isActive={tab.id === activeTabId}
                        headerSlot={dashboard === null ? headerSlot : null}
                      />
                    </div>
                  );
                })
            : dashboard === null && (
                <div className="empty-state">
                  <Mascot state="idle" name="Dot" />
                  <span className="empty-status">
                    <span className="online-dot" aria-hidden="true" /> Workspace
                    idle
                  </span>
                  <strong>No active session</strong>
                  <span>Open a project session or start Global Chat.</span>
                  <div>
                    <button
                      className="toolbar-button toolbar-button-primary"
                      onClick={openGlobalChat}
                    >
                      Open Global Chat
                    </button>
                  </div>
                </div>
              )}
        </div>
        <div className="toast-container" aria-live="polite">
          {toasts.map((toast, i) => (
            <div
              key={i}
              className={`toast${TOAST_ERROR.test(toast) ? " toast--error" : ""}`}
              role="status"
            >
              <span>{toast}</span>
              <button
                onClick={(e) => {
                  navigator.clipboard.writeText(toast).catch(() => {});
                  const btn = e.currentTarget;
                  btn.classList.add("copied");
                  setTimeout(() => btn.classList.remove("copied"), 1200);
                }}
                title="Copy"
                aria-label="Copy toast"
              >
                <CopyIcon />
              </button>
              <button
                onClick={() =>
                  setToasts((prev) => prev.filter((_, idx) => idx !== i))
                }
                title="Dismiss"
                aria-label="Dismiss toast"
                className="toast-close"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M1 1l12 12M13 1L1 13" />
                </svg>
              </button>
            </div>
          ))}
        </div>
        {settingsOpen && (
          <Suspense
            fallback={
              <div
                className="kset-scrim"
                role="status"
                aria-label="Loading settings"
              />
            }
          >
            <SettingsPanel
              projectPath={
                settingsProject?.path ??
                selectedProject?.path ??
                activeTab?.project.path
              }
              projectName={
                settingsProject?.name ??
                selectedProject?.name ??
                activeTab?.project.name
              }
              initialPage={settingsPage}
              onClose={() => setSettingsOpen(false)}
              onToast={addToast}
            />
          </Suspense>
        )}
      </section>
      <ConfirmHost />
    </main>
  );
}
