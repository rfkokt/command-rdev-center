import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type StageStatus = "pass" | "fail" | "skip" | "running" | "pending";
type Stage = { name: string; ms?: number; status: StageStatus; log?: string; attempts?: number };
type Run = { run_id: string; project: string; project_path?: string; project_type: string; date: string; status: string; commits?: string[]; stages: Stage[] };
type PipelineData = { runs: Run[]; current?: Run | null };

function runDate(value: string) {
  const date = /^\d+$/.test(value) ? new Date(Number(value) * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function duration(ms = 0) {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default function PipelineView({ projectPath, projectName }: { projectPath?: string; projectName?: string }) {
  const [data, setData] = useState<PipelineData>({ runs: [] });
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let loading = false;
    const load = () => {
      if (loading || document.hidden) return;
      loading = true;
      void invoke<PipelineData>("get_pipeline_data", { projectPath: projectPath ?? null }).then((pipeline) => {
        setData(pipeline);
        setError(null);
      }).catch((e) => setError(String(e))).finally(() => { loading = false; });
    };
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [projectPath]);

  const runs = data.current
    ? [data.current, ...data.runs.filter((run) => run.run_id !== data.current?.run_id).sort((a, b) => b.date.localeCompare(a.date))]
    : [...data.runs].sort((a, b) => b.date.localeCompare(a.date));
  const projectTypes = [...new Set(runs.map((run) => run.project_type))];

  const current = data.current;
  const start = async () => {
    if (!projectPath || starting) return;
    setStarting(true);
    setError(null);
    try {
      await invoke("start_pipeline", { projectPath, executionCwd: null });
      const pipeline = await invoke<PipelineData>("get_pipeline_data", { projectPath });
      setData(pipeline);
    } catch (e) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  };
  const control = (command: string) => {
    if (!projectPath) return;
    if (["cancel_pipeline", "skip_pipeline_step"].includes(command) && !window.confirm(command === "cancel_pipeline" ? "Cancel this pipeline?" : "Skip the failed step?")) return;
    void invoke(command, { projectPath }).catch((e) => setError(String(e)));
  };
  return <section className="pipeline-view">
    <header><div><small>APP-OWNED AUTOMATION</small><strong>PIPELINE</strong></div><div className="pipeline-actions">{projectPath && !current && <button onClick={() => void start()} disabled={starting}>{starting ? "STARTING…" : `RUN ${projectName ?? "PIPELINE"}`}</button>}{current && <><button onClick={() => control("cancel_pipeline")}>CANCEL</button>{current.stages.some((stage) => stage.status === "fail") && <><button onClick={() => control("retry_pipeline_step")}>RETRY</button><button onClick={() => control("skip_pipeline_step")}>SKIP</button></>}</>}</div><span>{runs.length} RUNS · LIVE REFRESH 3S</span></header>
    {error ? <p className="kanban-error">{error}</p> : !runs.length ? <div className="pipeline-empty">No pipeline runs yet.</div> : <div className="pipeline-scroll">
      {projectTypes.map((projectType) => {
        const typeRuns = runs.filter((run) => run.project_type === projectType);
        const columns = [...new Set(typeRuns.flatMap((run) => run.stages.map((stage) => stage.name)))];
        const completed = data.runs.filter((run) => run.project_type === projectType && ["done", "pass", "success"].includes(run.status.toLowerCase()));
        const averages = Object.fromEntries(columns.map((name) => {
          const times = completed.flatMap((run) => run.stages.filter((stage) => stage.name === name && stage.status === "pass" && stage.ms).map((stage) => stage.ms ?? 0));
          return [name, times.length ? times.reduce((sum, ms) => sum + ms, 0) / times.length : 0];
        }));
        return <table key={projectType} aria-label={`${projectType} pipeline`}>
          <thead><tr><th>{projectType}</th>{columns.map((name) => <th key={name}><strong>{name}</strong><small>AVG {duration(averages[name])}</small></th>)}</tr></thead>
          <tbody>{typeRuns.map((run) => <tr key={run.run_id}>
            <th><strong>{run.project}</strong><span>{runDate(run.date)}</span><small>{run.commits?.length ?? 0} COMMITS · {run.status}</small></th>
            {columns.map((name) => {
              const stage = run.stages.find((item) => item.name === name) ?? { name, status: "skip" as const };
              return <td key={name}><div className={`pipeline-stage ${stage.status}`} title={stage.log}><strong>{stage.status}</strong><span>{duration(stage.ms)}</span>{stage.attempts ? <small>{stage.attempts} TRY</small> : null}</div></td>;
            })}
          </tr>)}</tbody>
        </table>;
      })}
    </div>}
  </section>;
}
