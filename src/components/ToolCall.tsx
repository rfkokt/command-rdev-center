import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ToolCall as TC } from "../lib/rpc";
import { useModalFocus } from "./useModalFocus";

function normalize(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function JsonValue({ value }: { value: unknown }): ReactNode {
  const normalized = normalize(value);
  if (normalized === null) return <span className="json-null">null</span>;
  if (typeof normalized === "string")
    return <span className="json-string">{JSON.stringify(normalized)}</span>;
  if (typeof normalized === "number")
    return <span className="json-number">{normalized}</span>;
  if (typeof normalized === "boolean")
    return <span className="json-boolean">{String(normalized)}</span>;
  if (Array.isArray(normalized))
    return (
      <>
        <span className="json-punctuation">[</span>
        {normalized.map((item, index) => (
          <div className="json-indent" key={index}>
            <JsonValue value={item} />
            {index < normalized.length - 1 && (
              <span className="json-punctuation">,</span>
            )}
          </div>
        ))}
        <span className="json-punctuation">]</span>
      </>
    );
  if (typeof normalized === "object") {
    const entries = Object.entries(normalized as Record<string, unknown>);
    return (
      <>
        <span className="json-punctuation">{"{"}</span>
        {entries.map(([key, item], index) => (
          <div className="json-indent" key={key}>
            <span className="json-key">{JSON.stringify(key)}</span>
            <span className="json-punctuation">: </span>
            <JsonValue value={item} />
            {index < entries.length - 1 && (
              <span className="json-punctuation">,</span>
            )}
          </div>
        ))}
        <span className="json-punctuation">{"}"}</span>
      </>
    );
  }
  return <span>{String(normalized)}</span>;
}

function preview(args: Record<string, unknown>) {
  const first = Object.entries(args)[0];
  if (!first) return "";
  const value =
    typeof first[1] === "string" ? first[1] : JSON.stringify(first[1]);
  return `${first[0]}: ${value}`.replace(/\s+/g, " ").slice(0, 100);
}

export function isWebSearchTool(name: string) {
  return /(?:^|\.)(?:web_search|source_check|fetch_content|get_search_content)$/.test(
    name,
  );
}

export function browserScreenshotRefFromText(text: string): string | null {
  return (
    text.match(/browser-artifact:[A-Za-z0-9_-]+:[0-9a-f]{32}/)?.[0] ?? null
  );
}

export function browserScreenshotRef(tc: TC): string | null {
  if (!/(?:^|\.)browser_screenshot$/.test(tc.name) || tc.phase !== "end")
    return null;
  const result = normalize(tc.result) as {
    details?: { data?: { artifactRef?: unknown } };
    data?: { artifactRef?: unknown };
  } | null;
  const ref = result?.details?.data?.artifactRef ?? result?.data?.artifactRef;
  if (typeof ref === "string" && ref.startsWith("browser-artifact:"))
    return ref;
  const serialized = JSON.stringify(result);
  return typeof serialized === "string"
    ? browserScreenshotRefFromText(serialized)
    : null;
}

export function BrowserScreenshot({ tc }: { tc: TC }) {
  const artifactRef = browserScreenshotRef(tc);
  const [src, setSrc] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const modalRef = useModalFocus<HTMLDivElement>(() => setOpen(false), open);
  useEffect(() => {
    if (!artifactRef) return;
    let active = true;
    invoke<number[]>("read_browser_screenshot", {
      sessionId: artifactRef.split(":")[1],
      artifactRef,
    })
      .then((bytes) => {
        if (!active) return;
        const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
        setSrc(URL.createObjectURL(blob));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [artifactRef]);
  useEffect(
    () => () => {
      if (src) URL.revokeObjectURL(src);
    },
    [src],
  );
  if (!src) return null;
  const download = () => {
    const link = document.createElement("a");
    link.href = src;
    link.download = `${String(tc.args.name || "browser-screenshot")}.png`;
    link.click();
  };
  return (
    <figure className="browser-screenshot-wrap">
      <button
        className="browser-screenshot-open"
        onClick={() => setOpen(true)}
        aria-label="Open browser screenshot full size"
      >
        <img
          className="browser-screenshot"
          src={src}
          alt="Browser screenshot"
        />
      </button>
      <button className="browser-screenshot-download" onClick={download}>
        Download PNG
      </button>
      {open && (
        <div
          className="browser-screenshot-modal"
          role="presentation"
          onClick={() => setOpen(false)}
        >
          <div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-label="Browser screenshot preview"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <img src={src} alt="Browser screenshot full size" />
            <button
              onClick={() => setOpen(false)}
              aria-label="Close screenshot preview"
            >
              Close
            </button>
            <button onClick={download}>Download PNG</button>
          </div>
        </div>
      )}
    </figure>
  );
}

export function isSubagentTool(name: string) {
  return /(?:^|\.)(?:subagent|subagent_wait|subagent_supervisor|intercom)$/.test(
    name,
  );
}

export type ActivityKind = "process" | "index" | "loop";

export type SubagentMeta = {
  count: number;
  mode: "PARALLEL" | "CHAIN" | "DELEGATED" | "WAIT" | "CONTROL";
  label: string;
  detail: string;
};

export function getSubagentMeta(args: Record<string, unknown>): SubagentMeta {
  if (typeof args.action === "string") {
    return {
      count: 1,
      mode: "CONTROL",
      label: args.action,
      detail: args.action.toUpperCase(),
    };
  }
  if (Array.isArray(args.tasks)) {
    const c = args.tasks.length || 1;
    return {
      count: c,
      mode: "PARALLEL",
      label: `${c} child agents`,
      detail: `${c} CHILD AGENTS · PARALLEL`,
    };
  }
  if (Array.isArray(args.chain)) {
    const c = args.chain.length || 1;
    return {
      count: c,
      mode: "CHAIN",
      label: `${c} stages`,
      detail: `${c} STAGES · CHAIN`,
    };
  }
  if (typeof args.id === "string" && args.id) {
    return {
      count: 1,
      mode: "WAIT",
      label: args.id,
      detail: `WAITING · ${args.id.slice(0, 24)}`,
    };
  }
  const agent = typeof args.agent === "string" ? args.agent : "";
  return {
    count: 1,
    mode: "DELEGATED",
    label: agent || "child agent",
    detail: agent ? agent.toUpperCase() : "DELEGATED TASK",
  };
}

export function activityKind(name: string): ActivityKind | null {
  if (/(?:^|\.)interactive_shell$/.test(name)) return "process";
  if (/(?:^|\.)(?:index_and_search_cbm|build_graph)$/.test(name))
    return "index";
  if (/(?:^|\.)(?:ralph_start|ralph_done)$/.test(name)) return "loop";
  return null;
}

function WebSearchView({ tc }: { tc: TC }) {
  const queries = (
    Array.isArray(tc.args.queries) ? tc.args.queries : [tc.args.query]
  ).filter(
    (query): query is string => typeof query === "string" && Boolean(query),
  );
  const result = normalize(tc.result) as {
    details?: { progress?: number; currentQuery?: string };
  } | null;
  const progress = Math.round(
    (result?.details?.progress ?? (tc.phase === "end" ? 1 : 0)) * 100,
  );
  return (
    <details
      className={`web-search-card ${tc.phase !== "end" ? "running" : ""}`}
      open
    >
      <summary>
        <span className="web-search-icon">⌕</span>
        <span>
          <strong>
            {tc.phase === "end" ? "WEB RESEARCH" : "SEARCHING WEB"}
          </strong>
          <small>
            {queries.length} {queries.length === 1 ? "query" : "queries"}
          </small>
        </span>
        <b>{progress}%</b>
      </summary>
      <div className="web-search-progress">
        <i style={{ width: `${progress}%` }} />
      </div>
      <ol className="web-search-queries">
        {queries.map((query, index) => (
          <li
            className={query === result?.details?.currentQuery ? "active" : ""}
            key={query}
          >
            <span>{index + 1}</span>
            {query}
          </li>
        ))}
      </ol>
      {tc.result != null && tc.phase === "end" && (
        <details className="web-search-result">
          <summary>
            {tc.isError ? "VIEW ERROR" : "VIEW RESEARCH RESULT"}
          </summary>
          <pre className="json-view">
            <JsonValue value={tc.result} />
          </pre>
        </details>
      )}
    </details>
  );
}

export default function ToolCallView({ tc }: { tc: TC }) {
  if (isWebSearchTool(tc.name)) return <WebSearchView tc={tc} />;
  const isStreaming = tc.phase !== "end";
  return (
    <details
      className={`tool-call ${isStreaming ? "running" : ""}`}
      open={isStreaming}
    >
      <summary>
        <span className="tool-status">
          {isStreaming ? "◌" : tc.isError ? "!" : "✓"}
        </span>
        <strong>{tc.name}</strong>
        <span>{preview(tc.args)}</span>
      </summary>
      <div className="tool-detail">
        <section>
          <label>INPUT</label>
          <pre className="json-view">
            <JsonValue value={tc.args} />
          </pre>
        </section>
        {tc.result != null && (
          <section>
            <label>{tc.isError ? "ERROR" : "RESULT"}</label>
            <pre className="json-view">
              <JsonValue value={tc.result} />
            </pre>
          </section>
        )}
      </div>
    </details>
  );
}
