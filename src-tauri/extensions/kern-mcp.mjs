#!/usr/bin/env node
// Kern MCP server: exposes Kern's app-integrated tools to non-pi harnesses
// (OpenCode, Claude Code, oh-my-pi, Codex, …) over MCP stdio. pi gets the same
// tools from its extensions; this file mirrors their names, schemas and
// descriptions so Kern's chat UI reacts identically (see ADR-0007).
//
// Zero dependencies on purpose: it runs with whatever `node` is on PATH.
// Context comes from env set by Kern: CRC_PROJECT_NAME, CRC_TASK_DIR,
// CRC_TASK_SOURCE_KIND.

import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";

const SERVER_INFO = { name: "kern", version: "1.0.0" };
const DEFAULT_PROTOCOL = "2025-06-18";

// ---------------------------------------------------------------- tasks

function oneLine(value, max = 90) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\|/g, "\\|");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function taskMarkdown(task, allTasks) {
  const known = new Set([
    "no",
    "deskripsi",
    "notes",
    "pic",
    "status",
    "priority",
    "url",
    "session_id",
    "references",
  ]);
  const extra = Object.entries(task)
    .filter(
      ([key, value]) =>
        !known.has(key) && value != null && String(value).trim(),
    )
    .map(
      ([key, value]) =>
        `- ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
    );
  const embedded = Array.isArray(task.references) ? task.references : [];
  const text = String(task.deskripsi || "").toLowerCase();
  const referenceNumbers = [
    ...text.matchAll(/(?:poin|point)(?: nomor)?\s+(\d+)/g),
  ].map((match) => match[1]);
  const references = embedded.length
    ? embedded
    : allTasks.filter((candidate) =>
        referenceNumbers.includes(String(candidate.no)),
      );
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
    ...references.flatMap((reference) => [
      "",
      `## Referenced task #${reference.no ?? "—"}`,
      "",
      String(reference.deskripsi || "Untitled task"),
      reference.notes ? `\n### Notes\n\n${reference.notes}` : "",
    ]),
  ]
    .filter(Boolean)
    .join("\n");
}

export function kanbanMarkdown(items) {
  if (!items.length) return "_Tidak ada task yang cocok._";
  const groups = new Map();
  for (const task of items) {
    const status = oneLine(task.status || "Tanpa status", 40);
    groups.set(status, [...(groups.get(status) || []), task]);
  }
  const sections = [...groups.entries()].map(([status, group]) =>
    [
      `## ${status} · ${group.length}`,
      "",
      "| No | Task | Priority | PIC |",
      "|---:|---|---|---|",
      ...group.map(
        (task) =>
          `| ${oneLine(task.no, 20) || "—"} | ${oneLine(task.deskripsi) || "Untitled task"} | ${oneLine(task.priority, 20) || "—"} | ${oneLine(task.pic, 30) || "—"} |`,
      ),
    ].join("\n"),
  );
  return [`# Task project · ${items.length}`, "", ...sections].join("\n\n");
}

async function tasks(env = process.env) {
  const dir = env.CRC_TASK_DIR;
  const project = env.CRC_PROJECT_NAME;
  if (!dir || !project) throw new Error("Project task context is unavailable");
  const cached = env.CRC_TASK_SOURCE_KIND === "google_sheets";
  const path = join(
    dir,
    ...(cached ? [".cache", `${project}.json`] : [`${project}.json`]),
  );
  let raw;
  let source = path;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT" || cached) throw error;
    source = join(dir, ".cache", `${project}.json`);
    raw = await readFile(source, "utf8");
  }
  if (source.includes(`${join(dir, ".cache")}/`)) {
    let metadata;
    try {
      metadata = JSON.parse(
        await readFile(join(dir, ".cache", `${project}.meta.json`), "utf8"),
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (metadata?.error)
      throw new Error(
        `Task source unavailable: ${metadata.error}. Do not infer that no tasks exist.`,
      );
  }
  const items = JSON.parse(raw);
  if (!Array.isArray(items) || items.some((task) => !task || task.no == null))
    throw new Error("Invalid project task data");
  return {
    items,
    source,
    updatedAt: (await stat(source)).mtime.toISOString(),
    cached: source !== join(dir, `${project}.json`),
  };
}

// ---------------------------------------------------------------- tools

const str = (description) => ({ type: "string", description });
const signal = (text) => async () => text;

export const TOOLS = [
  {
    name: "track_kanban_task",
    description:
      "Create or update the current chat's Kanban task. Call with In Progress only when you decide the user requested actionable work worth tracking; do not call for questions or discussion. Call with Done only when the user explicitly accepts the completed work.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["In Progress", "Done"] },
        description: str("Concise task description"),
      },
      required: ["status", "description"],
    },
    run: async (input) => `Kanban task marked ${input.status}.`,
  },
  {
    name: "list_project_tasks",
    description:
      "List work-ready tasks for this project as Kanban Markdown. A generic request such as 'ada task apa?' means tasks that can be started now, so omit Done, Testing/Review, Pending/blocked, and In Progress unless the user explicitly asks for one of those statuses. Present the returned Markdown exactly once; do not regroup, summarize, duplicate, or invent tasks.",
    inputSchema: {
      type: "object",
      properties: {
        pic: str("Filter by exact PIC name"),
        status: str("Filter by exact status"),
      },
    },
    run: async (input, env) => {
      const requested = input.status?.trim().toLowerCase();
      const ready = new Set(["to do", "todo", "backlog", "open", "ready"]);
      const data = await tasks(env);
      const result = data.items.filter((task) => {
        const status = task.status?.trim().toLowerCase() || "backlog";
        return (
          (!input.pic ||
            task.pic?.trim().toLowerCase() ===
              input.pic.trim().toLowerCase()) &&
          (requested ? status === requested : ready.has(status))
        );
      });
      return kanbanMarkdown(result);
    },
  },
  {
    name: "get_project_task",
    description:
      "Get the complete, authoritative detail of one project task by number or ID. The returned Markdown includes the full task description and notes without list-preview truncation. Use the full description, notes, and referenced tasks as requirements before mapping them to Swagger operations. Check source/updatedAt and cached metadata; do not guess a task ID or invent missing requirements. Never claim it is clipped or ask the user to paste it again.",
    inputSchema: {
      type: "object",
      properties: { taskNo: str("Task number or ID") },
      required: ["taskNo"],
    },
    run: async (input, env) => {
      const data = await tasks(env);
      const taskNo = String(input.taskNo ?? "")
        .trim()
        .replace(/^#/, "");
      const matching = data.items.filter(
        (item) => String(item.no).trim() === taskNo,
      );
      if (!matching.length)
        throw new Error(
          `Task ${taskNo} not found in ${data.source} (updated ${data.updatedAt})`,
        );
      if (matching.length > 1)
        throw new Error(
          `Task ${taskNo} is ambiguous: ${matching.length} records share this ID. Resolve the task source before choosing requirements.`,
        );
      const revision = createHash("sha256")
        .update(JSON.stringify(matching[0]))
        .digest("hex");
      return `${taskMarkdown(matching[0], data.items)}\n\n<!-- source: ${data.source} · updated ${data.updatedAt}${data.cached ? " · cached" : ""} · revision ${revision.slice(0, 12)} -->`;
    },
  },
  {
    name: "report_recurring_error",
    description:
      "After the user explicitly agrees, draft a backlog task for a verified application error so it can be prevented later. The host shows the draft for final approval before saving it.",
    inputSchema: {
      type: "object",
      properties: {
        title: str("Short error summary"),
        rootCause: str("Verified technical root cause"),
        prevention: str("Concrete change or check preventing recurrence"),
      },
      required: ["title", "rootCause", "prevention"],
    },
    run: signal("Error report draft submitted for final review."),
  },
  {
    name: "recommend_global_skills",
    description:
      "Show an interactive skill recommendation card after deciding that one or more installed global skills are relevant to the user's request. Do not call merely because keywords overlap; use your judgment. Use exact installed skill names and recommend at most three.",
    inputSchema: {
      type: "object",
      properties: {
        skills: {
          type: "array",
          items: str("Exact installed skill name"),
          minItems: 1,
          maxItems: 3,
        },
        reason: str("Concise explanation of why these skills fit"),
      },
      required: ["skills", "reason"],
    },
    run: signal("Skill recommendations shown to the user."),
  },
  {
    name: "complete_pr_review",
    description:
      "Submit PR review completion to Kern. Host runs checks and safely commits/pushes explicit paths in Fix & push mode. Never push yourself. Summary must include severity, file:line, fixed versus reported findings. Submission is not success; wait for host result in chat.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        issues: { type: "integer", minimum: 0 },
        fixed: { type: "integer", minimum: 0 },
        message: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "issues", "fixed", "message", "paths"],
    },
    run: signal("Review completion requested; wait for host result in chat."),
  },
  {
    name: "run_pipeline",
    description:
      "Request the app-owned saved pipeline for this project. Use only when the user explicitly asks to run the pipeline. The host app executes saved commands; this tool never accepts commands.",
    inputSchema: {
      type: "object",
      properties: { confirm: { type: "boolean", const: true } },
      required: ["confirm"],
    },
    run: signal("Pipeline run requested."),
  },
  {
    name: "provide_pipeline_input",
    description:
      "Submit an AI commit proposal after inspecting the current worktree diff. The host app always asks the user before forwarding it.",
    inputSchema: {
      type: "object",
      properties: {
        message: str("One-line conventional commit message"),
        paths: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Explicit relative modified file paths",
        },
      },
      required: ["message", "paths"],
    },
    run: signal("Pipeline input proposal submitted for user review."),
  },
  {
    name: "control_pipeline",
    description:
      "Retry, skip, or cancel the active app-owned pipeline. Use retry after safely fixing an ai_fix failure. Use skip or cancel only when the human user requests or confirms that action; an explicit request such as 'skip sonar' already supplies that confirmation, even if project guidance calls the check mandatory. Skip applies to the current failed step waiting for an action. The host app enforces approval and pipeline state. Do not claim a skipped check passed.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["retry", "skip", "cancel"] },
      },
      required: ["action"],
    },
    run: async (input) => `Pipeline ${input.action} requested.`,
  },
];

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);

/** complete_pr_review exists only in Kern PR review chats. */
export function toolsFor(env = process.env) {
  return TOOLS.filter(
    (tool) => tool.name !== "complete_pr_review" || env.CRC_PR_REVIEW === "1",
  );
}

/** Validate the few constraints the host relies on; full JSON Schema is the client's job. */
function checkInput(tool, input) {
  for (const key of tool.inputSchema.required ?? []) {
    if (input[key] === undefined || input[key] === null || input[key] === "")
      return `Missing required argument: ${key}`;
  }
  for (const [key, schema] of Object.entries(tool.inputSchema.properties)) {
    if (input[key] === undefined) continue;
    if (schema.enum && !schema.enum.includes(input[key]))
      return `${key} must be one of: ${schema.enum.join(", ")}`;
    if (schema.const !== undefined && input[key] !== schema.const)
      return `${key} must be ${JSON.stringify(schema.const)}`;
  }
  return null;
}

// ---------------------------------------------------------------- protocol

/** Handle one JSON-RPC message; returns the response object or null. */
export async function handle(message, env = process.env) {
  const { id, method, params } = message ?? {};
  const isRequest = id !== undefined && id !== null;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, text) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message: text },
  });
  if (!isRequest) return null; // notifications (initialized, cancelled, …)
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Kern Studio app tools: project tasks, Kanban tracking, and the app-owned delivery pipeline.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: toolsFor(env).map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case "tools/call": {
      const tool = toolsFor(env).find(
        (candidate) => candidate.name === params?.name,
      );
      if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
      const input = params?.arguments ?? {};
      const invalid = checkInput(tool, input);
      if (invalid)
        return reply({
          content: [{ type: "text", text: invalid }],
          isError: true,
        });
      try {
        const text = await tool.run(input, env);
        return reply({ content: [{ type: "text", text }] });
      } catch (error) {
        return reply({
          content: [{ type: "text", text: String(error?.message ?? error) }],
          isError: true,
        });
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

function serve() {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
      );
      return;
    }
    const response = await handle(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) serve();
