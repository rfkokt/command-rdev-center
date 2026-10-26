// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function registered(flag: string) {
  vi.stubEnv("CRC_PR_REVIEW", flag);
  const { default: runner } = await import("./pipeline-runner");
  const names: string[] = [];
  runner({
    on: vi.fn(),
    registerTool: (tool: { name: string }) => names.push(tool.name),
  } as any);
  return names;
}

test("complete_pr_review is registered only in PR review chats", async () => {
  expect(await registered("0")).not.toContain("complete_pr_review");
  expect(await registered("1")).toContain("complete_pr_review");
});
