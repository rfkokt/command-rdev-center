import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type Task = { no?: string | number; url?: string; deskripsi?: string; pic?: string; status?: string; notes?: string; [key: string]: unknown };

function oneLine(value: unknown, max = 90) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function taskMarkdown(task: Task, allTasks: Task[]) {
  const known = new Set(["no", "deskripsi", "notes", "pic", "status", "priority", "url", "session_id", "references"]);
  const extra = Object.entries(task).filter(([key, value]) => !known.has(key) && value != null && String(value).trim()).map(([key, value]) => `- ${key}: ${String(value)}`);
  const text = String(task.deskripsi || "").toLowerCase();
  const referenceNumbers = [...text.matchAll(/(?:poin|point)(?: nomor)?\s+(\d+)/g)].map((match) => match[1]);
  const references = allTasks.filter((candidate) => referenceNumbers.includes(String(candidate.no)));
  return [
    `# Task #${task.no ?? "—"}`,
    "",
    String(task.deskripsi || "Untitled task"),
    task.notes ? `\n## Notes\n\n${task.notes}` : "",
    "",
    "## Metadata",
    `- PIC: ${task.pic || "Unassigned"}`,
    `- Status: ${task.status || "Unknown"}`,
    task.priority ? `- Priority: ${task.priority}` : "",
    task.url ? `- Source: ${task.url}` : "",
    ...extra,
    ...references.flatMap((reference) => ["", `## Referenced task #${reference.no ?? "—"}`, "", String(reference.deskripsi || "Untitled task"), reference.notes ? `\n### Notes\n\n${reference.notes}` : ""]),
  ].filter(Boolean).join("\n");
}

function kanbanMarkdown(items: Task[]) {
  if (!items.length) return "_Tidak ada task yang cocok._";
  const groups = new Map<string, Task[]>();
  for (const task of items) {
    const status = oneLine(task.status || "Tanpa status", 40);
    groups.set(status, [...(groups.get(status) || []), task]);
  }
  const sections = [...groups.entries()].map(([status, group]) => [
    `## ${status} · ${group.length}`,
    "",
    "| No | Task | Priority | PIC |",
    "|---:|---|---|---|",
    ...group.map((task) => `| ${oneLine(task.no, 20) || "—"} | ${oneLine(task.deskripsi) || "Untitled task"} | ${oneLine(task.priority, 20) || "—"} | ${oneLine(task.pic, 30) || "—"} |`),
  ].join("\n"));
  return [`# Task project · ${items.length}`, "", ...sections].join("\n\n");
}

async function tasks(): Promise<Task[]> {
  const dir = process.env.CRC_TASK_DIR;
  const project = process.env.CRC_PROJECT_NAME;
  if (!dir || !project) throw new Error("Project task context is unavailable");
  try {
    return JSON.parse(await readFile(join(dir, ".cache", `${project}.json`), "utf8")) as Task[];
  } catch {
    return JSON.parse(await readFile(join(dir, `${project}.json`), "utf8")) as Task[];
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "report_recurring_error",
    label: "Draft recurring error report",
    description: "After the user explicitly agrees, draft a backlog task for a verified application error so it can be prevented later. The host shows the draft for final approval before saving it.",
    promptGuidelines: ["Only call after identifying a real application error and the user explicitly agrees to report it. Include a concrete root cause and prevention.", "Do not use this for ordinary command failures that were fixed during the current task unless the user asks to report them."],
    parameters: Type.Object({
      title: Type.String({ description: "Short error summary" }),
      rootCause: Type.String({ description: "Verified technical root cause" }),
      prevention: Type.String({ description: "Concrete change or check preventing recurrence" }),
    }),
    async execute(_id, input) {
      return { content: [{ type: "text", text: "Error report draft submitted for final review." }], details: input };
    },
  });
  pi.registerTool({
    name: "list_project_tasks",
    label: "List project tasks",
    description: "List work-ready tasks for this project as Kanban Markdown. A generic request such as 'ada task apa?' means tasks that can be started now, so omit Done, Testing/Review, Pending/blocked, and In Progress unless the user explicitly asks for one of those statuses. Present the returned Markdown exactly once; do not regroup, summarize, duplicate, or invent tasks.",
    parameters: Type.Object({
      pic: Type.Optional(Type.String({ description: "Filter by exact PIC name" })),
      status: Type.Optional(Type.String({ description: "Filter by exact status" })),
    }),
    async execute(_id, input) {
      const requestedStatus = input.status?.trim().toLowerCase();
      const ready = new Set(["to do", "todo", "backlog", "open", "ready"]);
      const result = (await tasks()).filter((task) => {
        const status = task.status?.trim().toLowerCase() || "backlog";
        return (!input.pic || task.pic?.trim().toLowerCase() === input.pic.trim().toLowerCase()) && (requestedStatus ? status === requestedStatus : ready.has(status));
      });
      return { content: [{ type: "text", text: kanbanMarkdown(result) }], details: { count: result.length } };
    },
  });
  pi.registerTool({
    name: "get_project_task",
    label: "Get project task",
    description: "Get the complete, authoritative detail of one project task by number or ID. The returned Markdown includes the full task description and notes without list-preview truncation. Use it directly as the requirements; never claim it is clipped or ask the user to paste it again.",
    parameters: Type.Object({ taskNo: Type.String({ description: "Task number or ID" }) }),
    async execute(_id, input) {
      const allTasks = await tasks();
      const task = allTasks.find((item) => String(item.no) === input.taskNo);
      if (!task) throw new Error(`Task ${input.taskNo} not found`);
      return { content: [{ type: "text", text: taskMarkdown(task, allTasks) }], details: { taskNo: input.taskNo } };
    },
  });
  pi.registerTool({
    name: "track_kanban_task",
    label: "Track Kanban task",
    description: "Create or update the current chat's Kanban task. Call with In Progress only when you decide the user requested actionable work worth tracking; do not call for questions or discussion. Call with Done only when the user explicitly accepts the completed work.",
    promptSnippet: "Track actionable work in the local Kanban",
    promptGuidelines: ["Use track_kanban_task when you decide a user request is actionable work worth tracking; do not ask permission and do not use language/keyword heuristics."],
    parameters: Type.Object({
      status: Type.Union([Type.Literal("In Progress"), Type.Literal("Done")]),
      description: Type.String({ description: "Concise task description" }),
    }),
    async execute(_id, input) {
      return { content: [{ type: "text", text: `Kanban task marked ${input.status}.` }], details: input };
    },
  });
}
