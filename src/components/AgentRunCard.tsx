import {
  memo,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { ToolCall } from "../lib/rpc";

/*
 * Live "run card" shown while the agent is working: spinning status glyph,
 * current action, segmented step progress, and an animated step log where each
 * finished tool call settles in with its duration (Claude-run style).
 */

type StepKind =
  | "search"
  | "read"
  | "edit"
  | "files"
  | "test"
  | "terminal"
  | "git"
  | "web"
  | "agents"
  | "think"
  | "write"
  | "tool";

export type RunStep = {
  id: string;
  kind: StepKind;
  label: string;
  done: boolean;
  failed?: boolean;
  /** Set while running: when the step began. */
  startedAt?: number;
  /** Set once finished, if the start was observed. */
  durationMs?: number;
};

// Tool calls carry no timestamps, so first-seen / first-ended times are kept
// here. Module scope survives virtualized remounts of the card.
const timings = new Map<string, { start: number; end?: number }>();

function track(tool: ToolCall) {
  const now = Date.now();
  let entry = timings.get(tool.callId);
  if (!entry) {
    // Already finished before we ever saw it (e.g. remount): no duration.
    entry = tool.phase === "end" ? { start: NaN, end: NaN } : { start: now };
    timings.set(tool.callId, entry);
    if (timings.size > 2000) {
      const oldest = timings.keys().next().value;
      if (oldest) timings.delete(oldest);
    }
  } else if (tool.phase === "end" && entry.end === undefined) {
    entry.end = now;
  }
  return entry;
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const r = result as { content?: unknown; output?: unknown; text?: unknown };
  if (Array.isArray(r.content))
    return r.content
      .map((c) =>
        c && typeof c === "object" && "text" in c
          ? String((c as { text: unknown }).text ?? "")
          : "",
      )
      .join("\n");
  if (typeof r.output === "string") return r.output;
  if (typeof r.text === "string") return r.text;
  return "";
}

const shortPath = (p: string) => {
  const parts = p.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : p;
};
const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;
const plural = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? "" : /(s|sh|ch|x)$/.test(word) ? "es" : "s"}`;

function testSummary(text: string, failed: boolean) {
  // vitest: "Tests  12 passed (12)" · jest: "Tests: 1 failed, 11 passed, 12 total"
  // cargo: "test result: ok. 12 passed; 0 failed" · pytest: "12 passed in 0.3s"
  const passed = Number(/(\d+)\s+passed/i.exec(text)?.[1] ?? NaN);
  const failedN = Number(/(\d+)\s+failed/i.exec(text)?.[1] ?? 0);
  const total =
    Number(/Tests?:?\s+[^\n]*?\((\d+)\)/i.exec(text)?.[1] ?? NaN) ||
    Number(/(\d+)\s+total/i.exec(text)?.[1] ?? NaN) ||
    (Number.isFinite(passed) ? passed + failedN : NaN);
  if (Number.isFinite(passed) && Number.isFinite(total))
    return failedN > 0 || failed
      ? `Failed ${failedN || total - passed} of ${total} tests`
      : `Passed ${passed} of ${total} tests`;
  return failed ? "Tests failed" : "Tests passed";
}

export function describeStep(tool: ToolCall): Omit<RunStep, "id"> {
  const name = tool.name.replace(/^functions\./, "").toLowerCase();
  const a = tool.args ?? {};
  const done = tool.phase === "end";
  const failed = done && Boolean(tool.isError);
  const path = String(a.path ?? a.file_path ?? a.file ?? a.target ?? "");
  const base = { done, failed };

  if (name === "bash" || name === "shell" || name === "exec") {
    const cmd = String(a.command ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const lower = cmd.toLowerCase();
    if (
      /\b(vitest|jest|pytest|cargo\s+test|go\s+test|(pnpm|npm|yarn|bun)\s+(run\s+)?test)\b/.test(
        lower,
      )
    )
      return {
        ...base,
        kind: "test",
        label: done
          ? testSummary(resultText(tool.result), failed)
          : "Running tests",
      };
    const push = /git\s+push\b(?:\s+\S+)?(?:\s+([^\s-][^\s]*))?/.exec(cmd);
    if (push) {
      const branch = push[1]?.replace(/^HEAD:/, "") ?? "";
      return {
        ...base,
        kind: "git",
        label: `${done ? "Pushed" : "Pushing"}${branch ? ` ${branch}` : " branch"}`,
      };
    }
    if (/git\s+commit\b/.test(lower))
      return {
        ...base,
        kind: "git",
        label: done ? "Committed changes" : "Committing changes",
      };
    if (/\b(rg|grep|ag|ack)\b/.test(lower))
      return {
        ...base,
        kind: "search",
        label: done
          ? `Searched \`${clip(cmd, 40)}\``
          : `Searching \`${clip(cmd, 40)}\``,
      };
    if (/(build|compile|tsc\b)/.test(lower))
      return {
        ...base,
        kind: "terminal",
        label: done ? "Built project" : "Building project",
      };
    return {
      ...base,
      kind: "terminal",
      label: `${done ? "Ran" : "Running"} ${clip(cmd || "command", 48)}`,
    };
  }
  if (name === "read" || name === "view" || name === "cat")
    return {
      ...base,
      kind: "read",
      label: `${done ? "Read" : "Reading"} ${shortPath(path) || "file"}`,
    };
  if (name === "edit" || name === "multiedit" || name === "apply_patch")
    return {
      ...base,
      kind: "edit",
      label: `${done ? "Edited" : "Editing"} ${shortPath(path) || "file"}`,
    };
  if (name === "write" || name === "create")
    return {
      ...base,
      kind: "edit",
      label: `${done ? "Wrote" : "Writing"} ${shortPath(path) || "file"}`,
    };
  if (
    /(grep|search|ripgrep|find|glob|ls)$/.test(name) &&
    !name.includes("web")
  ) {
    const q = String(a.pattern ?? a.query ?? a.glob ?? path ?? "");
    if (done) {
      const hits = resultText(tool.result).split("\n").filter(Boolean).length;
      return {
        ...base,
        kind: "search",
        label:
          hits > 0
            ? `Found ${plural(hits, "match")}${q ? ` for “${clip(q, 28)}”` : ""}`
            : `Searched “${clip(q, 36)}”`,
      };
    }
    return {
      ...base,
      kind: "search",
      label: q ? `Searching “${clip(q, 36)}”` : "Searching codebase",
    };
  }
  if (name.includes("web") || name === "fetch" || name === "fetch_content") {
    const q = String(a.query ?? a.url ?? "");
    let target = q;
    try {
      if (/^https?:/.test(q)) target = new URL(q).hostname;
    } catch {
      /* keep raw */
    }
    return {
      ...base,
      kind: "web",
      label: `${done ? "Searched web" : "Searching web"}${target ? `: ${clip(target, 36)}` : ""}`,
    };
  }
  if (/(subagent|task|agent)$/.test(name))
    return {
      ...base,
      kind: "agents",
      label: done ? "Sub-agents finished" : "Delegating to sub-agents",
    };
  const pretty = name
    .replace(/[_.-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
  return {
    ...base,
    kind: "tool",
    label: `${done ? "Called" : "Calling"} ${pretty}`,
  };
}

/** Collapse runs of finished same-kind file steps: "Edited 5 files". */
function groupSteps(steps: RunStep[]): RunStep[] {
  const out: RunStep[] = [];
  for (const step of steps) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.done &&
      step.done &&
      !prev.failed &&
      !step.failed &&
      (prev.kind === "files" ? "edit" : prev.kind) === step.kind &&
      (step.kind === "edit" || step.kind === "read")
    ) {
      const count = (Number(/(\d+) files$/.exec(prev.label)?.[1]) || 1) + 1;
      const verb =
        step.kind === "edit"
          ? prev.label.startsWith("Wrote")
            ? "Wrote"
            : "Edited"
          : "Read";
      out[out.length - 1] = {
        ...prev,
        kind: step.kind === "edit" ? "files" : "read",
        label: `${verb} ${count} files`,
        durationMs:
          prev.durationMs !== undefined && step.durationMs !== undefined
            ? prev.durationMs + step.durationMs
            : undefined,
      };
      continue;
    }
    out.push(step);
  }
  return out;
}

export function buildRunSteps(tools: ToolCall[]): RunStep[] {
  const steps = tools.map((tool) => {
    const t = track(tool);
    const done = tool.phase === "end";
    const ms = done && t.end !== undefined ? t.end - t.start : NaN;
    return {
      id: tool.callId,
      ...describeStep(tool),
      startedAt: done ? undefined : t.start,
      durationMs: Number.isFinite(ms) ? ms : undefined,
    };
  });
  return groupSteps(steps);
}

/* ---------- icons (stroke, 16px) ---------- */
const paths: Record<StepKind, ReactNode> = {
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.5 3.5" />
    </>
  ),
  read: (
    <>
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  edit: (
    <>
      <path d="M9 1.5H4a1.5 1.5 0 0 0-1.5 1.5v10A1.5 1.5 0 0 0 4 14.5h3" />
      <path d="M9 1.5 12.5 5v2" />
      <path d="m12.7 8.8 1.5 1.5-4 4H8.7v-1.5Z" />
    </>
  ),
  files: (
    <>
      <path d="M5.5 4.5v-2A1 1 0 0 1 6.5 1.5h4l3 3v7a1 1 0 0 1-1 1h-2" />
      <rect x="2.5" y="4.5" width="8" height="10" rx="1" />
    </>
  ),
  test: (
    <>
      <path d="M6 1.5h4M6.5 1.5v4.2L2.8 12.6A1.3 1.3 0 0 0 4 14.5h8a1.3 1.3 0 0 0 1.2-1.9L9.5 5.7V1.5" />
      <path d="M4.5 10h7" />
    </>
  ),
  terminal: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="m4.5 6 2 2-2 2M8.5 10.5h3" />
    </>
  ),
  git: (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7c0 3-7 2-7 4" />
    </>
  ),
  web: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M1.5 8h13M8 1.5c2 2 2.5 4 2.5 6.5S10 12.5 8 14.5C6 12.5 5.5 10.5 5.5 8S6 3.5 8 1.5Z" />
    </>
  ),
  agents: (
    <>
      <circle cx="5" cy="5.5" r="2" />
      <circle cx="11" cy="5.5" r="2" />
      <path d="M1.5 13c0-2 1.6-3.5 3.5-3.5S8.5 11 8.5 13M7.5 13c0-2 1.6-3.5 3.5-3.5s3.5 1.5 3.5 3.5" />
    </>
  ),
  think: (
    <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l2.1 2.1M10.5 10.5l2.1 2.1M3.4 12.6l2.1-2.1M10.5 5.5l2.1-2.1" />
  ),
  write: (
    <>
      <path d="M2.5 4h11M2.5 8h11M2.5 12h6" />
    </>
  ),
  tool: (
    <path d="M10 2.2a3.5 3.5 0 0 0-4.3 4.5L2 10.4V14h3.6l3.7-3.7A3.5 3.5 0 0 0 13.8 6l-2.2 2.2-2.4-.4-.4-2.4Z" />
  ),
};

function StepIcon({ kind }: { kind: StepKind }) {
  return (
    <svg
      className="run-step-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[kind]}
    </svg>
  );
}

function fmtStep(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
function fmtClock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function useNow(ticking: boolean, every: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(id);
  }, [ticking, every]);
  return now;
}

const MAX_VISIBLE = 6;
const MAX_SEGMENTS = 12;

type Props = {
  steps: RunStep[];
  /** Synthetic trailing step while no tool is active (thinking / writing). */
  idleStep?: { kind: StepKind; label: string } | null;
  title: string;
  detail?: string;
  model?: string;
  agentLabel?: string;
  color?: string;
  startedAt: number;
  ticking: boolean;
  queued?: number;
  isAborting?: boolean;
  onStop: () => void;
  children?: ReactNode;
};

export default memo(function AgentRunCard({
  steps,
  idleStep,
  title,
  detail,
  model,
  agentLabel,
  color,
  startedAt,
  ticking,
  queued = 0,
  isAborting,
  onStop,
  children,
}: Props) {
  const now = useNow(ticking, 100);
  const [collapsed, setCollapsed] = useState(false);
  const [idleSince, setIdleSince] = useState(() => Date.now());
  const idleKey = idleStep
    ? `${idleStep.kind}:${idleStep.label}:${steps.length}`
    : "";
  useEffect(() => setIdleSince(Date.now()), [idleKey]);

  const all: RunStep[] = idleStep
    ? [
        ...steps,
        {
          id: `idle-${steps.length}`,
          ...idleStep,
          done: false,
          startedAt: idleSince,
        },
      ]
    : steps;
  const total = all.length;
  let current = -1;
  for (let i = all.length - 1; i >= 0; i--)
    if (!all[i].done) {
      current = i;
      break;
    }
  const stepNo = current >= 0 ? current + 1 : total;
  const hidden = Math.max(0, total - MAX_VISIBLE);
  const visible = all.slice(hidden);
  const segStart = Math.max(0, total - MAX_SEGMENTS);
  const segments = all.slice(segStart);
  const failed = all.some((s) => s.failed);

  return (
    <section
      className={`run-card${failed ? " has-failure" : ""}`}
      style={color ? ({ "--run-agent": color } as CSSProperties) : undefined}
      role="status"
      aria-live="polite"
      aria-label="Agent run"
    >
      <header className="run-card-head">
        <span className="run-card-spinner" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="run-card-glyph">
            {Array.from({ length: 8 }, (_, i) => (
              <line
                key={i}
                x1="12"
                y1="5.5"
                x2="12"
                y2="10"
                transform={`rotate(${i * 22.5} 12 12)`}
              />
            ))}
            {Array.from({ length: 8 }, (_, i) => (
              <line
                key={`b${i}`}
                x1="12"
                y1="14"
                x2="12"
                y2="18.5"
                transform={`rotate(${i * 22.5} 12 12)`}
              />
            ))}
          </svg>
        </span>
        <span className="run-card-head-icon">
          <StepIcon kind={current >= 0 ? all[current].kind : "think"} />
        </span>
        <span className="run-card-title" key={title} title={detail || title}>
          {title}
        </span>
        <span className="run-card-clock">{fmtClock(now - startedAt)}</span>
      </header>

      <div className="run-card-meta">
        <span className="run-card-model">
          {agentLabel && <em>{agentLabel}</em>}
          {model}
        </span>
        <span className="run-card-stepno">
          {queued > 0 && (
            <span className="run-card-queued">{queued} queued · </span>
          )}
          Step {stepNo}
          {hidden > 0 || total > 1 ? ` of ${total}` : ""}
        </span>
      </div>

      <div className="run-card-segments" aria-hidden="true">
        {segments.map((s) => (
          <i
            key={s.id}
            className={
              s.failed ? "is-failed" : s.done ? "is-done" : "is-active"
            }
          />
        ))}
      </div>

      {!collapsed && (
        <ol className="run-card-steps">
          {hidden > 0 && (
            <li className="run-step is-earlier">
              <span className="run-step-icon-wrap" />
              <span className="run-step-label">
                {plural(hidden, "earlier step")}
              </span>
            </li>
          )}
          {visible.map((s) => {
            const dur = s.done
              ? (s.durationMs ?? NaN)
              : s.startedAt !== undefined
                ? now - s.startedAt
                : NaN;
            return (
              <li
                key={s.id}
                className={`run-step ${s.failed ? "is-failed" : s.done ? "is-done" : "is-active"}`}
              >
                <span className="run-step-icon-wrap">
                  <StepIcon kind={s.kind} />
                </span>
                <span className="run-step-label" key={s.label} title={s.label}>
                  {s.label}
                </span>
                <span className="run-step-time">{fmtStep(dur)}</span>
              </li>
            );
          })}
        </ol>
      )}

      {children}

      <footer className="run-card-actions">
        <button className="run-card-btn" onClick={onStop} disabled={isAborting}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <rect
              x="3"
              y="3"
              width="10"
              height="10"
              rx="1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
          </svg>
          {isAborting ? "Stopping…" : "Stop"}
        </button>
        <button
          className="run-card-link"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
        >
          {collapsed ? "Show steps" : "Hide steps"}
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d={collapsed ? "m4 6 4 4 4-4" : "m4 10 4-4 4 4"}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </footer>
    </section>
  );
});
