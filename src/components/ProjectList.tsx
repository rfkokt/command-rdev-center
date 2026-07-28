import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import ListPicker from "./ListPicker";

export type ProjectInfo = {
  name: string;
  path: string;
  kinds: string[];
  mtime_ms: number;
  is_git: boolean;
  base_branch?: string;
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
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [baseBranch, setBaseBranch] = useState("");
  const [projectToDelete, setProjectToDelete] = useState<ProjectInfo | null>(null);
  const [projectToEdit, setProjectToEdit] = useState<ProjectInfo | null>(null);

  useEffect(() => {
    invoke<ProjectInfo[]>("list_projects").then(setProjects).catch((e) => setErr(String(e)));
  }, []);

  async function addProject() {
    const path = await open({ directory: true, multiple: false, title: "Add Project" });
    if (!path) return;
    try {
      const nextBranches = await invoke<string[]>("list_project_branches", { path });
      if (nextBranches.length === 0) return registerProject(path);
      setPendingPath(path);
      setBranches(nextBranches);
      setBaseBranch(nextBranches.includes("main") ? "main" : nextBranches[0]);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }

  async function registerProject(path = pendingPath) {
    if (!path) return;
    try {
      const project = await invoke<ProjectInfo>("add_project", { path, baseBranch: baseBranch || null });
      setProjects((prev) => [...prev.filter((item) => item.path !== project.path), project]);
      setPendingPath(null);
      setBranches([]);
      setBaseBranch("");
      onOpen(project);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }

  async function editBaseBranch(project: ProjectInfo) {
    try {
      const nextBranches = await invoke<string[]>("list_project_branches", { path: project.path });
      setBranches(nextBranches);
      setBaseBranch(project.base_branch ?? nextBranches[0] ?? "");
      setProjectToEdit(project);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }

  async function saveBaseBranch() {
    if (!projectToEdit || !baseBranch) return;
    try {
      const project = await invoke<ProjectInfo>("update_project_base_branch", { path: projectToEdit.path, baseBranch });
      setProjects((prev) => prev.map((item) => item.path === project.path ? project : item));
      setProjectToEdit(null);
      setBranches([]);
      setBaseBranch("");
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }

  async function removeProject() {
    if (!projectToDelete) return;
    try {
      await invoke("remove_project", { path: projectToDelete.path });
      setProjects((prev) => prev.filter((item) => item.path !== projectToDelete.path));
      setProjectToDelete(null);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }

  return (
    <div className="projects-panel">
      <div className="projects-heading"><span>PROJECT INDEX</span><button onClick={addProject} title="Add project">＋</button></div>
      {err && <div className="sidebar-error">{err}</div>}
      {pendingPath && <div className="project-branch-backdrop" role="presentation">
        <div className="project-branch-picker" role="dialog" aria-modal="true" aria-labelledby="base-branch-title">
          <small>REGISTER PROJECT</small>
          <strong id="base-branch-title">Choose base branch</strong>
          <span>{pendingPath}</span>
          <ListPicker label="BASE BRANCH" value={baseBranch} options={branches} includeAll={false} onChange={setBaseBranch} />
          <p>New chat worktrees and View Diff will use this branch.</p>
          <div><button onClick={() => registerProject()}>REGISTER</button><button onClick={() => setPendingPath(null)}>CANCEL</button></div>
        </div>
      </div>}
      {projectToEdit && <div className="project-branch-backdrop" role="presentation">
        <div className="project-branch-picker" role="dialog" aria-modal="true" aria-labelledby="edit-base-branch-title">
          <small>PROJECT SETTINGS</small>
          <strong id="edit-base-branch-title">Change base branch</strong>
          <span>{projectToEdit.path}</span>
          <ListPicker label="BASE BRANCH" value={baseBranch} options={branches} includeAll={false} onChange={setBaseBranch} />
          <p>New chats use this branch. Existing chat baselines stay unchanged.</p>
          <div className="project-dialog-actions"><button className="project-save-branch" onClick={saveBaseBranch}>SAVE BRANCH</button><button className="project-dialog-cancel" onClick={() => setProjectToEdit(null)}>CANCEL</button></div>
        </div>
      </div>}
      {projects.length === 0 && !err && <div className="project-empty">INDEX EMPTY</div>}
      {projectToDelete && <div className="project-branch-backdrop" role="presentation">
        <div className="project-branch-picker project-remove-dialog" role="alertdialog" aria-modal="true" aria-labelledby="remove-project-title">
          <small>PROJECT INDEX / DESTRUCTIVE ACTION</small>
          <strong id="remove-project-title">Remove {projectToDelete.name}?</strong>
          <span>{projectToDelete.path}</span>
          <p><b>Repository files are safe.</b> This only removes the project registration and its base-branch setting.</p>
          <div className="project-dialog-actions"><button className="project-remove-confirm" onClick={removeProject}>REMOVE PROJECT</button><button className="project-dialog-cancel" onClick={() => setProjectToDelete(null)}>CANCEL</button></div>
        </div>
      </div>}
      {projects.map((project) => {
        const projectTabs = tabs.filter((tab) => tab.project.path === project.path);
        const isCollapsed = collapsed.has(project.path);
        return (
          <div className="project-group" key={project.path}>
            <div className="project-row-wrap">
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
              {project.is_git && <button className="project-branch-edit" onClick={() => editBaseBranch(project)} title={`Base branch: ${project.base_branch ?? "not set"}`} aria-label={`Change base branch for ${project.name}`}>⑂</button>}
              <button className="project-delete" onClick={() => setProjectToDelete(project)} title={`Remove ${project.name}`} aria-label={`Remove ${project.name}`}>×</button>
            </div>
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
