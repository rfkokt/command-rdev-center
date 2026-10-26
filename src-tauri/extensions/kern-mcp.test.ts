import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
      TOOL_NAMES.filter((name) => name !== "complete_pr_review"),
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
      TOOL_NAMES.length - 1,
    );
  });
});
