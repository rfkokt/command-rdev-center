import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ListPicker from "./ListPicker";

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

  async function moveTask(project: string, taskIndex: number, status: string) {
    const previous = projects;
    const next = projects.map((entry) => entry.project === project
      ? { ...entry, tasks: entry.tasks.map((task, index) => index === taskIndex ? { ...task, status } : task) }
      : entry);
    setProjects(next);
    setError(null);
    try {
      await invoke("save_kanban_tasks", { project, tasks: next.find((entry) => entry.project === project)?.tasks ?? [] });
    } catch (error) {
      setProjects(previous);
      setError(String(error));
    }
  }

  const allTasks = projects.flatMap(({ project, tasks }) => tasks.map((task, taskIndex) => ({ ...task, project, taskIndex })));
  const pics = [...new Set(allTasks.map((task) => task.pic?.trim()).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b));
  const tasks = allTasks.filter((task) => (!projectFilter || task.project === projectFilter) && (!picFilter || task.pic?.trim() === picFilter));

  return <section className="kanban-board">
    <header>
      <div><small>LOCAL BACKLOG</small><strong>KANBAN</strong></div>
      <div className="kanban-filters">
        <ListPicker label="Project" value={projectFilter} options={projects.map(({ project }) => project)} onChange={setProjectFilter} />
        <ListPicker label="PIC" value={picFilter} options={pics} onChange={setPicFilter} />
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
            <select className="themed-select" value={task.status || column} onChange={(event) => void moveTask(task.project, task.taskIndex, event.target.value)} aria-label={`Status for task ${task.no ?? ""}`}>
              {COLUMNS.map((status) => <option key={status}>{status}</option>)}
            </select>
            <footer><span>{task.pic || "Unassigned"}</span>{task.url && <a href={task.url} target="_blank" rel="noreferrer" aria-label={`Open task ${task.no ?? ""}`}>↗</a>}</footer>
          </article>)}</div>
        </section>;
      })}
    </div>}
  </section>;
}
