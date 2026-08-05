import type { ReactNode } from "react";
import type { ToolCall as TC } from "../lib/rpc";

function normalize(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
}

function JsonValue({ value }: { value: unknown }): ReactNode {
  const normalized = normalize(value);
  if (normalized === null) return <span className="json-null">null</span>;
  if (typeof normalized === "string") return <span className="json-string">{JSON.stringify(normalized)}</span>;
  if (typeof normalized === "number") return <span className="json-number">{normalized}</span>;
  if (typeof normalized === "boolean") return <span className="json-boolean">{String(normalized)}</span>;
  if (Array.isArray(normalized)) return <><span className="json-punctuation">[</span>{normalized.map((item, index) => <div className="json-indent" key={index}><JsonValue value={item} />{index < normalized.length - 1 && <span className="json-punctuation">,</span>}</div>)}<span className="json-punctuation">]</span></>;
  if (typeof normalized === "object") {
    const entries = Object.entries(normalized as Record<string, unknown>);
    return <><span className="json-punctuation">{"{"}</span>{entries.map(([key, item], index) => <div className="json-indent" key={key}><span className="json-key">{JSON.stringify(key)}</span><span className="json-punctuation">: </span><JsonValue value={item} />{index < entries.length - 1 && <span className="json-punctuation">,</span>}</div>)}<span className="json-punctuation">{"}"}</span></>;
  }
  return <span>{String(normalized)}</span>;
}

function preview(args: Record<string, unknown>) {
  const first = Object.entries(args)[0];
  if (!first) return "";
  const value = typeof first[1] === "string" ? first[1] : JSON.stringify(first[1]);
  return `${first[0]}: ${value}`.replace(/\s+/g, " ").slice(0, 100);
}

export function isWebSearchTool(name: string) {
  return /(?:^|\.)(?:web_search|source_check|fetch_content|get_search_content)$/.test(name);
}

export function isSubagentTool(name: string) {
  return /(?:^|\.)(?:subagent|subagent_wait|subagent_supervisor|intercom)$/.test(name);
}

export type ActivityKind = "process" | "index" | "loop";

export function activityKind(name: string): ActivityKind | null {
  if (/(?:^|\.)interactive_shell$/.test(name)) return "process";
  if (/(?:^|\.)(?:index_and_search_cbm|build_graph)$/.test(name)) return "index";
  if (/(?:^|\.)(?:ralph_start|ralph_done)$/.test(name)) return "loop";
  return null;
}

function subagentSummary(args: Record<string, unknown>) {
  if (typeof args.action === "string") return { mode: "CONTROL", label: args.action };
  if (Array.isArray(args.tasks)) return { mode: "PARALLEL", label: `${args.tasks.length} child agents` };
  if (Array.isArray(args.chain)) return { mode: "CHAIN", label: `${args.chain.length} stages` };
  return { mode: "DELEGATED", label: typeof args.agent === "string" ? args.agent : "child agent" };
}

function activityState(tc: TC) {
  if (tc.phase !== "end") return { label: "RUNNING", className: "running" };
  return tc.isError ? { label: "FAILED", className: "failed" } : { label: "COMPLETE", className: "complete" };
}

function SubagentView({ tc }: Readonly<{ tc: TC }>) {
  const running = tc.phase !== "end";
  const waiting = /(?:^|\.)subagent_wait$/.test(tc.name);
  const summary = waiting ? { mode: "WAIT", label: typeof tc.args.id === "string" ? tc.args.id : "child agents" } : subagentSummary(tc.args);
  const state = activityState(tc);
  return <details className={`subagent-card ${state.className}`} open={running}>
    <summary>
      <span className="subagent-orbit" aria-hidden="true"><i /><i /></span>
      <span><small>SUB-AGENT · {summary.mode}</small><strong>{summary.label}</strong></span>
      <b>{state.label}</b>
    </summary>
    <div className="subagent-scan" aria-hidden="true"><i /></div>
    <div className="subagent-detail"><strong>DELEGATION</strong><pre className="json-view"><JsonValue value={tc.args} /></pre>{tc.result != null && tc.phase === "end" && <><strong>{tc.isError ? "ERROR" : "RESULT"}</strong><pre className="json-view"><JsonValue value={tc.result} /></pre></>}</div>
  </details>;
}

const activityCopy: Record<ActivityKind, { eyebrow: string; running: string; icon: string }> = {
  process: { eyebrow: "EXTERNAL AGENT", running: "SESSION ACTIVE", icon: ">_" },
  index: { eyebrow: "CODEBASE MEMORY", running: "INDEXING GRAPH", icon: "◇" },
  loop: { eyebrow: "ITERATION LOOP", running: "AUTONOMOUS PASS", icon: "∞" },
};

function ActivityView({ tc, kind }: Readonly<{ tc: TC; kind: ActivityKind }>) {
  const running = tc.phase !== "end";
  const copy = activityCopy[kind];
  const state = activityState(tc);
  const stateLabel = running ? copy.running : state.label;
  return <details className={`activity-card ${kind} ${state.className}`} open={running}>
    <summary>
      <span className="activity-glyph" aria-hidden="true">{copy.icon}</span>
      <span><small>{copy.eyebrow}</small><strong>{preview(tc.args) || tc.name}</strong></span>
      <b>{stateLabel}</b>
    </summary>
    <div className="activity-track" aria-hidden="true"><i /></div>
    <div className="activity-detail"><strong>INPUT</strong><pre className="json-view"><JsonValue value={tc.args} /></pre>{tc.result != null && tc.phase === "end" && <><strong>{tc.isError ? "ERROR" : "RESULT"}</strong><pre className="json-view"><JsonValue value={tc.result} /></pre></>}</div>
  </details>;
}

function WebSearchView({ tc }: { tc: TC }) {
  const queries = (Array.isArray(tc.args.queries) ? tc.args.queries : [tc.args.query]).filter((query): query is string => typeof query === "string" && Boolean(query));
  const result = normalize(tc.result) as { details?: { progress?: number; currentQuery?: string } } | null;
  const progress = Math.round((result?.details?.progress ?? (tc.phase === "end" ? 1 : 0)) * 100);
  return <details className={`web-search-card ${tc.phase !== "end" ? "running" : ""}`} open>
    <summary>
      <span className="web-search-icon">⌕</span>
      <span><strong>{tc.phase === "end" ? "WEB RESEARCH" : "SEARCHING WEB"}</strong><small>{queries.length} {queries.length === 1 ? "query" : "queries"}</small></span>
      <b>{progress}%</b>
    </summary>
    <div className="web-search-progress"><i style={{ width: `${progress}%` }} /></div>
    <ol className="web-search-queries">{queries.map((query, index) => <li className={query === result?.details?.currentQuery ? "active" : ""} key={query}><span>{index + 1}</span>{query}</li>)}</ol>
    {tc.result != null && tc.phase === "end" && <details className="web-search-result"><summary>{tc.isError ? "VIEW ERROR" : "VIEW RESEARCH RESULT"}</summary><pre className="json-view"><JsonValue value={tc.result} /></pre></details>}
  </details>;
}

export default function ToolCallView({ tc }: { tc: TC }) {
  if (isWebSearchTool(tc.name)) return <WebSearchView tc={tc} />;
  if (isSubagentTool(tc.name)) return <SubagentView tc={tc} />;
  const activity = activityKind(tc.name);
  if (activity) return <ActivityView tc={tc} kind={activity} />;
  const isStreaming = tc.phase !== "end";
  return <details className={`tool-call ${isStreaming ? "running" : ""}`} open={isStreaming}>
    <summary>
      <span className="tool-status">{isStreaming ? "◌" : tc.isError ? "!" : "✓"}</span>
      <strong>{tc.name}</strong>
      <span>{preview(tc.args)}</span>
    </summary>
    <div className="tool-detail">
      <section><label>INPUT</label><pre className="json-view"><JsonValue value={tc.args} /></pre></section>
      {tc.result != null && <section><label>{tc.isError ? "ERROR" : "RESULT"}</label><pre className="json-view"><JsonValue value={tc.result} /></pre></section>}
    </div>
  </details>;
}
