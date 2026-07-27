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

export default function ToolCallView({ tc }: { tc: TC }) {
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
