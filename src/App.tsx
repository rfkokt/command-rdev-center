import "@fontsource/jetbrains-mono/400.css";
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ProjectList, { type ProjectInfo } from "./components/ProjectList";
import ChatView from "./components/ChatView";
import SettingsPanel from "./components/SettingsPanel";
import KanbanBoard from "./components/KanbanBoard";
import "./App.css";

type Config = {
  pi_path: string;
  project_root: string;
  default_provider: string;
  default_model: string;
  default_thinking: string;
};

type Tab = { id: string; project: ProjectInfo; title?: string; sessionFile?: string; model?: string; thinking?: string; interrupted?: boolean };

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
  const [selectedProject, setSelectedProject] = useState<ProjectInfo | null>(null);
  const [toasts, setToasts] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [kanbanOpen, setKanbanOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    invoke<Config>("get_config").catch((e) => setConfigErr(String(e)));
  }, []);

  useEffect(() => {
    localStorage.setItem(CHAT_TABS_KEY, JSON.stringify(tabs));
  }, [tabs]);

  const addToast = useCallback((msg: string) => {
    setToasts((prev) => [...prev, msg].slice(-6));
    setTimeout(() => setToasts((prev) => prev.slice(1)), 6000);
  }, []);

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

  function openProject(project: ProjectInfo) {
    setSelectedProject(project);
    const existing = tabs.find((tab) => tab.project.path === project.path);
    if (existing) return setActiveTabId(existing.id);
    newConversation(project);
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

  return (
    <main className={`app-shell ${sidebarOpen ? "" : "sidebar-hidden"}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark">R/</span>
          <div><strong>COMMAND</strong><small>RDEV CENTER</small></div>
        </div>
        <button className="sidebar-action" onClick={() => newConversation()} disabled={!selectedProject}>
          <span>＋</span> NEW SESSION
        </button>
        <div className="sidebar-label"><span>SESSION ARCHIVE</span><i /></div>
        {configErr && <div className="sidebar-error">Config error: {configErr}</div>}
        <ProjectList
          onOpen={openProject}
          onSelect={setSelectedProject}
          tabs={tabs}
          activeTabId={activeTabId}
          onResume={(id, project) => { setSelectedProject(project); setActiveTabId(id); }}
        />
        <button className="settings-button" onClick={() => setKanbanOpen((open) => !open)}>▦ <span>{kanbanOpen ? "Sessions" : "Kanban"}</span></button>
        <button className="settings-button" onClick={() => setSettingsOpen(true)}>⚙ <span>Settings</span></button>
      </aside>

      <section className="workspace">
        <header className="app-toolbar">
          <button className="sidebar-toggle" onClick={() => setSidebarOpen((open) => !open)} title={sidebarOpen ? "Hide sidebar" : "Show sidebar"} aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}>☰</button>
          <div className="workspace-title">
            <span className="live-dot" />
            <div><strong>{kanbanOpen ? "KANBAN" : activeTab?.project.name ?? "NO PROJECT SELECTED"}</strong><small>LOCAL WORKSPACE</small></div>
          </div>
          <button className="open-ide"><span>OPEN IDE</span><b>↗</b></button>
        </header>

        <div className="workspace-body">
          {kanbanOpen ? <KanbanBoard /> : activeTab ? tabs.map((tab) => (
            <div key={tab.id} className="chat-session" hidden={tab.id !== activeTabId}>
              <ChatView
                projectPath={tab.project.path}
                projectName={tab.project.name}
                isGit={tab.project.is_git}
                chatId={tab.id}
                sessionFile={tab.sessionFile}
                initialModel={tab.model}
                initialThinking={tab.thinking}
                initialInterrupted={tab.interrupted}
                onSessionFile={saveSessionFile}
                onFirstMessage={saveTitle}
                onRuntimeSettings={saveRuntimeSettings}
                onAgentRunning={saveAgentRunning}
                onClose={() => closeTab(tab.id)}
                onToast={addToast}
              />
            </div>
          )) : (
            <div className="empty-state">
              <span className="empty-index">00</span>
              <strong>NO ACTIVE SESSION</strong>
              <span>Add a project, then start a session.</span>
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
        {settingsOpen && <SettingsPanel projectPath={activeTab?.project.path} onClose={() => setSettingsOpen(false)} onToast={addToast} />}
      </section>
    </main>
  );
}
