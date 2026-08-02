import "@fontsource/jetbrains-mono/400.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { exit } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { onAction, registerActionTypes } from "@tauri-apps/plugin-notification";
import ProjectList, { type ProjectInfo } from "./components/ProjectList";
import ChatView from "./components/ChatView";
import SettingsPanel from "./components/SettingsPanel";
import KanbanBoard from "./components/KanbanBoard";
import PipelineView from "./components/PipelineView";
import RagKnowledge from "./components/RagKnowledge";
import "./App.css";

type Config = {
  pi_path: string;
  project_root: string;
  default_provider: string;
  default_model: string;
  default_thinking: string;
};

type Tab = { id: string; project: ProjectInfo; global?: boolean; title?: string; sessionFile?: string; model?: string; thinking?: string; interrupted?: boolean; unread?: boolean };
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
  const [dashboard, setDashboard] = useState<"kanban" | "pipeline" | "knowledge" | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [availableVersion, setAvailableVersion] = useState("");

  const addToast = useCallback((msg: string) => {
    setToasts((prev) => [...prev, msg].slice(-6));
    setTimeout(() => setToasts((prev) => prev.slice(1)), 6000);
  }, []);

  useEffect(() => {
    invoke<Config>("get_config").catch((e) => setConfigErr(String(e)));
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
    setTabs((prev) => prev.map((item) => item.id === tabId && item.id !== activeTabIdRef.current ? { ...item, unread: true } : item));
  }, []);

  function activateTab(tabId: string) {
    setTabs((prev) => prev.map((item) => item.id === tabId ? { ...item, unread: false } : item));
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
    const id = `global-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setTabs((prev) => [...prev, { id, project: GLOBAL_PROJECT, global: true }]);
    setActiveTabId(id);
  }

  function openGlobalChat() {
    setDashboard(null);
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
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark">R/</span>
          <div><strong>COMMAND</strong><small>RDEV CENTER</small></div>
        </div>
        <button className="sidebar-action" onClick={() => activeTab?.global ? newGlobalChat() : newConversation()} disabled={!activeTab?.global && !selectedProject}>
          <span>＋</span> NEW SESSION
        </button>
        <div className="sidebar-label"><span>SESSION ARCHIVE</span><i /></div>
        {configErr && <div className="sidebar-error">Config error: {configErr}</div>}
        <ProjectList
          onOpen={openProject}
          onSelect={setSelectedProject}
          tabs={tabs.filter((tab) => !tab.global)}
          activeTabId={activeTabId}
          onResume={(id, project) => { setDashboard(null); setSelectedProject(project); activateTab(id); }}
          onPipelineSettings={(project) => {
            setSelectedProject(project);
            setSettingsProject(project);
            setSettingsPage("pipeline");
            setSettingsOpen(true);
          }}
        />
        <div className="projects-panel">
          <div className="projects-heading"><span>GLOBAL CHAT</span><button onClick={newGlobalChat} title="New Global Chat">＋</button></div>
          <div className="project-sessions">
            <div>{tabs.filter((tab) => tab.global).map((tab) => <button key={tab.id} className={`conversation-row ${tab.id === activeTabId ? "active" : ""}`} onClick={() => { setDashboard(null); activateTab(tab.id); }}><span>{tab.title ?? "UNTITLED SESSION"}</span>{tab.interrupted ? <span className="agent-working-mark" aria-label="Agent working"><i /><i /><i /></span> : tab.unread && <i aria-label="Unread activity" />}</button>)}</div>
          </div>
          {tabs.every((tab) => !tab.global) && <button className="settings-button" onClick={openGlobalChat}><span>◉</span><span>OPEN GLOBAL CHAT</span></button>}
        </div>
        <button className="settings-button dashboard-button" onClick={() => setDashboard((view) => view === "knowledge" ? null : "knowledge")}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="settings-icon" aria-hidden><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5v-16Z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M8 7h8M8 11h6"/></svg><span>{dashboard === "knowledge" ? "Sessions" : "Knowledge"}</span></button>
        <button className="settings-button" onClick={() => setDashboard((view) => view === "kanban" ? null : "kanban")}> 
          {dashboard === "kanban" ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="settings-icon" aria-hidden><rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M7 8h5M7 12h5M7 16h5"/><path d="M14 12h3" opacity=".6"/></svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="settings-icon" aria-hidden><rect x="2.5" y="3" width="19" height="18" rx="2.5"/><rect x="6" y="7" width="3.5" height="10" rx="1"/><rect x="10.5" y="7" width="3.5" height="12" rx="1"/><rect x="15" y="7" width="3.5" height="7" rx="1"/></svg>
          )}
          <span>{dashboard === "kanban" ? "Sessions" : "Kanban"}</span>
        </button>
        <button className="settings-button dashboard-button" onClick={() => setDashboard((view) => view === "pipeline" ? null : "pipeline")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="settings-icon" aria-hidden><circle cx="5" cy="6" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="18" r="2"/><path d="M6.5 7.5 10.5 10.5M13.5 13.5l4 3"/></svg>
          <span>{dashboard === "pipeline" ? "Sessions" : "Pipeline"}</span>
        </button>
        <button className="settings-button dashboard-button" onClick={() => { setSettingsProject(selectedProject ?? activeTab?.project ?? null); setSettingsPage("pi"); setSettingsOpen(true); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="settings-icon" aria-hidden><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 5 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>
          <span>Settings</span>
        </button>
        {appVersion && <small className="app-version">v{appVersion}</small>}
      </aside>

      <section className="workspace">
        <header className="app-toolbar">
          <button className="sidebar-toggle" onClick={() => setSidebarOpen((open) => !open)} title={sidebarOpen ? "Hide sidebar" : "Show sidebar"} aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}>☰</button>
          <div className="workspace-title">
            <span className="live-dot" />
            <div><strong>{dashboard?.toUpperCase() ?? activeTab?.project.name ?? "NO PROJECT SELECTED"}</strong><small>LOCAL WORKSPACE</small></div>
          </div>
          <div className="toolbar-actions">
            <button className="open-ide" onClick={installUpdate} disabled={updating}>
              <span>{updating ? "UPDATING…" : availableVersion ? `UPDATE v${availableVersion}` : "CHECK UPDATE"}</span><b>↻</b>
            </button>
            <button className="open-ide"><span>OPEN IDE</span><b>↗</b></button>
          </div>
        </header>

        <div className="workspace-body">
          {dashboard === "kanban" && <KanbanBoard />}
          {dashboard === "pipeline" && <PipelineView projectPath={selectedProject?.path ?? activeTab?.project.path} projectName={selectedProject?.name ?? activeTab?.project.name} />}
          {dashboard === "knowledge" && <RagKnowledge onToast={addToast} />}
          {activeTab ? tabs.map((tab) => (
            <div key={tab.id} className="chat-session" hidden={dashboard !== null || tab.id !== activeTabId}>
              <ChatView
                projectPath={tab.project.path}
                projectName={tab.project.name}
                isGit={tab.project.is_git}
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
                isActive={tab.id === activeTabId}
              />
            </div>
          )) : dashboard === null && (
            <div className="empty-state">
              <span className="empty-index">00</span>
              <strong>NO ACTIVE SESSION</strong>
              <span>Add a project, or open Global Chat.</span>
            </div>
          )}
        </div>
        {toasts[toasts.length - 1] && <div className="toast" role="status">
          <span>{toasts[toasts.length - 1]}</span>
          <button
            onClick={() => navigator.clipboard.writeText(toasts[toasts.length - 1]).then(() => addToast("Toast copied")).catch((e) => addToast(`Copy failed: ${String(e)}`))}
            title="Copy toast"
            aria-label="Copy toast"
          >⧉</button>
        </div>}
        {settingsOpen && <SettingsPanel projectPath={settingsProject?.path ?? selectedProject?.path ?? activeTab?.project.path} projectName={settingsProject?.name ?? selectedProject?.name ?? activeTab?.project.name} initialPage={settingsPage} onClose={() => setSettingsOpen(false)} onToast={addToast} />}
      </section>
    </main>
  );
}
