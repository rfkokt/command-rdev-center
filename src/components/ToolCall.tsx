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

export type SubagentMeta = { count: number; mode: "PARALLEL" | "CHAIN" | "DELEGATED" | "WAIT" | "CONTROL"; label: string; detail: string };

export function getSubagentMeta(args: Record<string, unknown>): SubagentMeta {
  if (typeof args.action === "string") {
    return { count: 1, mode: "CONTROL", label: args.action, detail: args.action.toUpperCase() };
  }
  if (Array.isArray(args.tasks)) {
    const c = args.tasks.length || 1;
    return { count: c, mode: "PARALLEL", label: `${c} child agents`, detail: `${c} CHILD AGENTS · PARALLEL` };
  }
  if (Array.isArray(args.chain)) {
    const c = args.chain.length || 1;
    return { count: c, mode: "CHAIN", label: `${c} stages`, detail: `${c} STAGES · CHAIN` };
  }
  if (typeof args.id === "string" && args.id) {
    return { count: 1, mode: "WAIT", label: args.id, detail: `WAITING · ${args.id.slice(0, 24)}` };
  }
  const agent = typeof args.agent === "string" ? args.agent : "";
  return { count: 1, mode: "DELEGATED", label: agent || "child agent", detail: agent ? agent.toUpperCase() : "DELEGATED TASK" };
}

export function activityKind(name: string): ActivityKind | null {
  if (/(?:^|\.)interactive_shell$/.test(name)) return "process";
  if (/(?:^|\.)(?:index_and_search_cbm|build_graph)$/.test(name)) return "index";
  if (/(?:^|\.)(?:ralph_start|ralph_done)$/.test(name)) return "loop";
  return null;
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
