import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/merriweather/400.css";
import "@fontsource/merriweather/400-italic.css";
import "@fontsource/merriweather/700.css";
import "@fontsource/jetbrains-mono/400.css";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { exit } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

import ProjectList, { type ProjectInfo } from "./components/ProjectList";
import ChatView from "./components/ChatView";
import KanbanBoard from "./components/KanbanBoard";
const SettingsPanel = lazy(() => import("./components/SettingsPanel"));
const PipelineView = lazy(() => import("./components/PipelineView"));
const RagKnowledge = lazy(() => import("./components/RagKnowledge"));
const DeepResearchView = lazy(() => import("./components/DeepResearchView"));
const PromptEnginesView = lazy(() => import("./components/PromptEnginesView"));
import { ConfirmHost } from "./components/ConfirmDialog";
import { BookIcon, ChatIcon, ExternalIcon, PanelIcon, PlusIcon, SearchIcon, SettingsIcon, SparkIcon } from "./components/Icons";
import { APPEARANCE_KEY, applyAppearance, readAppearance, type Appearance } from "./theme";
import "./App.css";
import "./core-workspace.css";
import "./prompt-engines.css";
import "./quiet-native.css";
import "./zed-project-panel.css";

type Config = {
  pi_path: string;
  project_root: string;
  default_provider: string;
  default_model: string;
  default_thinking: string;
};

type Tab = { id: string; project: ProjectInfo; global?: boolean; title?: string; sessionFile?: string; model?: string; thinking?: string; interrupted?: boolean; unread?: number; initialPrompt?: string };
type KanbanTaskContext = { no?: string | number; url?: string; deskripsi?: string; pic?: string; status?: string; notes?: string };
const GLOBAL_PROJECT: ProjectInfo = { name: "GLOBAL CHAT", path: "global", kinds: [], mtime_ms: 0, is_git: false };

const CHAT_TABS_KEY = "crc-chat-tabs";
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 360;

function savedTabs(): Tab[] {
  try {
    return JSON.parse(localStorage.getItem(CHAT_TABS_KEY) ?? "[]") as Tab[];
  } catch {
    return [];
  }
}

export default function App() {
  const [configErr, setConfigErr] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>(savedTabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(() => {
    const tabs = savedTabs();
    return tabs[tabs.length - 1]?.id ?? null;
  });

  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const [selectedProject, setSelectedProject] = useState<ProjectInfo | null>(null);
  const [toasts, setToasts] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<"pi" | "pipeline">("pi");
  const [settingsProject, setSettingsProject] = useState<ProjectInfo | null>(null);
  const [dashboard, setDashboard] = useState<"kanban" | "pipeline" | "knowledge" | "research" | "engines" | null>(null);
  const [researchRunId, setResearchRunId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [availableVersion, setAvailableVersion] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(250);
  const [appearance, setAppearance] = useState<Appearance>(readAppearance);
  const sidebarDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

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
    getVersion().then(setAppVersion).catch(() => {});
    check()
      .then((update) => {
        if (!update) return;
        setAvailableVersion(update.version);
        addToast(`Update ${update.version} is available`);
      })
      .catch(() => {});
  }, [addToast]);

  useEffect(() => {
    localStorage.setItem(CHAT_TABS_KEY, JSON.stringify(tabs));
  }, [tabs]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyAppearance(appearance, media.matches);
    update();
    if (appearance === "system") media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [appearance]);

  function chooseAppearance(value: Appearance) {
    setAppearance(value);
    if (value === "system") localStorage.removeItem(APPEARANCE_KEY);
    else localStorage.setItem(APPEARANCE_KEY, value);
  }

  const saveSessionFile = useCallback((tabId: string, sessionFile: string) => {
    setTabs((prev) => prev.map((item) => item.id === tabId ? { ...item, sessionFile } : item));
  }, []);

  const saveTitle = useCallback((tabId: string, title: string) => {
    setTabs((prev) => prev.map((item) => item.id === tabId && !item.title ? { ...item, title } : item));
  }, []);

  const saveRuntimeSettings = useCallback((tabId: string, model: string, thinking: string) => {
    setTabs((prev) => prev.map((item) => item.id === tabId ? { ...item, model, thinking } : item));
  }, []);

  const saveAgentRunning = useCallback((tabId: string, interrupted: boolean) => {
    setTabs((prev) => prev.map((item) => item.id === tabId ? { ...item, interrupted } : item));
  }, []);

  const markUnread = useCallback((tabId: string) => {
    setTabs((prev) => prev.map((item) => item.id === tabId && item.id !== activeTabIdRef.current ? { ...item, unread: (item.unread || 0) + 1 } : item));
  }, []);

  function activateTab(tabId: string) {
    setTabs((prev) => prev.map((item) => item.id === tabId ? { ...item, unread: 0 } : item));
    setActiveTabId(tabId);
  }

  function openProject(project: ProjectInfo) {
    setDashboard(null);
    setSelectedProject(project);
    const existing = tabs.find((tab) => tab.project.path === project.path);
    if (existing) return activateTab(existing.id);
    newConversation(project);
  }

  function newGlobalChat() {
    setDashboard(null);
    setSelectedProject(null);
    const id = `global-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setTabs((prev) => [...prev, { id, project: GLOBAL_PROJECT, global: true }]);
    setActiveTabId(id);
  }

  function openGlobalChat() {
    setDashboard(null);
    setSelectedProject(null);
    const latest = [...tabs].reverse().find((tab) => tab.global);
    if (latest) return activateTab(latest.id);
    newGlobalChat();
  }

  function newTaskConversation(task: KanbanTaskContext) {
    if (!workspaceProject) return;
    const prompt = [
      "Kerjakan task project berikut. Gunakan detail task sebagai requirement utama dan periksa codebase sebelum mengubah file.",
      "", "## Task", task.deskripsi || "Untitled task", "", "## Metadata",
      `- Task: #${task.no ?? "—"}`, `- Project: ${workspaceProject.name}`,
      `- PIC: ${task.pic || "Unassigned"}`, `- Status: ${task.status || "Unknown"}`,
      "- Source: Google Sheets", task.url ? `- Source URL: ${task.url}` : "",
      task.notes ? `\n## Notes\n${task.notes}` : "",
    ].filter(Boolean).join("\n");
    const id = `${workspaceProject.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setTabs((prev) => [...prev, { id, project: workspaceProject, title: `#${task.no ?? "Task"} ${task.deskripsi || "Task"}`.replace(/\s+/g, " ").slice(0, 60), initialPrompt: prompt }]);
    setActiveTabId(id);
    setSelectedProject(workspaceProject);
    setDashboard(null);
  }

  function newConversation(project = selectedProject) {
    if (!project) return;
    const id = `${project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setTabs((prev) => [...prev, { id, project }]);
    setSelectedProject(project);
    setActiveTabId(id);
  }

  function closeTab(tabId: string) {
    setTabs((prev) => {
      const next = prev.filter((tab) => tab.id !== tabId);
      if (activeTabId === tabId) setActiveTabId(next[next.length - 1]?.id ?? null);
      return next;
    });
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const workspaceProject = selectedProject ?? (activeTab && !activeTab.global ? activeTab.project : null);

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
      addToast(update ? `Update ${update.version} is available` : "App is up to date");
    } catch (error) {
      addToast(`Update check failed: ${String(error)}`);
    } finally {
      setUpdating(false);
    }
  }

  return (
    <main className={`app-shell ${sidebarOpen ? "" : "sidebar-hidden"}`} style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <a className="skip-link" href="#workspace-content">Skip to workspace</a>
      <aside className="sidebar glass-surface" aria-label="Projects and sessions">
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
            sidebarDragRef.current = { startX: e.clientX, startWidth: sidebarWidth };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!sidebarDragRef.current) return;
            const { startX, startWidth } = sidebarDragRef.current;
            setSidebarWidth(Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, startWidth + (e.clientX - startX))));
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
            if (e.key === "ArrowLeft") setSidebarWidth((width) => Math.max(SIDEBAR_MIN_WIDTH, width - 10));
            if (e.key === "ArrowRight") setSidebarWidth((width) => Math.min(SIDEBAR_MAX_WIDTH, width + 10));
          }}
        />
        <div className="sidebar-brand">
          <span className="brand-mark">R</span>
          <div><strong>Command</strong><small>RDEV Center</small></div>
          <button className="sidebar-collapse" onClick={() => setSidebarOpen(false)} title="Hide sidebar" aria-label="Hide sidebar"><PanelIcon /></button>
        </div>
        <div className="sidebar-label"><span>Sessions</span><i /></div>
        {configErr && <div className="sidebar-error" role="alert">Config error: {configErr} <button onClick={fetchConfig}>Retry</button></div>}
        <ProjectList
          onOpen={openProject}
          onSelect={(project) => { setDashboard(null); setSelectedProject(project); }} 
          tabs={tabs.filter((tab) => !tab.global)}
          activeTabId={activeTabId}
          onResume={(id, project) => { setDashboard(null); setSelectedProject(project); activateTab(id); }}
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
          <div className="projects-heading"><span>Global chat</span><button onClick={newGlobalChat} title="New Global Chat" aria-label="New Global Chat"><PlusIcon /></button></div>
          <div className="project-sessions">
            <div>{tabs.filter((tab) => tab.global).map((tab) => <button key={tab.id} className={`conversation-row ${tab.id === activeTabId ? "active" : ""}`} onClick={() => { setDashboard(null); setSelectedProject(null); activateTab(tab.id); }}><span>{tab.title ?? "UNTITLED SESSION"}</span>{tab.interrupted ? <span className="agent-working-mark" aria-label="Agent working"><i /><i /><i /></span> : !!tab.unread && <span className="unread-badge">{tab.unread}</span>}</button>)}</div>
          </div>
          {tabs.every((tab) => !tab.global) && <button className="settings-button" onClick={openGlobalChat}><ChatIcon className="settings-icon" /><span>Open global chat</span></button>}
        </div>
        <nav className="sidebar-nav" aria-label="Workspace views">
          <div className="sidebar-nav-label">Global</div>
          <button title="Chat" className={`settings-button dashboard-button ${dashboard === null ? "active" : ""}`} aria-current={dashboard === null ? "page" : undefined} onClick={() => setDashboard(null)}>
            <ChatIcon className="settings-icon" /><span>Chat</span>
          </button>
          <button title="Prompt Engines" className={`settings-button dashboard-button ${dashboard === "engines" ? "active" : ""}`} aria-current={dashboard === "engines" ? "page" : undefined} onClick={() => setDashboard("engines")}>
            <SparkIcon className="settings-icon" /><span>Prompt Engines</span>
          </button>
          <button title="Deep Research" className={`settings-button dashboard-button ${dashboard === "research" ? "active" : ""}`} aria-current={dashboard === "research" ? "page" : undefined} onClick={() => setDashboard("research")}>
            <SearchIcon className="settings-icon" /><span>Deep Research</span>
          </button>
          <button title="Knowledge" className={`settings-button dashboard-button ${dashboard === "knowledge" ? "active" : ""}`}  aria-current={dashboard === "knowledge" ? "page" : undefined} onClick={() => setDashboard("knowledge")}>
            <BookIcon className="settings-icon" />
            <span>Knowledge</span>
          </button>
          <div className="sidebar-system">
            <div className="sidebar-nav-label">System</div>
            <div className="appearance-control" role="group" aria-label="Appearance">
              {(["system", "light", "dark"] as const).map((value) => <button key={value} className={appearance === value ? "active" : ""} aria-pressed={appearance === value} onClick={() => chooseAppearance(value)}>{value}</button>)}
            </div>
            <button title="Check Update" className="settings-button dashboard-button" disabled={updating} onClick={() => void checkForUpdate()}>
              <span className="settings-icon" aria-hidden>↻</span>
              <span>{updating ? "Checking update…" : availableVersion ? `Update ${availableVersion} available` : "Check Update"}</span>
            </button>
            <button title="Settings" className="settings-button dashboard-button" onClick={() => { setSettingsProject(selectedProject ?? activeTab?.project ?? null); setSettingsPage("pi"); setSettingsOpen(true); }}>
              <SettingsIcon className="settings-icon" />
              <span>Settings</span>
            </button>
          </div>
        </nav>
        {appVersion && <small className="app-version">v{appVersion}</small>}
      </aside>

      <section className="workspace">
        <header className="app-toolbar glass-surface">
          {!sidebarOpen && <button className="sidebar-toggle" onClick={() => setSidebarOpen(true)} title="Show sidebar" aria-label="Show sidebar"><PanelIcon /></button>}
          <div className="workspace-title">
            <span className="live-dot" aria-hidden="true" />
            <div><strong>{dashboard ?? activeTab?.project.name ?? "No project selected"}</strong><small>{activeTab ? "Local workspace · Ready" : "Local workspace · Idle"}</small></div>
          </div>
          <div className="toolbar-actions">
            {workspaceProject && <nav className="project-workspace-nav" aria-label={`${workspaceProject.name} views`}><button className={dashboard === "kanban" ? "active" : ""} onClick={() => setDashboard("kanban")} aria-current={dashboard === "kanban" ? "page" : undefined}>Tasks</button><button className={dashboard === "pipeline" ? "active" : ""} onClick={() => setDashboard("pipeline")} aria-current={dashboard === "pipeline" ? "page" : undefined}>Pipeline</button></nav>}
            {(availableVersion || updating) && <button className="toolbar-button toolbar-button-secondary" onClick={installUpdate} disabled={updating} aria-busy={updating} aria-label={updating ? "UPDATING" : `UPDATE v${availableVersion}`}>
              <span>{updating ? "Updating…" : `Update v${availableVersion}`}</span>
            </button>}
            <button className="toolbar-button toolbar-button-primary" disabled={!workspaceProject} onClick={() => void openInVsCode()}><span>Open VS Code</span><ExternalIcon /></button>
          </div>
        </header>

        <div className="workspace-body" id="workspace-content" tabIndex={-1}>
          {dashboard === "kanban" && <KanbanBoard projectName={workspaceProject?.name} onWorkTask={newTaskConversation} />}
          {dashboard === "pipeline" && <Suspense fallback={<div className="session-loading" role="status">Loading pipeline…</div>}><PipelineView projectPath={workspaceProject?.path} projectName={workspaceProject?.name} /></Suspense>}
          {dashboard === "knowledge" && <Suspense fallback={<div className="session-loading" role="status">Loading knowledge…</div>}><RagKnowledge onToast={addToast} /></Suspense>}
          {dashboard === "research" && <Suspense fallback={<div className="session-loading" role="status">Loading reports…</div>}><DeepResearchView initialRunId={researchRunId} /></Suspense>}
          {dashboard === "engines" && <Suspense fallback={<div className="session-loading" role="status">Loading prompt engines…</div>}><PromptEnginesView onToast={addToast} /></Suspense>}
          {activeTab ? tabs.map((tab) => (
            <div key={tab.id} className="chat-session" hidden={dashboard !== null || tab.id !== activeTabId}>
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
                resumableSessions={tabs.filter((candidate) => candidate.id !== tab.id && candidate.global === tab.global && candidate.project.path === tab.project.path && candidate.sessionFile).map((candidate) => ({ title: candidate.title ?? "Untitled session", sessionFile: candidate.sessionFile! }))}
                onSessionFile={saveSessionFile}
                onFirstMessage={saveTitle}
                onRuntimeSettings={saveRuntimeSettings}
                onAgentRunning={saveAgentRunning}
                onUnread={markUnread}
                onClose={() => closeTab(tab.id)}
                onToast={addToast}
                initialPrompt={tab.initialPrompt}
                onInitialPromptConsumed={() => setTabs((prev) => prev.map((item) => item.id === tab.id ? { ...item, initialPrompt: undefined } : item))}
                onOpenPipeline={() => { setSelectedProject(tab.project); setDashboard("pipeline"); }}
                onOpenResearch={(runId) => { setResearchRunId(runId); setDashboard("research"); }}
                isActive={tab.id === activeTabId}
              />
            </div>
          )) : dashboard === null && (
            <div className="empty-state">
              <span className="empty-status"><i aria-hidden="true" /> Workspace idle</span>
              <strong>No active session</strong>
              <span>Open a project session or start Global Chat.</span>
              <div><button onClick={openGlobalChat}>Open Global Chat</button></div>
            </div>
          )}
        </div>
        <div className="toast-container">
          {toasts.map((toast, i) => (
            <div key={i} className="toast glass-surface" role="status">
              <span>{toast}</span>
              <button
                onClick={(e) => {
                  navigator.clipboard.writeText(toast).catch(() => {});
                  const btn = e.currentTarget;
                  const original = btn.textContent;
                  btn.textContent = "✓";
                  setTimeout(() => { if (btn) btn.textContent = original; }, 1200);
                }}
                title="Copy toast"
                aria-label="Copy toast"
              >⧉</button>
              <button
                onClick={() => setToasts((prev) => prev.filter((_, idx) => idx !== i))}
                title="Dismiss"
                aria-label="Dismiss toast"
                className="toast-close"
              >×</button>
            </div>
          ))}
        </div>
        {settingsOpen && <Suspense fallback={<div className="settings-backdrop"><div className="settings-loading" role="status">Loading settings…</div></div>}><SettingsPanel projectPath={settingsProject?.path ?? selectedProject?.path ?? activeTab?.project.path} projectName={settingsProject?.name ?? selectedProject?.name ?? activeTab?.project.name} initialPage={settingsPage} onClose={() => setSettingsOpen(false)} onToast={addToast} /></Suspense>}
      </section>
      <ConfirmHost />
    </main>
  );
}
