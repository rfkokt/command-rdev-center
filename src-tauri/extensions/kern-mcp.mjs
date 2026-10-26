#!/usr/bin/env node
// Kern MCP server: exposes Kern's app-integrated tools to non-pi harnesses
// (OpenCode, Claude Code, oh-my-pi, Codex, …) over MCP stdio. pi gets the same
// tools from its extensions; this file mirrors their names, schemas and
// descriptions so Kern's chat UI reacts identically (see ADR-0007).
//
// Zero dependencies on purpose: it runs with whatever `node` is on PATH.
// Context comes from env set by Kern: CRC_PROJECT_NAME, CRC_TASK_DIR,
// CRC_TASK_SOURCE_KIND, CRC_TASK_WRITABLE, CRC_API_CONTRACTS_PATH,
// CRC_API_LIST_PATH, CRC_PR_REVIEW. `--doctor` prints a health report.

import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
  const notSynced = (error) => {
    if (error?.code !== "ENOENT") throw error;
    throw new Error(
      `No task data for project "${project}" yet (project_not_found): Kern has not synced its task source. Ask the user to open the project's Tasks view or check Project Settings → Tasks. Do not infer that no tasks exist.`,
    );
  };
  let raw;
  let source = path;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (cached) notSynced(error);
    if (error?.code !== "ENOENT") throw error;
    source = join(dir, ".cache", `${project}.json`);
    raw = await readFile(source, "utf8").catch(notSynced);
  }
  let metadata;
  if (source.includes(`${join(dir, ".cache")}/`)) {
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
    metadata,
  };
}

/** Explains where a task list came from and, when empty, why. */
export function taskSourceNote(metadata, count) {
  if (!metadata?.state) return "";
  const sheets = (metadata.sheets ?? []).filter(Boolean).join(", ") || "—";
  const pics = (metadata.pics ?? []).join(", ") || "—";
  const synced = metadata.syncedAt
    ? new Date(metadata.syncedAt).toISOString()
    : "unknown";
  const why = count
    ? ""
    : {
        no_pic_selected:
          "No PIC is selected in Project Settings → Tasks, so every row is filtered out. Ask the user to select their PIC.",
        no_tasks_for_pic: `Read ${metadata.total} rows, but none belong to the selected PIC. The tasks may be on a worksheet that is not selected in Project Settings → Tasks.`,
        empty: "The selected worksheets contain no task rows.",
      }[metadata.state] || "";
  return [
    why && `\n\n**Why empty (${metadata.state}):** ${why}`,
    `\n\n<!-- state ${metadata.state} · worksheets ${sheets} · PIC ${pics} · ${metadata.count ?? "?"} of ${metadata.total ?? "?"} rows · synced ${synced} -->`,
  ]
    .filter(Boolean)
    .join("");
}

/** Mirrors list_task_statuses in pi's kanban-task extension. */
export async function taskStatusesText(env) {
  const { metadata } = await tasks(env);
  const statuses = metadata?.statuses ?? [];
  return [
    statuses.length
      ? `Statuses used in ${(metadata.sheets ?? []).join(", ") || "the task source"}: ${statuses.join(", ")}`
      : "No status values found in the synced tasks.",
    metadata?.writable
      ? "Status writes are enabled; the sheet's Status dropdown is enforced on write."
      : "Status writes are disabled: the task source is read-only until the Apps Script sheet writer is configured in Project Settings → Tasks.",
  ].join("\n");
}

const where = (task) => `${task._sheet || "sheet"} row ${task._row ?? "?"}`;

/** The one task selected by number, optionally narrowed by sheet and row. */
function oneTask(data, input, scope) {
  const taskNo = String(input.taskNo ?? "")
    .trim()
    .replace(/^#/, "");
  const matching = data.items.filter(
    (task) =>
      String(task.no).trim() === taskNo &&
      (input.row == null || Number(task._row) === Number(input.row)) &&
      (!input.sheet || task._sheet === input.sheet),
  );
  if (!matching.length)
    throw new Error(
      `Task ${taskNo} is not among this project's tasks for the selected PIC (${(data.metadata?.pics ?? []).join(", ") || "none"}). ${scope}`,
    );
  if (matching.length > 1)
    throw new Error(
      `Task ${taskNo} is ambiguous: ${matching.map(where).join(", ")}. Call again with sheet and row.`,
    );
  return { taskNo, task: matching[0] };
}

/** Mirrors update_task_status in pi's kanban-task extension: checks the
 * request against the synced tasks; Kern asks the user and does the write. */
export async function requestStatusChange(input, env) {
  const data = await tasks(env);
  const { taskNo, task } = oneTask(
    data,
    input,
    "Only those tasks can be updated.",
  );
  const known = data.metadata?.statuses ?? [];
  const status = String(input.status).trim();
  return [
    `Requested #${taskNo} (${where(task)}): ${task.status || "—"} → ${status}.`,
    "Kern now asks the user to approve and writes the sheet; the result (before/after) arrives as a follow-up message. Do not claim the status changed before then.",
    known.length && !known.includes(status)
      ? `Note: "${status}" is not used in the selected worksheets yet (${known.join(", ")}); the sheet's Status dropdown decides on write.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------- api

// Contracts are written by Kern per session (CRC_API_CONTRACTS_PATH); the
// catalog is pi's own, bundled into kern-openapi.mjs.
async function contracts(env) {
  const raw = await readFile(env.CRC_API_CONTRACTS_PATH, "utf8");
  return JSON.parse(raw);
}

const catalog = () => import("./kern-openapi.mjs");

/** Mirrors api_find_operations in pi's api-test extension. */
async function findOperations(input, env) {
  const { refreshContracts, saveContracts, searchOperations } = await catalog();
  let items = await contracts(env);
  let refresh;
  if (input.refresh) {
    const sources = new Set(
      items
        .filter((item) => !input.contractId || item.id === input.contractId)
        .map((item) => item.configured_source || item.source_url),
    );
    items = await refreshContracts(items, input);
    const persisted = { session: false, sharedCache: false };
    for (const [key, path] of [
      ["sharedCache", env.CRC_API_CONTRACT_CACHE_PATH],
      ["session", env.CRC_API_CONTRACTS_PATH],
    ]) {
      if (!path) continue;
      try {
        await saveContracts(path, items);
        persisted[key] = true;
      } catch {
        // Reported through `persisted`; the refreshed inventory is still used.
      }
    }
    const checked = items.filter((item) =>
      sources.has(item.configured_source || item.source_url),
    );
    const count = (status) =>
      checked.filter((item) => item.refresh_status === status).length;
    refresh = {
      checkedAt: Date.now(),
      updated: count("updated"),
      unchanged: count("unchanged"),
      failed: count("failed"),
      persisted,
    };
  }
  return JSON.stringify({
    ...searchOperations(items, input),
    ...(refresh && { refresh }),
  });
}

/** Mirrors api_operation_detail in pi's api-test extension. */
async function operationDetailText(input, env) {
  const { operationDetail, searchOperations, selectOperation } =
    await catalog();
  const items = await contracts(env);
  const selection = selectOperation(items, input);
  if (selection.selected)
    return JSON.stringify(operationDetail(selection.selected));
  throw new Error(
    JSON.stringify({
      status: "error",
      ...selection,
      inventory: searchOperations(items, {
        query: input.operationId || input.path,
        limit: 10,
      }),
      guidance:
        "This exact selector was not resolved. Search api_find_operations across all contracts, inspect candidates with api_operation_detail, and refresh before claiming absence. An unavailable contract is not a missing endpoint.",
    }),
  );
}

// ---------------------------------------------------------------- api list

// The project's API List worksheet, synced by Kern per session
// (CRC_API_LIST_PATH, CSV). It is the plan; Swagger is what is deployed.
async function apiList(env) {
  if (!env.CRC_API_LIST_PATH)
    throw new Error(
      "No API List worksheet is configured for this project (Project Settings → API).",
    );
  const raw = await readFile(env.CRC_API_LIST_PATH, "utf8").catch((error) => {
    if (error?.code !== "ENOENT") throw error;
    throw new Error(
      "The API List worksheet has not synced yet. Retry shortly; do not infer that it is empty.",
    );
  });
  return (await catalog()).apiListRows(raw);
}

const optionalContracts = (env) =>
  env.CRC_API_CONTRACTS_PATH ? contracts(env) : Promise.resolve([]);

const API_LIST_GUIDANCE =
  "The API List is the plan; Swagger is what the backend exposes. Implement and test against Swagger (api_operation_detail). Report ⚠/✗ rows to the user as API List ↔ Swagger mismatches instead of guessing which one is right.";

/** Mirrors api_list_check in pi's kanban-task extension. */
export async function apiListCheckText(input, env) {
  const { checkApiList, checkCounts, checksMarkdown, selectRows } =
    await catalog();
  let rows = await apiList(env);
  if (input.no) rows = selectRows(rows, String(input.no));
  const query = input.query?.trim().toLowerCase();
  if (query)
    rows = rows.filter((row) =>
      [row.endpoint, row.description, ...Object.values(row.fields)].some(
        (value) => value.toLowerCase().includes(query),
      ),
    );
  let checks = checkApiList(rows, await optionalContracts(env));
  const counts = checkCounts(checks);
  if (input.issuesOnly)
    checks = checks.filter((check) => check.result !== "exact");
  const limit = 100;
  return [
    `# API List ↔ Swagger · ${rows.length} rows`,
    "",
    Object.entries(counts)
      .filter(([, count]) => count)
      .map(([result, count]) => `${result}: ${count}`)
      .join(" · ") || "No rows.",
    "",
    checksMarkdown(checks.slice(0, limit)),
    checks.length > limit
      ? `\n_${checks.length - limit} more rows; narrow with no or query._`
      : "",
    "",
    API_LIST_GUIDANCE,
  ].join("\n");
}

/** Mirrors link_task_api in pi's kanban-task extension. */
export async function linkTaskApiText(input, env) {
  const {
    checkApiList,
    checksMarkdown,
    normalizePath,
    selectRows,
    taskApiReferences,
  } = await catalog();
  const data = await tasks(env);
  const { taskNo, task } = oneTask(data, input, "");
  const text = Object.entries(task)
    .filter(
      ([name, value]) => !name.startsWith("_") && typeof value === "string",
    )
    .map(([, value]) => value)
    .join("\n");
  const references = taskApiReferences(text);
  const notes = [];
  let rows = [];
  if (env.CRC_API_LIST_PATH) {
    try {
      const listed = await apiList(env);
      rows = selectRows(listed, references.numbers.join(","));
      const missing = references.numbers.filter(
        (no) => !rows.some((row) => row.no === no),
      );
      if (missing.length)
        notes.push(`API List has no row numbered ${missing.join(", ")}.`);
    } catch (error) {
      notes.push(String(error?.message ?? error));
    }
  } else if (references.numbers.length)
    notes.push(
      `The task cites API List numbers ${references.numbers.join(", ")}, but no API List worksheet is configured (Project Settings → API).`,
    );
  const known = new Set(rows.map((row) => normalizePath(row.path)));
  const inline = references.paths
    .filter(
      ({ path }) =>
        !known.has(normalizePath(path)) && known.add(normalizePath(path)),
    )
    .map(({ method, path }) => ({
      no: "task",
      method,
      path,
      endpoint: path,
      description: "cited in the task text",
      status: "",
      fields: {},
    }));
  const checks = checkApiList(
    [...rows, ...inline],
    await optionalContracts(env),
  );
  return [
    `# Task #${taskNo} → API`,
    "",
    String(task.deskripsi || "Untitled task")
      .split("\n")[0]
      .slice(0, 200),
    "",
    checks.length
      ? checksMarkdown(checks)
      : "This task cites no API List numbers or /api paths. Search api_find_operations with the feature's terms instead.",
    ...notes.map((note) => `\n${note}`),
    "",
    API_LIST_GUIDANCE,
  ].join("\n");
}

// ---------------------------------------------------------------- doctor

/** Health of everything Kern's tools depend on in this chat. */
export async function doctorReport(env = process.env) {
  const checks = [];
  const check = async (name, run) => {
    try {
      checks.push({ name, ok: true, detail: await run() });
    } catch (error) {
      checks.push({ name, ok: false, detail: String(error?.message ?? error) });
    }
  };
  await check("node", () => {
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 18) throw new Error(`node ${process.version}; Kern needs 18+`);
    return `${process.version} (${process.execPath})`;
  });
  await check("project", () => {
    if (!env.CRC_PROJECT_NAME || !env.CRC_TASK_DIR)
      throw new Error(
        "CRC_PROJECT_NAME/CRC_TASK_DIR are not set; start the chat from Kern",
      );
    return `${env.CRC_PROJECT_NAME} (${env.CRC_TASK_SOURCE_KIND || "local"} tasks)`;
  });
  await check("tasks", async () => {
    const { items, metadata, updatedAt } = await tasks(env);
    const source = metadata?.state
      ? ` · ${metadata.state} · worksheets ${(metadata.sheets ?? []).join(", ") || "—"} · PIC ${(metadata.pics ?? []).join(", ") || "—"} · ${metadata.total ?? "?"} rows read`
      : "";
    return `${items.length} tasks${source} · updated ${updatedAt}`;
  });
  await check("status writes", () =>
    env.CRC_TASK_WRITABLE === "1"
      ? "enabled (Apps Script sheet writer)"
      : "disabled; configure the sheet writer in Project Settings → Tasks",
  );
  if (env.CRC_API_CONTRACTS_PATH)
    await check("swagger", async () => {
      const { searchOperations } = await catalog();
      const result = searchOperations(await contracts(env), { limit: 1 });
      const failed = result.contracts.filter((item) => item.loadError);
      if (failed.length && failed.length === result.contracts.length)
        throw new Error(
          failed.map((item) => `${item.id}: ${item.loadError}`).join("; "),
        );
      return `${result.totalOperations} operations in ${result.contracts.length} contracts${result.issues.length ? `; issues: ${result.issues.map((issue) => `${issue.contractId}: ${issue.code}`).join("; ")}` : ""}`;
    });
  else checks.push({ name: "swagger", ok: true, detail: "no saved contracts" });
  if (env.CRC_API_LIST_PATH)
    await check("api list", async () => `${(await apiList(env)).length} rows`);
  checks.push({
    name: "tools",
    ok: true,
    detail: toolsFor(env)
      .map((tool) => tool.name)
      .join(", "),
  });
  const ok = checks.every((item) => item.ok);
  return {
    ok,
    text: [
      `Kern doctor: ${ok ? "healthy" : "problems found"}`,
      ...checks.map(
        (item) => `${item.ok ? "✓" : "✗"} ${item.name}: ${item.detail}`,
      ),
    ].join("\n"),
  };
}

// ---------------------------------------------------------------- tools

const str = (description) => ({ type: "string", description });
const selector = {
  operationId: { type: "string", maxLength: 300 },
  method: { type: "string", maxLength: 10 },
  path: { type: "string", maxLength: 2000 },
  contractId: { type: "string", maxLength: 300 },
  origin: { type: "string", maxLength: 2000 },
};
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
      return `${kanbanMarkdown(result)}${taskSourceNote(data.metadata, data.items.length)}`;
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
    name: "list_task_statuses",
    description:
      "List the status values used in this project's selected task worksheets, so status changes use the sheet's own wording (e.g. Testing, not Ready to QA) instead of a guess. Also reports whether status writes are enabled.",
    inputSchema: { type: "object", properties: {} },
    run: (_input, env) => taskStatusesText(env),
  },
  {
    name: "update_task_status",
    description:
      "Request a status change for one project task after its work is verified (for example merged and deployed). Use a value from list_task_statuses. Kern shows the user the current and new status for approval, writes only the Status cell, and reports before/after as a follow-up message. Only tasks of the selected PIC can change. Pass sheet and row when a task number repeats.",
    inputSchema: {
      type: "object",
      properties: {
        taskNo: str("Task number or ID"),
        status: str("New status, exactly as used in the sheet"),
        sheet: str("Worksheet name, when the task number repeats"),
        row: { type: "integer", minimum: 2, description: "Sheet row" },
      },
      required: ["taskNo", "status"],
    },
    run: requestStatusChange,
  },
  {
    name: "api_find_operations",
    description:
      "Search the complete saved Swagger/OpenAPI inventory by operation ID, path, summary, description, tags, or parameter names. Empty query lists all operations. Results are paginated; load failures and stale contracts are disclosed. Set refresh:true to fetch saved JSON/Swagger UI sources from the network with cache revalidation, update the full inventory, and persist it for this session and app restarts. Reports fetchedAt, checkedAt, contentHash, refreshStatus, and persistence results; unchanged means verified with identical content, failed retains stale data. Cached data alone does not prove it is latest. Refresh before concluding an endpoint is absent.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 500 },
        contractId: selector.contractId,
        method: selector.method,
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        refresh: { type: "boolean" },
      },
    },
    run: findOperations,
  },
  {
    name: "api_operation_detail",
    description:
      "Get the exact operation's inherited parameters, request body, response definitions, security, server overrides, and resolved local schema references. Resolve ambiguity with contractId and exact method/path before executing.",
    inputSchema: { type: "object", properties: selector },
    run: operationDetailText,
  },
  {
    name: "api_list_check",
    description:
      'Check the project\'s API List worksheet (the numbered, planned endpoints) against the saved Swagger contracts. Each row is reported as documented, path differs (with the nearest Swagger path), method differs, or not in Swagger. Select rows by number or range (e.g. "71", "68-70, 49"), filter by text, or show only mismatches.',
    inputSchema: {
      type: "object",
      properties: {
        no: str("API List row numbers or ranges, e.g. 28-32"),
        query: str("Text to find in endpoint, description, or other columns"),
        issuesOnly: { type: "boolean" },
      },
    },
    run: apiListCheckText,
  },
  {
    name: "link_task_api",
    description:
      'Resolve the endpoints one project task needs: the API List rows it cites ("sheet list api nomor 28-32", "endpoint nomor 66") and /api paths in its text, each checked against Swagger with the exact documented method, path and contract. Use before implementing or testing a task\'s API integration. Pass sheet and row when a task number repeats.',
    inputSchema: {
      type: "object",
      properties: {
        taskNo: str("Task number or ID"),
        sheet: str("Worksheet name, when the task number repeats"),
        row: { type: "integer", minimum: 2, description: "Sheet row" },
      },
      required: ["taskNo"],
    },
    run: linkTaskApiText,
  },
  {
    name: "kern_doctor",
    description:
      "Diagnose Kern's tool context for this chat: node version, project and task source (sync state, selected worksheets and PIC), status writes, Swagger contracts, API List, and the tools offered. Use when a Kern tool fails or returns unexpectedly empty data, and report the findings to the user.",
    inputSchema: { type: "object", properties: {} },
    run: async (_input, env) => (await doctorReport(env)).text,
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

/** complete_pr_review exists only in Kern PR review chats, update_task_status
 * only with a configured sheet writer, Swagger tools only with saved
 * contracts, API List tools only with a configured API List worksheet. */
export function toolsFor(env = process.env) {
  const offered = {
    complete_pr_review: env.CRC_PR_REVIEW === "1",
    update_task_status: env.CRC_TASK_WRITABLE === "1",
    api_find_operations: Boolean(env.CRC_API_CONTRACTS_PATH),
    api_operation_detail: Boolean(env.CRC_API_CONTRACTS_PATH),
    api_list_check: Boolean(env.CRC_API_LIST_PATH),
    link_task_api: Boolean(env.CRC_API_LIST_PATH || env.CRC_API_CONTRACTS_PATH),
  };
  return TOOLS.filter((tool) => offered[tool.name] ?? true);
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
          "Kern Studio app tools: project tasks (details, statuses, approved status changes), Swagger contracts and the API List worksheet, Kanban tracking, and the app-owned delivery pipeline. When a Kern tool fails or returns unexpectedly empty data, call kern_doctor and report its findings.",
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

// Compare as URLs: the installed path ("Application Support") contains spaces,
// which import.meta.url percent-encodes, and node resolves symlinks for it.
function isMain() {
  try {
    return (
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
}

// `node kern-mcp.mjs --doctor` prints the same report as the kern_doctor tool.
if (isMain() && process.argv.includes("--doctor"))
  doctorReport().then(({ ok, text }) => {
    process.stdout.write(`${text}\n`);
    process.exitCode = ok ? 0 : 1;
  });
else if (isMain()) serve();
