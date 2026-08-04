import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type StageStatus = "pass" | "fail" | "skip" | "running" | "pending";
type Stage = { name: string; ms?: number; status: StageStatus; log?: string; attempts?: number };
type Run = { run_id: string; project: string; project_path?: string; project_type: string; date: string; status: string; commits?: string[]; stages: Stage[] };
type PipelinePendingInput = { nonce: string; run_id: string; step_id: string; mode: "ai_commit" | "confirm"; step: string; prompt: string; options: string[]; execution_cwd: string; initiator_session_id?: string | null };
type PipelineData = { runs: Run[]; current?: Run | null; pending_input?: PipelinePendingInput | null; sonar_phase?: string | null };

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
  const [inputValue, setInputValue] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let loading = false;
    let active = true;
    setLoaded(false);
    setData({ runs: [] });
    const load = () => {
      if (loading || document.hidden) return;
      loading = true;
      void invoke<PipelineData>("get_pipeline_data", { projectPath: projectPath ?? null }).then((pipeline) => {
        if (!active) return;
        setData(pipeline);
        setError(null);
      }).catch((e) => { if (active) setError(String(e)); }).finally(() => { if (active) { loading = false; setLoaded(true); } });
    };
    load();
    const timer = setInterval(load, 3000);
    return () => { active = false; clearInterval(timer); };
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
      await invoke("start_pipeline", { projectPath, executionCwd: null, initiatorSessionId: null });
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
  const pending = data.pending_input;
  const provide = () => {
    if (!projectPath || !pending || !inputValue) return;
    void invoke("provide_pipeline_input", { projectPath, input: { nonce: pending.nonce, runId: pending.run_id, stepId: pending.step_id, mode: pending.mode, sessionId: null, executionCwd: pending.execution_cwd, value: inputValue, message: null, paths: [] } }).then(() => setInputValue("")).catch((e) => setError(String(e)));
  };
  return <section className="pipeline-view">
    <header><div><small>{projectName ? `PROJECT · ${projectName}` : "PROJECT REQUIRED"}</small><strong>Pipeline</strong></div><div className="pipeline-actions">{projectPath && !current && <button onClick={() => void start()} disabled={starting}>{starting ? "STARTING…" : `RUN ${projectName ?? "PIPELINE"}`}</button>}{current && <><button onClick={() => control("cancel_pipeline")}>CANCEL</button>{current.stages.some((stage) => stage.status === "fail") && <><button onClick={() => control("retry_pipeline_step")}>RETRY</button><button onClick={() => control("skip_pipeline_step")}>SKIP</button></>}</>}</div><span>{runs.length} runs · live refresh 3s</span></header>
    {current && data.sonar_phase && <section className="sonar-progress" role="status" aria-live="polite"><span className="sonar-radar" aria-hidden="true"><i /><i /><b /></span><div><small>SONARQUBE QUALITY GATE</small><strong>{data.sonar_phase}</strong><span>Scan masih berjalan. Pipeline akan lanjut otomatis setelah Quality Gate selesai.</span></div><em>LIVE</em></section>}
    {pending && <section className="pipeline-input-prompt"><strong>{pending.step}</strong><span>{pending.mode === "ai_commit" ? "Open the matching project chat so AI can propose paths and a commit message." : pending.prompt}</span>{pending.mode === "confirm" && <div>{pending.options.map((option) => <button className={inputValue === option ? "active" : ""} onClick={() => setInputValue(option)} key={option}>{option}</button>)}<button onClick={provide} disabled={!inputValue}>CONFIRM</button></div>}</section>}
    {!loaded ? <div className="pipeline-project-empty"><strong>Loading pipeline</strong><span>Reading current run and local history…</span></div> : error ? <p className="kanban-error" role="alert">{error}</p> : !projectPath && !runs.length ? <div className="pipeline-project-empty"><strong>Choose a project</strong><span>Select a project session before opening its automation history.</span></div> : !runs.length ? <div className="pipeline-empty">No pipeline runs yet. Start the first run from this project.</div> : <div className="pipeline-scroll">
      {projectTypes.flatMap((projectType) => {
        const typeRuns = runs.filter((run) => run.project_type === projectType);
        const layouts = [...new Set(typeRuns.map((run) => run.stages.map((stage) => stage.name).join("\u0000")))];
        return layouts.map((layout, layoutIndex) => {
          const columns = layout ? layout.split("\u0000") : [];
          const layoutRuns = typeRuns.filter((run) => run.stages.map((stage) => stage.name).join("\u0000") === layout);
          const completed = data.runs.filter((run) => run.project_type === projectType && run.stages.map((stage) => stage.name).join("\u0000") === layout && ["done", "pass", "success"].includes(run.status.toLowerCase()));
          const averages = Object.fromEntries(columns.map((name) => {
            const times = completed.flatMap((run) => run.stages.filter((stage) => stage.name === name && stage.status === "pass" && stage.ms).map((stage) => stage.ms ?? 0));
            return [name, times.length ? times.reduce((sum, ms) => sum + ms, 0) / times.length : 0];
          }));
          return <table key={`${projectType}-${layout}`} aria-label={layoutIndex ? `${projectType} pipeline · alternate ${layoutIndex + 1}` : `${projectType} pipeline`}>
            <thead><tr><th>{projectType}</th>{columns.map((name) => <th key={name}><strong>{name}</strong><small>AVG {duration(averages[name])}</small></th>)}</tr></thead>
            <tbody>{layoutRuns.map((run) => <tr key={run.run_id}>
              <th><strong>{run.project}</strong><span>{runDate(run.date)}</span><small>{run.commits?.length ?? 0} COMMITS · {run.status}</small></th>
              {columns.map((name) => {
                const stage = run.stages.find((item) => item.name === name) ?? { name, status: "skip" as const };
                return <td key={name}><div className={`pipeline-stage ${stage.status}`} title={stage.log}><strong>{stage.status}</strong><span>{duration(stage.ms)}</span>{stage.attempts ? <small>{stage.attempts} TRY</small> : null}</div></td>;
              })}
            </tr>)}</tbody>
          </table>;
        });
      })}
    </div>}
  </section>;
}
