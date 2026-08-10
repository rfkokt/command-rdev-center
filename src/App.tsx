import "@fontsource/jetbrains-mono/400.css";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { exit } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { onAction, registerActionTypes } from "@tauri-apps/plugin-notification";
import ProjectList, { type ProjectInfo } from "./components/ProjectList";
import ChatView from "./components/ChatView";
const SettingsPanel = lazy(() => import("./components/SettingsPanel"));
const KanbanBoard = lazy(() => import("./components/KanbanBoard"));
const PipelineView = lazy(() => import("./components/PipelineView"));
const RagKnowledge = lazy(() => import("./components/RagKnowledge"));
const DeepResearchView = lazy(() => import("./components/DeepResearchView"));
const DocumentaryView = lazy(() => import("./components/DocumentaryView"));
import "./App.css";
import "./core-workspace.css";
import "./application-redesign.css";

type Config = {
  pi_path: string;
  project_root: string;
  default_provider: string;
  default_model: string;
  default_thinking: string;
};

type Tab = { id: string; project: ProjectInfo; global?: boolean; title?: string; sessionFile?: string; model?: string; thinking?: string; interrupted?: boolean; unread?: number };
const GLOBAL_PROJECT: ProjectInfo = { name: "GLOBAL CHAT", path: "global", kinds: [], mtime_ms: 0, is_git: false };

const CHAT_TABS_KEY = "crc-chat-tabs";

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

  useEffect(() => {
    registerActionTypes([{ id: "agent-finished", actions: [{ id: "open", title: "Buka", foreground: true }] }]);
    const unlisten = onAction((notification) => {
      const chatId = notification.extra?.chatId as string | undefined;
      if (chatId) setActiveTabId(chatId);
    });
    return () => { void unlisten.then((listener) => listener.unregister()); };
  }, []);
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const [selectedProject, setSelectedProject] = useState<ProjectInfo | null>(null);
  const [toasts, setToasts] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<"pi" | "pipeline">("pi");
  const [settingsProject, setSettingsProject] = useState<ProjectInfo | null>(null);
  const [dashboard, setDashboard] = useState<"kanban" | "pipeline" | "knowledge" | "research" | "documentary" | null>(null);
  const [researchRunId, setResearchRunId] = useState<string | null>(null);
  const [documentaryResearch, setDocumentaryResearch] = useState<{ runId: string; query: string } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [availableVersion, setAvailableVersion] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(250);
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

  return (
    <main className={`app-shell ${sidebarOpen ? "" : "sidebar-hidden"}`}>
      <a className="skip-link" href="#workspace-content">Skip to workspace</a>
      <aside className="sidebar" aria-label="Projects and sessions" style={{ width: sidebarWidth, position: "relative" }}>
        <div
          style={{ position: "absolute", top: 0, right: -4, bottom: 0, width: 8, cursor: "col-resize", zIndex: 100 }}
          onPointerDown={(e) => {
            e.preventDefault();
            sidebarDragRef.current = { startX: e.clientX, startWidth: sidebarWidth };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!sidebarDragRef.current) return;
            const { startX, startWidth } = sidebarDragRef.current;
            setSidebarWidth(Math.max(180, Math.min(600, startWidth + (e.clientX - startX))));
          }}
          onPointerUp={(e) => {
            sidebarDragRef.current = null;
            e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onPointerCancel={(e) => {
            sidebarDragRef.current = null;
            e.currentTarget.releasePointerCapture(e.pointerId);
          }}
        />
        <div className="sidebar-brand">
          <span className="brand-mark">R/</span>
          <div><strong>COMMAND</strong><small>RDEV CENTER</small></div>
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
          onPipelineSettings={(project) => {
            setSelectedProject(project);
            setSettingsProject(project);
            setSettingsPage("pipeline");
            setSettingsOpen(true);
          }}
        />
        <div className="projects-panel">
          <div className="projects-heading"><span>Global chat</span><button onClick={newGlobalChat} title="New Global Chat" aria-label="New Global Chat">＋</button></div>
          <div className="project-sessions">
            <div>{tabs.filter((tab) => tab.global).map((tab) => <button key={tab.id} className={`conversation-row ${tab.id === activeTabId ? "active" : ""}`} onClick={() => { setDashboard(null); setSelectedProject(null); activateTab(tab.id); }}><span>{tab.title ?? "UNTITLED SESSION"}</span>{tab.interrupted ? <span className="agent-working-mark" aria-label="Agent working"><i /><i /><i /></span> : !!tab.unread && <span className="unread-badge" style={{ background: "var(--accent)", color: "#111", padding: "1px 5px", borderRadius: "8px", fontSize: "11px", fontWeight: "bold" }}>{tab.unread}</span>}</button>)}</div>
          </div>
          {tabs.every((tab) => !tab.global) && <button className="settings-button" onClick={openGlobalChat}><span>◉</span><span>OPEN GLOBAL CHAT</span></button>}
        </div>
        <nav className="sidebar-nav" aria-label="Workspace views">
          <div className="sidebar-nav-label">Global</div>
          <button title="Chat" className={`settings-button dashboard-button ${dashboard === null ? "active" : ""}`} aria-current={dashboard === null ? "page" : undefined} onClick={() => setDashboard(null)}>
            <span className="nav-glyph" aria-hidden="true">›_</span><span>Chat</span>
          </button>
          <button title="Deep Research" className={`settings-button dashboard-button ${dashboard === "research" ? "active" : ""}`} aria-current={dashboard === "research" ? "page" : undefined} onClick={() => setDashboard("research")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="settings-icon" aria-hidden><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M11 8v6M8 11h6"/></svg><span>Deep Research</span>
          </button>
          <button title="Knowledge" className={`settings-button dashboard-button ${dashboard === "knowledge" ? "active" : ""}`}  aria-current={dashboard === "knowledge" ? "page" : undefined} onClick={() => setDashboard("knowledge")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="settings-icon" aria-hidden><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5v-16Z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M8 7h8M8 11h6"/></svg>
            <span>Knowledge</span>
          </button>
          <button title="Documentary" className={`settings-button dashboard-button ${dashboard === "documentary" ? "active" : ""}`} aria-current={dashboard === "documentary" ? "page" : undefined} onClick={() => setDashboard("documentary")}>
            <span className="nav-glyph" aria-hidden="true">▣</span><span>Documentary</span>
          </button>
          <div className="sidebar-nav-label">Project operations</div>
          <button title="Tasks" aria-label="Kanban tasks" className={`settings-button ${dashboard === "kanban" ? "active" : ""}`} aria-current={dashboard === "kanban" ? "page" : undefined} onClick={() => setDashboard("kanban")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="settings-icon" aria-hidden><rect x="2.5" y="3" width="19" height="18" rx="2.5"/><rect x="6" y="7" width="3.5" height="10" rx="1"/><rect x="10.5" y="7" width="3.5" height="12" rx="1"/><rect x="15" y="7" width="3.5" height="7" rx="1"/></svg>
            <span>Tasks</span>
          </button>
          <button title="Pipeline" className={`settings-button dashboard-button ${dashboard === "pipeline" ? "active" : ""}`} aria-current={dashboard === "pipeline" ? "page" : undefined} onClick={() => setDashboard("pipeline")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="settings-icon" aria-hidden><circle cx="5" cy="6" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="18" r="2"/><path d="M6.5 7.5 10.5 10.5M13.5 13.5l4 3"/></svg>
            <span>Pipeline</span>
          </button>
          <div className="sidebar-nav-label">System</div>
          <button title="Settings" className="settings-button dashboard-button" onClick={() => { setSettingsProject(selectedProject ?? activeTab?.project ?? null); setSettingsPage("pi"); setSettingsOpen(true); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="settings-icon" aria-hidden><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 5 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>
            <span>Settings</span>
          </button>
        </nav>
        {appVersion && <small className="app-version">v{appVersion}</small>}
      </aside>

      <section className="workspace">
        <header className="app-toolbar">
          <button className="sidebar-toggle" onClick={() => setSidebarOpen((open) => !open)} title={sidebarOpen ? "Hide sidebar" : "Show sidebar"} aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}>☰</button>
          <div className="workspace-title">
            <span className="live-dot" aria-hidden="true" />
            <div><strong>{dashboard ?? activeTab?.project.name ?? "No project selected"}</strong><small>{activeTab ? "Local workspace · Ready" : "Local workspace · Idle"}</small></div>
          </div>
          <div className="toolbar-actions">
            <button className="toolbar-button toolbar-button-secondary" onClick={installUpdate} disabled={updating} aria-busy={updating} aria-label={updating ? "UPDATING" : availableVersion ? `UPDATE v${availableVersion}` : "CHECK UPDATE"}>
              <span>{updating ? "Updating…" : availableVersion ? `Update v${availableVersion}` : "Check update"}</span><b aria-hidden="true">↻</b>
            </button>
            <button className="toolbar-button toolbar-button-primary"><span>Open IDE</span><b aria-hidden="true">↗</b></button>
          </div>
        </header>

        <div className="workspace-body" id="workspace-content" tabIndex={-1}>
          {dashboard === "kanban" && <Suspense fallback={<div className="session-loading" role="status">Loading tasks…</div>}><KanbanBoard /></Suspense>}
          {dashboard === "pipeline" && <Suspense fallback={<div className="session-loading" role="status">Loading pipeline…</div>}><PipelineView projectPath={selectedProject?.path ?? activeTab?.project.path} projectName={selectedProject?.name ?? activeTab?.project.name} /></Suspense>}
          {dashboard === "knowledge" && <Suspense fallback={<div className="session-loading" role="status">Loading knowledge…</div>}><RagKnowledge onToast={addToast} /></Suspense>}
          {dashboard === "research" && <Suspense fallback={<div className="session-loading" role="status">Loading reports…</div>}><DeepResearchView initialRunId={researchRunId} onCreateDocumentary={(run) => { setDocumentaryResearch({ runId: run.id, query: run.query }); setDashboard("documentary"); }} /></Suspense>}
          {dashboard === "documentary" && <Suspense fallback={<div className="session-loading" role="status">Loading production packages…</div>}><DocumentaryView handoffResearchRunId={documentaryResearch?.runId} handoffResearchQuery={documentaryResearch?.query} onOpenDeepResearch={() => setDashboard("research")} /></Suspense>}
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
        <div className="toast-container" style={{ position: "fixed", bottom: 18, right: 18, display: "flex", flexDirection: "column", gap: 8, zIndex: 120 }}>
          {toasts.map((toast, i) => (
            <div key={i} className="toast" role="status" style={{ position: "relative", inset: "auto" }}>
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
    </main>
  );
}
