// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import kanban from "./kanban-task";

const folders: string[] = [];
function harness() {
  const cwd = mkdtempSync(join(tmpdir(), "kern-task-"));
  folders.push(cwd);
  mkdirSync(join(cwd, ".cache"));
  vi.stubEnv("CRC_TASK_DIR", cwd);
  vi.stubEnv("CRC_PROJECT_NAME", "demo");
  vi.stubEnv("CRC_TASK_SOURCE_KIND", "local");
  const tools = new Map<string, any>();
  kanban({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
  const write = (path: string, data: any) =>
    writeFileSync(join(cwd, path), JSON.stringify(data));
  const call = (name: string, input: any) =>
    tools.get(name).execute("test", input);
  return { cwd, write, call };
}
afterEach(() => {
  vi.unstubAllEnvs();
  folders
    .splice(0)
    .forEach((folder) => rmSync(folder, { recursive: true, force: true }));
});
describe("task requirements and source identity", () => {
  it("uses the current local task rather than its older cached preview, including notes and references", async () => {
    const h = harness();
    h.write(".cache/demo.json", [
      { no: 12, deskripsi: "Old requirements", status: "Backlog" },
    ]);
    const full = "Detailed requirements ".repeat(30);
    h.write("demo.json", [
      {
        no: 12,
        deskripsi: full + " revisi poin 4",
        notes: "Test every CRUD step",
        status: "Backlog",
        acceptance: { cleanup: true },
      },
      { no: 4, deskripsi: "Reference requirement", status: "Done" },
    ]);
    const result = await h.call("get_project_task", { taskNo: " #12 " });
    expect(result.content[0].text).toContain(full);
    expect(result.content[0].text).toContain("Test every CRUD step");
    expect(result.content[0].text).toContain("Reference requirement");
    expect(result.content[0].text).toContain('{"cleanup":true}');
    expect(result.details.cached).toBe(false);
    expect(result.details.taskNo).toBe("12");
    expect(result.details.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(result.details.requirements.no).toBe(12);
  });
  it("does not select the first duplicate task number or silently replace invalid local data with cache", async () => {
    const h = harness();
    h.write("demo.json", [
      { no: 12, deskripsi: "A" },
      { no: 12, deskripsi: "B" },
    ]);
    await expect(h.call("get_project_task", { taskNo: "12" })).rejects.toThrow(
      "ambiguous",
    );
    writeFileSync(join(h.cwd, "demo.json"), "invalid json");
    h.write(".cache/demo.json", [{ no: 12, deskripsi: "Old cached task" }]);
    await expect(
      h.call("get_project_task", { taskNo: "12" }),
    ).rejects.toThrow();
  });
  it("uses the configured Sheets cache and reports source failures instead of inventing no tasks", async () => {
    const h = harness();
    vi.stubEnv("CRC_TASK_SOURCE_KIND", "google_sheets");
    h.write("demo.json", [{ no: 12, deskripsi: "Unrelated local task" }]);
    h.write(".cache/demo.json", [
      { no: 12, deskripsi: "Sheet requirements", status: "To Do" },
    ]);
    expect(
      (await h.call("get_project_task", { taskNo: "12" })).details.cached,
    ).toBe(true);
    const list = await h.call("list_project_tasks", {});
    expect(list.details.taskIds).toEqual(["12"]);
    h.write(".cache/demo.meta.json", { error: "Sheets timeout" });
    await expect(h.call("get_project_task", { taskNo: "12" })).rejects.toThrow(
      "Do not infer that no tasks exist",
    );
  });
});
