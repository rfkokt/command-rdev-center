import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ListPicker from "./ListPicker";
import MarkdownMessage from "./MarkdownMessage";
import { useModalFocus } from "./useModalFocus";

type Task = { no?: string | number; url?: string; deskripsi?: string; pic?: string; status?: string; notes?: string };
type KanbanProject = { project: string; tasks: Task[]; read_only?: boolean; error?: string };

const LOCAL_COLUMNS = ["Backlog", "In Progress", "Review", "Done"] as const;
const SHEET_STATUS_ORDER = ["Pending", "To Do", "On Progress", "Testing", "Done", "Backlog"];

export default function KanbanBoard({ projectName, onWorkTask }: { projectName?: string; onWorkTask?: (task: Task) => void }) {
  const [projects, setProjects] = useState<KanbanProject[]>([]);
  const [projectFilter, setProjectFilter] = useState("");
  const [picFilter, setPicFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selectedTask, setSelectedTask] = useState<(Task & { project: string; readOnly?: boolean }) | null>(null);
  const detailRef = useModalFocus<HTMLElement>(() => setSelectedTask(null), Boolean(selectedTask));

  useEffect(() => {
    let loading = false;
    const load = () => {
      if (loading || document.hidden) return;
      loading = true;
      void invoke<KanbanProject[]>("list_kanban_tasks").then((tasks) => {
        setProjects(tasks);
        setError(null);
      }).catch((e) => setError(String(e))).finally(() => { loading = false; setLoaded(true); });
    };
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, []);

  async function moveTask(project: string, taskIndex: number, status: string) {
    const previous = projects;
    const taskNo = projects.find((entry) => entry.project === project)?.tasks[taskIndex]?.no;
    if (taskNo == null) return setError("Task has no stable number");
    const next = projects.map((entry) => entry.project === project
      ? { ...entry, tasks: entry.tasks.map((task, index) => index === taskIndex ? { ...task, status } : task) }
      : entry);
    setProjects(next);
    setError(null);
    try {
      await invoke("update_kanban_task_status", { project, taskNo, status });
    } catch (error) {
      setProjects(previous);
      setError(String(error));
    }
  }

  const sourceErrors = projects.filter((project) => project.error);
  const allTasks = projects.flatMap(({ project, tasks, read_only }) => tasks.map((task, taskIndex) => ({ ...task, project, taskIndex, readOnly: read_only })));
  const pics = [...new Set(allTasks.map((task) => task.pic?.trim()).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b));
  const effectiveProject = projectName || projectFilter;
  const tasks = allTasks.filter((task) => (!effectiveProject || task.project === effectiveProject) && (!picFilter || task.pic?.trim() === picFilter));
  const sheetStatuses = [...new Set(allTasks.filter((task) => task.readOnly).map((task) => task.status?.trim()).filter(Boolean) as string[])];
  const columns = [...LOCAL_COLUMNS.filter((status) => allTasks.some((task) => !task.readOnly && task.status?.trim().toLowerCase() === status.toLowerCase()) || status === "Backlog"), ...sheetStatuses]
    .filter((status, index, values) => values.findIndex((value) => value.toLowerCase() === status.toLowerCase()) === index)
    .sort((left, right) => {
      const leftIndex = SHEET_STATUS_ORDER.findIndex((status) => status.toLowerCase() === left.toLowerCase());
      const rightIndex = SHEET_STATUS_ORDER.findIndex((status) => status.toLowerCase() === right.toLowerCase());
      return (leftIndex < 0 ? 100 : leftIndex) - (rightIndex < 0 ? 100 : rightIndex) || left.localeCompare(right);
    });

  return <section className="kanban-board">
    <header>
      <div><small>PROJECT OPERATIONS</small><strong>Tasks</strong></div>
      <div className="kanban-filters">
        {!projectName && <ListPicker label="Project" value={projectFilter} options={projects.map(({ project }) => project)} onChange={setProjectFilter} />}
        <ListPicker label="PIC" value={picFilter} options={pics} onChange={setPicFilter} />
      </div>
      <span>{tasks.length} / {allTasks.length} tasks · {projects.length} projects</span>
    </header>
    {!loaded ? <div className="pipeline-project-empty" role="status"><strong>Loading tasks</strong><span>Reading configured project backlogs…</span></div> : error ? <p className="kanban-error" role="alert">{error}</p> : <>{sourceErrors.length > 0 && <div className="kanban-source-errors" role="status">{sourceErrors.map((project) => <span key={project.project}><strong>{project.project}</strong>: {project.error}</span>)}</div>}{allTasks.length === 0 ? <div className="pipeline-project-empty"><strong>No tasks yet</strong><span>Backlog items from configured projects will appear here.</span></div> : tasks.length === 0 ? <div className="pipeline-project-empty"><strong>No matching tasks</strong><span>Clear one or more filters to restore the board.</span></div> : <div className="kanban-columns">
      {columns.map((column) => {
        const items = tasks.filter((task) => task.status?.trim().toLowerCase() === column.toLowerCase());
        const statusClass = column.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        return <section className={`kanban-column kanban-${statusClass}`} key={column}>
          <header><strong>{column}</strong><span>{items.length}</span></header>
          <div>{items.map((task, index) => <article className="kanban-card" key={`${task.project}-${task.no ?? index}`} tabIndex={0} role="button" aria-label={`Open task ${task.no ?? ""}: ${task.deskripsi || "Untitled task"}`} onClick={() => setSelectedTask(task)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedTask(task); } }}>
            <small>{task.project} · #{task.no ?? "—"}{task.readOnly ? " · Google Sheets" : ""}</small>
            <strong>{task.deskripsi || "Untitled task"}</strong>
            {task.readOnly ? <span className="kanban-readonly-status" title="Google Sheets tasks are read-only">{task.status || column}<small>READ ONLY</small></span> : <div onClick={(event) => event.stopPropagation()}><ListPicker label="Status" value={task.status || column} options={[...LOCAL_COLUMNS]} includeAll={false} onChange={(status) => void moveTask(task.project, task.taskIndex, status)} /></div>}
            <footer><span>{task.pic || "Unassigned"}</span>{task.url && <a href={task.url} target="_blank" rel="noreferrer" aria-label={`Open task ${task.no ?? ""}`}>↗</a>}</footer>
          </article>)}</div>
        </section>;
      })}
    </div>}</>}
    {selectedTask && <div className="kanban-detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedTask(null); }}><section ref={detailRef} className="kanban-detail" role="dialog" aria-modal="true" aria-labelledby="kanban-detail-title" tabIndex={-1}><header><div><small>{selectedTask.project} · #{selectedTask.no ?? "—"}{selectedTask.readOnly ? " · Google Sheets" : ""}</small><strong id="kanban-detail-title">Task detail</strong></div><button onClick={() => setSelectedTask(null)} aria-label="Close task detail">×</button></header><div className="kanban-detail-content"><MarkdownMessage>{selectedTask.deskripsi || "Untitled task"}</MarkdownMessage></div>{selectedTask.notes && <section><small>NOTES</small><p>{selectedTask.notes}</p></section>}<footer><span>{selectedTask.pic || "Unassigned"}</span><span>{selectedTask.status || "No status"}</span>{selectedTask.url && <a href={selectedTask.url} target="_blank" rel="noreferrer">Open source ↗</a>}{onWorkTask && <button className="kanban-work-task" onClick={() => onWorkTask(selectedTask)}>Work on this task</button>}</footer></section></div>}
  </section>;
}
