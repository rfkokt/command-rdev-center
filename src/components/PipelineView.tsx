import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type StageStatus = "pass" | "fail" | "skip" | "running" | "pending";
type Stage = { name: string; ms?: number; status: StageStatus };
type Run = { run_id: string; project: string; project_type: string; date: string; status: string; commits?: string[]; stages: Stage[] };
type PipelineData = { runs: Run[]; current?: Run | null };
type RegisteredProject = { name: string };

function duration(ms = 0) {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default function PipelineView() {
  const [data, setData] = useState<PipelineData>({ runs: [] });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => Promise.all([
      invoke<PipelineData>("get_pipeline_data"),
      invoke<RegisteredProject[]>("list_projects"),
    ]).then(([pipeline, projects]) => {
      const registered = new Set(projects.map(({ name }) => name.toLowerCase()));
      setData({
        runs: pipeline.runs.filter(({ project }) => registered.has(project.toLowerCase())),
        current: pipeline.current && registered.has(pipeline.current.project.toLowerCase()) ? pipeline.current : null,
      });
      setError(null);
    }).catch((e) => setError(String(e)));
    void load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, []);

  const runs = data.current ? [data.current, ...data.runs.filter((run) => run.run_id !== data.current?.run_id)] : data.runs;
  const columns = [...new Set(runs.flatMap((run) => run.stages.map((stage) => stage.name)))];
  const averages = Object.fromEntries(columns.map((name) => {
    const times = data.runs.flatMap((run) => run.stages.filter((stage) => stage.name === name && stage.ms).map((stage) => stage.ms ?? 0));
    return [name, times.length ? times.reduce((sum, ms) => sum + ms, 0) / times.length : 0];
  }));

  return <section className="pipeline-view">
    <header><div><small>PUSH OPERATIONS</small><strong>PIPELINE</strong></div><span>{runs.length} RUNS · LIVE REFRESH 3S</span></header>
    {error ? <p className="kanban-error">{error}</p> : !runs.length ? <div className="pipeline-empty">No pipeline runs yet.</div> : <div className="pipeline-scroll">
      <table>
        <thead><tr><th>Run</th>{columns.map((name) => <th key={name}><strong>{name}</strong><small>AVG {duration(averages[name])}</small></th>)}</tr></thead>
        <tbody>{runs.map((run) => <tr key={run.run_id}>
          <th><strong>{run.project}</strong><span>{run.project_type} · {new Date(run.date).toLocaleString()}</span><small>{run.commits?.length ?? 0} COMMITS · {run.status}</small></th>
          {columns.map((name) => {
            const stage = run.stages.find((item) => item.name === name) ?? { name, status: "skip" as const };
            return <td key={name}><div className={`pipeline-stage ${stage.status}`}><strong>{stage.status}</strong><span>{duration(stage.ms)}</span></div></td>;
          })}
        </tr>)}</tbody>
      </table>
    </div>}
  </section>;
}
