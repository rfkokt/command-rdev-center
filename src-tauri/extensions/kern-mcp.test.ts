import { spawn } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
// @ts-expect-error plain ESM module without type declarations
import { handle, TOOL_NAMES } from "./kern-mcp.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function taskEnv(items: unknown, kind = "local") {
  const dir = mkdtempSync(join(tmpdir(), "kern-mcp-"));
  writeFileSync(join(dir, "demo.json"), JSON.stringify(items));
  return {
    CRC_TASK_DIR: dir,
    CRC_PROJECT_NAME: "demo",
    CRC_TASK_SOURCE_KIND: kind,
  };
}

const call = (name: string, args: unknown, env = {}) =>
  handle(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
    env,
  );

describe("kern MCP server", () => {
  test("initialize echoes the client protocol and lists tools", async () => {
    const init = await handle({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {} },
    });
    expect(init.result.protocolVersion).toBe("2025-03-26");
    expect(init.result.capabilities.tools).toBeDefined();
    const list = await handle(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { CRC_PR_REVIEW: "0" },
    );
    const names = list.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(
      TOOL_NAMES.filter(
        (name: string) =>
          name !== "complete_pr_review" &&
          name !== "update_task_status" &&
          !name.startsWith("api_"),
      ),
    );
    expect(names).toContain("track_kanban_task");
    const review = await handle(
      { jsonrpc: "2.0", id: 9, method: "tools/list" },
      { CRC_PR_REVIEW: "1" },
    );
    expect(
      review.result.tools.map((tool: { name: string }) => tool.name),
    ).toContain("complete_pr_review");
    const blocked = await handle(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "complete_pr_review", arguments: {} },
      },
      { CRC_PR_REVIEW: "0" },
    );
    expect(blocked.error.message).toContain("Unknown tool");
    for (const tool of list.result.tools)
      expect(tool.inputSchema.type).toBe("object");
    expect(
      await handle({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeNull();
    expect(
      (await handle({ jsonrpc: "2.0", id: 2, method: "resources/list" })).error
        .code,
    ).toBe(-32601);
  });

  test("signal tools validate input and acknowledge", async () => {
    expect(
      (await call("track_kanban_task", { status: "Done", description: "x" }))
        .result.content[0].text,
    ).toBe("Kanban task marked Done.");
    const bad = await call("control_pipeline", { action: "nuke" });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toContain("retry, skip, cancel");
    expect((await call("run_pipeline", {})).result.isError).toBe(true);
    expect((await call("nope", {})).error.code).toBe(-32602);
  });

  test("project task tools read the Kern task file", async () => {
    const env = taskEnv([
      { no: 1, deskripsi: "Login page", status: "To Do", pic: "Rdev" },
      { no: 2, deskripsi: "Done thing", status: "Done" },
      { no: 3, deskripsi: "Lihat poin 1", status: "Backlog", notes: "n" },
    ]);
    const list = (await call("list_project_tasks", {}, env)).result.content[0]
      .text;
    expect(list).toContain("Login page");
    expect(list).not.toContain("Done thing");
    const detail = (await call("get_project_task", { taskNo: "#3" }, env))
      .result.content[0].text;
    expect(detail).toContain("# Task #3");
    expect(detail).toContain("## Referenced task #1");
    const missing = await call("get_project_task", { taskNo: "9" }, env);
    expect(missing.result.isError).toBe(true);
    const noContext = await call("list_project_tasks", {}, {});
    expect(noContext.result.content[0].text).toContain("unavailable");
  });

  test("google sheets source refuses to guess when the cache reports an error", async () => {
    const env = taskEnv([], "google_sheets");
    mkdirSync(join(env.CRC_TASK_DIR, ".cache"));
    writeFileSync(join(env.CRC_TASK_DIR, ".cache", "demo.json"), "[]");
    writeFileSync(
      join(env.CRC_TASK_DIR, ".cache", "demo.meta.json"),
      JSON.stringify({ error: "403" }),
    );
    const result = await call("list_project_tasks", {}, env);
    expect(result.result.content[0].text).toContain("Do not infer");
  });

  test("serves the saved Swagger catalog when contracts exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kern-mcp-api-"));
    const path = join(dir, "contracts.json");
    writeFileSync(
      path,
      JSON.stringify([
        {
          id: "transaction-crew-service",
          origin: "https://api.example.com",
          base_url: "https://api.example.com/gateway",
          source_url: "https://api.example.com/v3/api-docs",
          document: {
            paths: {
              "/presensi/roster/non-roster": {
                post: {
                  operationId: "presensiNonRoster",
                  requestBody: {
                    content: {
                      "application/json": {
                        schema: { $ref: "#/components/schemas/Filter" },
                      },
                    },
                  },
                },
              },
            },
            components: {
              schemas: {
                Filter: {
                  type: "object",
                  properties: { sort: { type: "string" } },
                },
              },
            },
          },
        },
      ]),
    );
    const names = async (env: object) =>
      (
        await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, env)
      ).result.tools.map((tool: { name: string }) => tool.name);
    expect(await names({})).not.toContain("api_find_operations");
    const env = { CRC_API_CONTRACTS_PATH: path };
    expect(await names(env)).toEqual(
      expect.arrayContaining(["api_find_operations", "api_operation_detail"]),
    );
    const found = JSON.parse(
      (await call("api_find_operations", { query: "non-roster" }, env)).result
        .content[0].text,
    );
    expect(found.operations[0].operationId).toBe("presensiNonRoster");
    const detail = await call(
      "api_operation_detail",
      { method: "POST", path: "/presensi/roster/non-roster" },
      env,
    );
    expect(detail.result.isError).toBeUndefined();
    expect(detail.result.content[0].text).toContain('"sort"');
    const missing = await call(
      "api_operation_detail",
      { method: "GET", path: "/nope" },
      env,
    );
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0].text).toContain("api_find_operations");
  });

  test("kern-openapi.mjs matches its TypeScript sources", async () => {
    // @ts-expect-error plain ESM script without type declarations
    const { bundle } = await import("../../scripts/build-kern-openapi.mjs");
    expect(readFileSync(join(here, "kern-openapi.mjs"), "utf8")).toBe(
      await bundle(),
    );
  }, 30_000);

  test("status changes are checked against the synced tasks", async () => {
    const env = {
      ...taskEnv([], "google_sheets"),
      CRC_TASK_WRITABLE: "1",
    };
    mkdirSync(join(env.CRC_TASK_DIR, ".cache"));
    writeFileSync(
      join(env.CRC_TASK_DIR, ".cache", "demo.json"),
      JSON.stringify([
        {
          no: "352",
          status: "Testing",
          pic: "Rifky",
          _sheet: "Backlogs",
          _row: 214,
        },
        {
          no: "329",
          status: "Done",
          pic: "Rifky",
          _sheet: "Backlogs",
          _row: 190,
        },
        {
          no: "329",
          status: "Testing",
          pic: "Rifky",
          _sheet: "Backlogs",
          _row: 201,
        },
      ]),
    );
    writeFileSync(
      join(env.CRC_TASK_DIR, ".cache", "demo.meta.json"),
      JSON.stringify({
        state: "ok",
        sheets: ["Backlogs"],
        pics: ["Rifky"],
        statuses: ["Testing", "Done"],
        writable: true,
      }),
    );
    const text = async (name: string, args: object) =>
      (await call(name, args, env)).result.content[0].text;
    expect(await text("list_task_statuses", {})).toContain(
      "Statuses used in Backlogs: Testing, Done",
    );
    expect(
      await text("update_task_status", { taskNo: "#352", status: "Done" }),
    ).toContain("Requested #352 (Backlogs row 214): Testing → Done.");
    expect(
      await text("update_task_status", { taskNo: "329", status: "Done" }),
    ).toContain("ambiguous: Backlogs row 190, Backlogs row 201");
    expect(
      await text("update_task_status", {
        taskNo: "329",
        status: "Ready to QA",
        row: 201,
      }),
    ).toContain('"Ready to QA" is not used');
    expect(
      await text("update_task_status", { taskNo: "400", status: "Done" }),
    ).toContain("not among this project's tasks for the selected PIC (Rifky)");
    const hidden = await handle(
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      { ...env, CRC_TASK_WRITABLE: "0" },
    );
    expect(
      hidden.result.tools.map((tool: { name: string }) => tool.name),
    ).not.toContain("update_task_status");
  });

  test("an empty task list says why", async () => {
    const env = taskEnv([], "google_sheets");
    const unsynced = await call("list_project_tasks", {}, env);
    expect(unsynced.result.content[0].text).toContain("project_not_found");
    mkdirSync(join(env.CRC_TASK_DIR, ".cache"));
    writeFileSync(join(env.CRC_TASK_DIR, ".cache", "demo.json"), "[]");
    writeFileSync(
      join(env.CRC_TASK_DIR, ".cache", "demo.meta.json"),
      JSON.stringify({
        state: "no_tasks_for_pic",
        sheets: ["Backlogs"],
        pics: ["Rifky"],
        total: 133,
        count: 0,
        syncedAt: 0,
      }),
    );
    const text = (await call("list_project_tasks", {}, env)).result.content[0]
      .text;
    expect(text).toContain("Why empty (no_tasks_for_pic)");
    expect(text).toContain("Read 133 rows");
    expect(text).toContain("worksheets Backlogs · PIC Rifky");
  });

  test("speaks newline-delimited JSON-RPC over stdio", async () => {
    // Installed under "Application Support": the path contains a space.
    const installed = join(
      mkdtempSync(join(tmpdir(), "kern-mcp-")),
      "Application Support",
    );
    mkdirSync(installed);
    copyFileSync(join(here, "kern-mcp.mjs"), join(installed, "kern-mcp.mjs"));
    const child = spawn(process.execPath, [join(installed, "kern-mcp.mjs")], {
      env: { ...process.env, CRC_PR_REVIEW: "0" },
    });
    const lines: string[] = [];
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      lines.push(...parts.filter(Boolean));
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
    );
    child.stdin.write("not json\n");
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5000);
      const poll = setInterval(() => {
        if (lines.length >= 3) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      }, 20);
    });
    child.kill();
    const parsed = lines.map((line) => JSON.parse(line));
    expect(parsed.find((m) => m.id === 1).result.serverInfo.name).toBe("kern");
    expect(parsed.some((m) => m.error?.code === -32700)).toBe(true);
    expect(parsed.find((m) => m.id === 2).result.tools.length).toBe(
      TOOL_NAMES.length - 4,
    );
  });
});
