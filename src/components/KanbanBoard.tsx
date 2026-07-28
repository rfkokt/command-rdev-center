import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Task = { no?: string | number; url?: string; deskripsi?: string; pic?: string; status?: string; notes?: string };
type KanbanProject = { project: string; tasks: Task[] };

const COLUMNS = ["Backlog", "In Progress", "Review", "Done"] as const;

export default function KanbanBoard() {
  const [projects, setProjects] = useState<KanbanProject[]>([]);
  const [projectFilter, setProjectFilter] = useState("");
  const [picFilter, setPicFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<KanbanProject[]>("list_kanban_tasks").then(setProjects).catch((e) => setError(String(e)));
  }, []);

  const allTasks = projects.flatMap(({ project, tasks }) => tasks.map((task) => ({ ...task, project })));
  const pics = [...new Set(allTasks.map((task) => task.pic?.trim()).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b));
  const tasks = allTasks.filter((task) => (!projectFilter || task.project === projectFilter) && (!picFilter || task.pic?.trim() === picFilter));

  return <section className="kanban-board">
    <header>
      <div><small>LOCAL BACKLOG</small><strong>KANBAN</strong></div>
      <div className="kanban-filters">
        <label>Project<select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="">All</option>{projects.map(({ project }) => <option key={project}>{project}</option>)}</select></label>
        <label>PIC<select value={picFilter} onChange={(event) => setPicFilter(event.target.value)}><option value="">All</option>{pics.map((pic) => <option key={pic}>{pic}</option>)}</select></label>
      </div>
      <span>{tasks.length} / {allTasks.length} TASKS · {projects.length} PROJECTS</span>
    </header>
    {error ? <p className="kanban-error">{error}</p> : <div className="kanban-columns">
      {COLUMNS.map((column) => {
        const items = tasks.filter((task) => task.status?.trim().toLowerCase() === column.toLowerCase());
        return <section className="kanban-column" key={column}>
          <header><strong>{column}</strong><span>{items.length}</span></header>
          <div>{items.map((task, index) => <article className="kanban-card" key={`${task.project}-${task.no ?? index}`}>
            <small>{task.project} · #{task.no ?? "—"}</small>
            <strong>{task.deskripsi || "Untitled task"}</strong>
            <footer><span>{task.pic || "Unassigned"}</span>{task.url && <a href={task.url} target="_blank" rel="noreferrer" aria-label={`Open task ${task.no ?? ""}`}>↗</a>}</footer>
          </article>)}</div>
        </section>;
      })}
    </div>}
  </section>;
}
