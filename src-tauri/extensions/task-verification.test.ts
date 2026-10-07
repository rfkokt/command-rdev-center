// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import verification, { workspaceFingerprint } from "./task-verification";

const folders: string[] = [];
function repo() {
  const cwd = mkdtempSync(join(tmpdir(), "kern-verification-"));
  folders.push(cwd);
  for (const args of [
    ["init"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.com"],
  ])
    execFileSync("git", args, { cwd });
  writeFileSync(join(cwd, "source.ts"), "const version = 1;\n");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-m", "initial"], { cwd });
  return cwd;
}
function harness(cwd: string, entries: any[] = []) {
  vi.stubEnv("CRC_PROJECT_CWD", cwd);
  vi.stubEnv("CRC_WORKSPACE_REPOSITORIES", "[]");
  const hooks = new Map<string, any>(),
    tools = new Map<string, any>();
  const pi = {
    on: (name: string, fn: any) => hooks.set(name, fn),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: vi.fn(),
    appendEntry: vi.fn((customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
    ),
  };
  verification(pi as any);
  const ctx = {
    sessionManager: { getBranch: () => entries },
    signal: undefined,
    hasPendingMessages: () => false,
    ui: { notify: vi.fn() },
    tools: [],
    executeTool: vi.fn(async () => ({
      isError: false,
      result: {
        content: [{ type: "text", text: "passed" }],
        structuredContent: { exit_code: 0 },
      },
    })),
  };
  const call = (name: string, input: any, signal?: AbortSignal) =>
    tools.get(name).execute("call", input, signal, vi.fn(), ctx);
  const boundary = () =>
    hooks.get("agent_before_settle")(
      { outcome: "completed", continue: false, context: { canContinue: true } },
      ctx,
    );
  return { hooks, ctx, call, boundary, pi, entries };
}
afterEach(() => {
  vi.unstubAllEnvs();
  folders
    .splice(0)
    .forEach((folder) => rmSync(folder, { recursive: true, force: true }));
});

describe("task verification evidence", () => {
  it("does not fall back to a successful check after an interrupted rerun", async () => {
    const h = harness(repo());
    await h.call("set_task_contract", {
      goal: "Fix",
      criteria: ["Works"],
      constraints: [],
    });
    await h.call("run_check", { name: "test", command: "passes" });
    const controller = new AbortController();
    controller.abort();
    await h.call(
      "run_check",
      { name: "test", command: "interrupted" },
      controller.signal,
    );
    await expect(
      h.call("report_task", {
        outcome: "checks_passed",
        acceptance: ["Works"],
        limitations: [],
      }),
    ).rejects.toThrow("No recorded check");
  });
  it("detects tracked, untracked, and committed source changes without changing HEAD/index", async () => {
    const cwd = repo(),
      original = await workspaceFingerprint(cwd);
    expect(original).toBeTruthy();
    writeFileSync(join(cwd, "source.ts"), "const version = 2;\n");
    const changed = await workspaceFingerprint(cwd);
    expect(changed).not.toBe(original);
    writeFileSync(join(cwd, "new.ts"), "new file");
    expect(await workspaceFingerprint(cwd)).not.toBe(changed);
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-m", "updated"], { cwd });
    expect(await workspaceFingerprint(cwd)).not.toBe(original);
    expect(
      execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }),
    ).toBe("");
  });
  it("requires all expected repositories and fingerprints a non-git workspace overlay", async () => {
    const cwd = repo(),
      workspace = mkdtempSync(join(tmpdir(), "kern-overlay-"));
    folders.push(workspace);
    expect(await workspaceFingerprint(workspace, [cwd])).toBeTruthy();
    expect(
      await workspaceFingerprint(workspace, [cwd, join(workspace, "missing")]),
    ).toBeNull();
  });
  it("rejects a success report after an edit and permits an explicit limitation", async () => {
    const cwd = repo(),
      h = harness(cwd);
    await h.hooks.get("before_agent_start")({ prompt: "Fix version" }, h.ctx);
    await h.call("set_task_contract", {
      goal: "Fix version",
      criteria: ["Version is correct"],
      constraints: [],
    });
    await h.call("run_check", {
      name: "focused test",
      command: "test command",
    });
    writeFileSync(join(cwd, "source.ts"), "const version = 2;\n");
    await expect(
      h.call("report_task", {
        outcome: "checks_passed",
        acceptance: ["Version fixed"],
        limitations: [],
      }),
    ).rejects.toThrow("No recorded check");
    await h.call("report_task", {
      outcome: "complete_with_limitations",
      acceptance: ["Version fixed"],
      limitations: ["Tests unavailable"],
    });
    expect((await h.boundary()).entries[0].content).toContain(
      "complete_with_limitations",
    );
  });
  it("rejects failed and source-mutating checks, then accepts a successful rerun", async () => {
    const cwd = repo(),
      h = harness(cwd);
    await h.call("set_task_contract", {
      goal: "Fix",
      criteria: ["Works"],
      constraints: [],
    });
    h.ctx.executeTool.mockResolvedValueOnce({
      isError: true,
      result: { content: [], structuredContent: { exit_code: 1 } },
    } as any);
    await h.call("run_check", { name: "test", command: "fails" });
    const report = {
      outcome: "checks_passed",
      acceptance: ["Works"],
      limitations: [],
    };
    await expect(h.call("report_task", report)).rejects.toThrow("failed");
    await h.call("run_check", { name: "test", command: "passes" });
    expect((await h.call("report_task", report)).details.outcome).toBe(
      "checks_passed",
    );
    h.ctx.executeTool.mockImplementationOnce(async () => {
      writeFileSync(join(cwd, "source.ts"), "changed by check");
      return {
        isError: false,
        result: { content: [], structuredContent: { exit_code: 0 } },
      } as any;
    });
    await h.call("run_check", { name: "generator", command: "changes source" });
    await expect(h.call("report_task", report)).rejects.toThrow(
      "No recorded check",
    );
  });
  it("requests at most one recovery, reports incomplete, and restores ledger from the active branch", async () => {
    const cwd = repo(),
      h = harness(cwd);
    await h.hooks.get("before_agent_start")({ prompt: "Fix" }, h.ctx);
    await h.call("set_task_contract", {
      goal: "Fix",
      criteria: ["Works"],
      constraints: ["Keep API"],
    });
    expect((await h.boundary()).continue).toBe(true);
    const final = await h.boundary();
    expect(final.continue).not.toBe(true);
    expect(final.entries[0].content).toContain("incomplete");
    const resumed = harness(cwd, h.entries);
    resumed.hooks.get("session_start")({}, resumed.ctx);
    const result = await resumed.hooks.get("before_agent_start")(
      { prompt: "Continue" },
      resumed.ctx,
    );
    expect(result.message.content).toContain("Keep API");
  });
  it("does not add a verification continuation to a read-only request or an abort", async () => {
    const h = harness(repo());
    await h.hooks.get("before_agent_start")(
      { prompt: "Explain source" },
      h.ctx,
    );
    h.hooks.get("tool_result")({
      toolName: "write",
      input: { path: "memory.md" },
      isError: false,
    });
    expect(await h.boundary()).toBeUndefined();
    await h.call("set_task_contract", {
      goal: "Fix",
      criteria: ["Works"],
      constraints: [],
    });
    const result = await h.hooks.get("agent_before_settle")(
      { outcome: "aborted", continue: false, context: { canContinue: true } },
      h.ctx,
    );
    expect(result.continue).not.toBe(true);
    expect(result.entries[0].content).toContain("incomplete");
  });
  it("invalidates a report when files change before settlement", async () => {
    const cwd = repo(),
      h = harness(cwd);
    await h.call("set_task_contract", {
      goal: "Fix",
      criteria: ["Works"],
      constraints: [],
    });
    await h.call("run_check", { name: "test", command: "passes" });
    await h.call("report_task", {
      outcome: "checks_passed",
      acceptance: ["Works"],
      limitations: [],
    });
    writeFileSync(join(cwd, "source.ts"), "late formatting/edit");
    expect((await h.boundary()).entries[0].content).toContain("Source changed");
  });
});
