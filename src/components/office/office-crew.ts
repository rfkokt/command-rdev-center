import type { ToolCall } from "../../lib/rpc";
import { describeStep, toolTiming, type StepKind } from "../AgentRunCard";
import { isSubagentTool } from "../ToolCall";
import { TEAM, agentForTool, type AgentId } from "./office-motion";

/*
 * Turns the current turn's tool calls into "who in the office is doing what".
 * Pure and time-injected so it can be tested; the panel recomputes it as tool
 * events arrive and on a slow tick for the done/error fade-outs.
 */

export type CrewStatus = "idle" | "working" | "done" | "error";

export type CrewStep = {
  id: string;
  label: string;
  kind: StepKind;
  done: boolean;
  failed: boolean;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  /** Sub-agent name, when the step is a delegated task. */
  via?: string;
};

export type CrewMember = {
  id: AgentId;
  name: string;
  role: string;
  color: string;
  status: CrewStatus;
  text: string;
  steps: CrewStep[];
};

export type Crew = { working: boolean; members: CrewMember[] };

export const CREW_ROLES: Record<AgentId, string> = {
  kern: "Lead · plans & writes",
  ada: "Reads files",
  linus: "Edits & git",
  alan: "Search & web",
  bob: "Tests",
  grace: "Commands & builds",
};

/** Members free to take delegated sub-agent tasks, in hand-out order. */
const HELPERS: AgentId[] = ["ada", "alan", "grace", "bob", "linus"];

// While the run continues, a finished member shows its result briefly.
export const DONE_HOLD_MS = 4000;
export const ERROR_HOLD_MS = 8000;

type SubTask = { agent: string; task: string; state?: "done" | "error" };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** Per-task state from a sub-agent result, when the extension reports one. */
function taskState(entry: unknown): SubTask["state"] {
  const item = record(entry);
  const status = String(item.status ?? item.state ?? "").toLowerCase();
  if (/(fail|error|cancel|abort)/.test(status)) return "error";
  if (/(done|complete|success|finish|ok)/.test(status)) return "done";
  if (typeof item.exitCode === "number")
    return item.exitCode === 0 ? "done" : "error";
  return undefined;
}

/** Delegated tasks of a sub-agent call: parallel `tasks`, a `chain`, or one. */
export function subagentTasks(tool: ToolCall): SubTask[] {
  const args = record(tool.args);
  const list = Array.isArray(args.tasks)
    ? args.tasks
    : Array.isArray(args.chain)
      ? args.chain
      : typeof args.task === "string" || typeof args.agent === "string"
        ? [args]
        : [];
  const details = record(record(tool.result).details);
  const results = Array.isArray(details.results)
    ? details.results
    : Array.isArray(details.progress)
      ? details.progress
      : [];
  return list.map((entry, index) => {
    const item = record(entry);
    return {
      agent: String(item.agent ?? item.name ?? `agent ${index + 1}`),
      task: String(item.task ?? item.prompt ?? "").replace(/\s+/g, " "),
      state: taskState(results[index]),
    };
  });
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function buildCrew(
  tools: readonly ToolCall[],
  options: {
    running: boolean;
    writing?: boolean;
    now?: number;
    timing?: (callId: string) => { start?: number; end?: number };
  },
): Crew {
  const now = options.now ?? Date.now();
  const timing = options.timing ?? toolTiming;
  const steps = new Map<AgentId, CrewStep[]>(TEAM.map((m) => [m.id, []]));
  const busy = new Set<AgentId>();
  // Tools that are not sub-agents first, so delegated tasks go to free hands.
  for (const tool of tools) {
    if (isSubagentTool(tool.name)) continue;
    const { id } = agentForTool(tool.name, tool.args);
    const step = describeStep(tool);
    const { start, end } = timing(tool.callId);
    steps.get(id)!.push({
      id: tool.callId,
      label: step.label,
      kind: step.kind,
      done: step.done,
      failed: Boolean(step.failed),
      startedAt: start,
      endedAt: end,
      durationMs:
        start !== undefined && end !== undefined ? end - start : undefined,
    });
    if (!step.done) busy.add(id);
  }
  let next = 0;
  for (const tool of tools) {
    if (!isSubagentTool(tool.name)) continue;
    const finished = tool.phase === "end";
    const { start, end } = timing(tool.callId);
    subagentTasks(tool).forEach((task, index) => {
      // Stable hand-out by task order in the turn: a task must not jump to
      // another desk when a sibling finishes. (The lead agent waits on the
      // sub-agent call, so clashing with its own tools is rare.)
      const id = HELPERS[next++ % HELPERS.length];
      const failed =
        task.state === "error" ||
        (finished && !task.state && Boolean(tool.isError));
      const done = finished || task.state !== undefined;
      steps.get(id)!.push({
        id: `${tool.callId}#${index}`,
        label: clip(task.task || `Delegated to ${task.agent}`, 90),
        kind: "agents",
        done,
        failed,
        startedAt: start,
        endedAt: done ? (end ?? now) : undefined,
        durationMs:
          start !== undefined && end !== undefined ? end - start : undefined,
        via: task.agent,
      });
      if (!done) busy.add(id);
    });
  }

  const anyActive = busy.size > 0;
  const members = TEAM.map((member): CrewMember => {
    const own = steps.get(member.id)!;
    const active = [...own].reverse().find((step) => !step.done);
    const last = own[own.length - 1];
    let status: CrewStatus = "idle";
    let text = "";
    if (active) {
      status = "working";
      text = active.via ? `${active.via}: ${active.label}` : active.label;
    } else if (last) {
      const age = now - (last.endedAt ?? now);
      if (last.failed && (!options.running || age < ERROR_HOLD_MS)) {
        status = "error";
        text = last.label;
      } else if (!options.running || age < DONE_HOLD_MS) {
        status = "done";
        text = last.label;
      }
    }
    // Kern stands for the model itself: thinking/writing between tools.
    if (member.id === "kern" && !active) {
      if (options.running && !anyActive) {
        status = "working";
        text = options.writing ? "Writing the response…" : "Thinking…";
      } else if (!options.running && tools.length > 0 && status === "idle") {
        status = "done";
        text = "Turn finished";
      }
    }
    return {
      id: member.id,
      name: member.name,
      role: CREW_ROLES[member.id],
      color: member.color,
      status,
      text,
      steps: own,
    };
  });
  return {
    working: options.running,
    members,
  };
}
