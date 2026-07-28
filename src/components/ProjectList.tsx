import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export type ProjectInfo = {
  name: string;
  path: string;
  kinds: string[];
  mtime_ms: number;
  is_git: boolean;
};

type Tab = { id: string; project: ProjectInfo; title?: string };

export default function ProjectList({
  onOpen,
  onSelect,
  tabs,
  activeTabId,
  onResume,
}: {
  onOpen: (project: ProjectInfo) => void;
  onSelect: (project: ProjectInfo) => void;
  tabs: Tab[];
  activeTabId: string | null;
  onResume: (id: string, project: ProjectInfo) => void;
}) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    invoke<ProjectInfo[]>("list_projects").then(setProjects).catch((e) => setErr(String(e)));
  }, []);

  async function addProject() {
    const path = await open({ directory: true, multiple: false, title: "Add Project" });
    if (!path) return;
    try {
      const project = await invoke<ProjectInfo>("add_project", { path });
      setProjects((prev) => prev.some((item) => item.path === project.path) ? prev : [...prev, project]);
      onOpen(project);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }

  return (
    <div className="projects-panel">
      <div className="projects-heading"><span>PROJECT INDEX</span><button onClick={addProject} title="Add project">＋</button></div>
      {err && <div className="sidebar-error">{err}</div>}
      {projects.length === 0 && !err && <div className="project-empty">INDEX EMPTY</div>}
      {projects.map((project) => {
        const projectTabs = tabs.filter((tab) => tab.project.path === project.path);
        const isCollapsed = collapsed.has(project.path);
        return (
          <div className="project-group" key={project.path}>
            <button
              className="project-row"
              aria-expanded={!isCollapsed}
              onClick={() => {
                onSelect(project);
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(project.path)) next.delete(project.path); else next.add(project.path);
                  return next;
                });
              }}
            >
              <span className="chevron">›</span><span className="folder">▱</span><span>{project.name}</span>
            </button>
            <div className="project-sessions" data-collapsed={isCollapsed}>
              <div>
                {projectTabs.map((tab) => (
                  <button
                    key={tab.id}
                    className={`conversation-row ${tab.id === activeTabId ? "active" : ""}`}
                    onClick={() => onResume(tab.id, project)}
                  >
                    <span>{tab.title ?? "UNTITLED SESSION"}</span>
                    <i />
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
