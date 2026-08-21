import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import ListPicker from "./ListPicker";
import { useModalFocus } from "./useModalFocus";
import { ChevronRightIcon, MenuDotsIcon, PlusIcon, SettingsIcon } from "./Icons";

export type ProjectInfo = {
  name: string;
  path: string;
  kinds: string[];
  mtime_ms: number;
  is_git: boolean;
  base_branch?: string;
  pipeline_type?: string;
  repositories?: ProjectInfo[];
};

type Tab = { id: string; project: ProjectInfo; title?: string; unread?: number; interrupted?: boolean };
type TaskSource = { type: "local" | "google_sheets"; url: string; pics: string[] };

export default function ProjectList({
  onOpen,
  onSelect,
  tabs,
  activeTabId,
  onResume,
  onPipelineSettings,
  onNewSession,
}: {
  onOpen: (project: ProjectInfo) => void;
  onSelect: (project: ProjectInfo) => void;
  tabs: Tab[];
  activeTabId: string | null;
  onResume: (id: string, project: ProjectInfo) => void;
  onPipelineSettings: (project: ProjectInfo) => void;
  onNewSession: (project: ProjectInfo) => void;
}) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [err, setErr] = useState<string | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [baseBranch, setBaseBranch] = useState("");
  const [projectToDelete, setProjectToDelete] = useState<ProjectInfo | null>(null);
  const [projectToEdit, setProjectToEdit] = useState<ProjectInfo | null>(null);
  const [taskSource, setTaskSource] = useState<TaskSource>({ type: "local", url: "", pics: [] });
  const [availablePics, setAvailablePics] = useState<string[]>([]);
  const [loadingPics, setLoadingPics] = useState(false);
  const registerDialogRef = useModalFocus<HTMLDivElement>(() => setPendingPath(null), Boolean(pendingPath));
  const settingsDialogRef = useModalFocus<HTMLDivElement>(() => setProjectToEdit(null), Boolean(projectToEdit));
  const removeDialogRef = useModalFocus<HTMLDivElement>(() => setProjectToDelete(null), Boolean(projectToDelete));

  useEffect(() => {
    invoke<ProjectInfo[]>("list_projects").then(setProjects).catch((e) => setErr(String(e)));
  }, []);

  async function addProject() {
    const path = await open({ directory: true, multiple: false, title: "Add Project" });
    if (!path) return;
    try {
      const discovered = await invoke<ProjectInfo[]>("discover_projects", { path });
      if (discovered.length > 1 || discovered[0]?.path !== path) {
        const workspace = await invoke<ProjectInfo>("add_workspace", { path });
        setProjects((prev) => [...prev.filter((item) => item.path !== workspace.path && !item.path.startsWith(`${workspace.path}/`)), workspace]);
        setErr(null);
        return;
      }
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
      const source = await invoke<TaskSource>("get_project_task_source", { path: project.path });
      setTaskSource(source);
      setAvailablePics(source.pics);
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

  async function loadPics() {
    if (!taskSource.url.trim()) return setErr("Google Sheets URL is required");
    setLoadingPics(true);
    try {
      const pics = await invoke<string[]>("list_google_sheet_pics", { url: taskSource.url });
      setAvailablePics(pics);
      setTaskSource((source) => ({ ...source, pics: source.pics.filter((pic) => pics.includes(pic)) }));
      setErr(null);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoadingPics(false);
    }
  }

  async function saveTaskSource() {
    if (!projectToEdit) return;
    try {
      setTaskSource(await invoke<TaskSource>("save_project_task_source", { path: projectToEdit.path, source: taskSource }));
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
      <div className="projects-heading"><span>Projects</span><button onClick={addProject} title="Add project" aria-label="Add project"><PlusIcon /></button></div>
      {err && <div className="sidebar-error">{err}</div>}
      {pendingPath && <div className="project-branch-backdrop" role="presentation">
        <div ref={registerDialogRef} className="project-branch-picker" role="dialog" aria-modal="true" aria-labelledby="base-branch-title" tabIndex={-1}>
          <small>REGISTER PROJECT</small>
          <strong id="base-branch-title">Choose base branch</strong>
          <span>{pendingPath}</span>
          <ListPicker label="BASE BRANCH" value={baseBranch} options={branches} includeAll={false} onChange={setBaseBranch} />
          <p>New chat worktrees and View Diff will use this branch.</p>
          <div><button onClick={() => registerProject()}>REGISTER</button><button onClick={() => setPendingPath(null)}>CANCEL</button></div>
        </div>
      </div>}
      {projectToEdit && <div className="project-branch-backdrop" role="presentation">
        <div ref={settingsDialogRef} className="project-branch-picker project-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-base-branch-title" tabIndex={-1}>
          <small>PROJECT SETTINGS</small>
          <strong id="edit-base-branch-title">{projectToEdit.name}</strong>
          <span>{projectToEdit.path}</span>
          {projectToEdit.is_git && <section><h3>GENERAL</h3><ListPicker label="BASE BRANCH" value={baseBranch} options={branches} includeAll={false} onChange={setBaseBranch} /><p>New chats use this branch. Existing chat baselines stay unchanged.</p><button className="project-save-branch" onClick={saveBaseBranch}>SAVE BRANCH</button></section>}
          <section className="project-task-source"><h3>TASK SOURCE</h3><ListPicker label="SOURCE" value={taskSource.type} options={["local", "google_sheets"]} includeAll={false} formatOption={(value) => value === "local" ? "Local JSON" : "Google Sheets · read-only"} onChange={(type) => setTaskSource({ ...taskSource, type: type as TaskSource["type"] })} />{taskSource.type === "google_sheets" && <><label><span>PUBLIC SHEET URL</span><input type="url" value={taskSource.url} onChange={(event) => setTaskSource({ ...taskSource, url: event.target.value })} placeholder="https://docs.google.com/spreadsheets/d/…/edit" /></label><button type="button" className="project-load-pics" disabled={loadingPics} onClick={loadPics}>{loadingPics ? "READING SHEET…" : "LOAD PIC"}</button>{availablePics.length > 0 && <fieldset className="project-pic-options"><legend>INCLUDE TASKS FOR</legend>{availablePics.map((pic) => <label key={pic}><input type="checkbox" checked={taskSource.pics.includes(pic)} onChange={(event) => setTaskSource((source) => ({ ...source, pics: event.target.checked ? [...source.pics, pic] : source.pics.filter((selected) => selected !== pic) }))} /><span>{pic}</span></label>)}</fieldset>}</>}<p>{taskSource.type === "local" ? "Use the existing local backlog file." : "Load the sheet, then select which PIC should appear in Kanban. No PIC selected means no tasks are imported."}</p><button className="project-save-task-source" onClick={saveTaskSource}>SAVE TASK SOURCE</button></section>
          <section><h3>PIPELINE</h3><p>Configure presets, commands, failure policies, and consult AI.</p><button className="project-open-pipeline" onClick={() => { const project = projectToEdit; setProjectToEdit(null); onPipelineSettings(project); }}>OPEN PIPELINE SETTINGS</button></section>
          <section className="project-danger-zone"><h3>DANGER ZONE</h3><p>Remove this registration only. Repository files remain untouched.</p><button onClick={() => { setProjectToDelete(projectToEdit); setProjectToEdit(null); }}>REMOVE PROJECT</button></section>
          <div className="project-dialog-actions"><button className="project-dialog-cancel" onClick={() => setProjectToEdit(null)}>CLOSE</button></div>
        </div>
      </div>}
      {projects.length === 0 && !err && <div className="project-empty">INDEX EMPTY</div>}
      {projectToDelete && <div className="project-branch-backdrop" role="presentation">
        <div ref={removeDialogRef} className="project-branch-picker project-remove-dialog" role="alertdialog" aria-modal="true" aria-labelledby="remove-project-title" tabIndex={-1}>
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
                <ChevronRightIcon className="chevron" /><span>{project.name}</span>
              </button>
              <details className="project-row-actions" onClick={(event) => event.stopPropagation()}>
                <summary title={`Actions for ${project.name}`} aria-label={`Actions for ${project.name}`}><MenuDotsIcon /></summary>
                <div className="project-row-menu">
                  <button onClick={(event) => { onNewSession(project); event.currentTarget.closest("details")?.removeAttribute("open"); }}><PlusIcon /><span>New session</span></button>
                  <button onClick={(event) => { void editBaseBranch(project); event.currentTarget.closest("details")?.removeAttribute("open"); }}><SettingsIcon /><span>Project settings</span></button>
                </div>
              </details>
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
                    {tab.interrupted ? <span className="agent-working-mark" aria-label="Agent working"><i /><i /><i /></span> : !!tab.unread && <span className="unread-badge">{tab.unread}</span>}
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
