import { describe, expect, it } from "vitest";
import type { ToolCall } from "../lib/rpc";
import { buildRunSteps, describeStep } from "./AgentRunCard";

const tool = (p: Partial<ToolCall> & Pick<ToolCall, "name">): ToolCall => ({
  callId: Math.random().toString(36),
  args: {},
  phase: "end",
  ...p,
});

describe("AgentRunCard steps", () => {
  it("summarizes test runs from runner output", () => {
    expect(
      describeStep(
        tool({
          name: "bash",
          args: { command: "pnpm vitest run" },
          result: " Tests  12 passed (12)",
        }),
      ).label,
    ).toBe("Passed 12 of 12 tests");
    expect(
      describeStep(
        tool({
          name: "bash",
          args: { command: "npx jest" },
          result: "Tests: 1 failed, 11 passed, 12 total",
          isError: true,
        }),
      ),
    ).toMatchObject({ label: "Failed 1 of 12 tests", failed: true });
  });

  it("names the pushed branch and uses tense by phase", () => {
    const push = { name: "bash", args: { command: "git push origin fix/x" } };
    expect(describeStep(tool({ ...push, phase: "start" })).label).toBe(
      "Pushing fix/x",
    );
    expect(describeStep(tool(push)).label).toBe("Pushed fix/x");
  });

  it("collapses consecutive finished edits", () => {
    const steps = buildRunSteps([
      tool({ name: "grep", args: { pattern: "foo" }, result: "a\nb" }),
      ...[1, 2, 3].map((n) =>
        tool({ name: "edit", args: { path: `src/f${n}.ts` } }),
      ),
      tool({ name: "edit", args: { path: "src/live.ts" }, phase: "start" }),
    ]);
    expect(steps.map((s) => s.label)).toEqual([
      "Found 2 matches for “foo”",
      "Edited 3 files",
      "Editing src/live.ts",
    ]);
  });
});
