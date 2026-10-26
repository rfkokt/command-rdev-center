// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

async function load(session: string, names: string[]) {
  vi.stubEnv("CRC_WORKSPACE_ROOT", "/workspace");
  vi.stubEnv("CRC_PROJECT_CWD", session);
  vi.stubEnv(
    "CRC_WORKSPACE_REPOSITORIES",
    JSON.stringify(
      names.map((name) => ({
        name,
        root: `/workspace/${name}`,
        baseBranch: "main",
      })),
    ),
  );
  const mod = await import("./workspace-repositories");
  const hooks = new Map<string, any>();
  mod.default({ on: (name: string, fn: any) => hooks.set(name, fn) } as any);
  return hooks;
}

test("single-repository worktree chat: no overlay rules, Git commands are not blocked", async () => {
  const session = mkdtempSync(join(tmpdir(), "kern-single-"));
  dirs.push(session);
  const hooks = await load(session, ["command-rdev-center"]);
  expect(hooks.size).toBe(0);
});

test("multi-repository overlay keeps the explicit git -C guard", async () => {
  const session = mkdtempSync(join(tmpdir(), "kern-multi-"));
  dirs.push(session);
  mkdirSync(join(session, "api"));
  mkdirSync(join(session, "web"));
  const hooks = await load(session, ["api", "web"]);
  const result = hooks.get("tool_call")({
    toolName: "bash",
    input: { command: "git commit -m x" },
  });
  expect(result).toMatchObject({ block: true });
  const prompt = hooks.get("before_agent_start")({ systemPrompt: "base" });
  expect(prompt.systemPrompt).toContain("MULTI-REPOSITORY WORKSPACE");
});
