import { describe, expect, it } from "vitest";
import type { ToolCall } from "../../lib/rpc";
import { buildCrew, DONE_HOLD_MS, subagentTasks } from "./office-crew";

const tool = (p: Partial<ToolCall> & Pick<ToolCall, "name">): ToolCall => ({
  callId: Math.random().toString(36).slice(2),
  args: {},
  phase: "end",
  ...p,
});
const member = (crew: ReturnType<typeof buildCrew>, id: string) =>
  crew.members.find((m) => m.id === id)!;

describe("buildCrew", () => {
  it("puts each running tool on its specialist", () => {
    const crew = buildCrew(
      [
        tool({ name: "read", args: { path: "src/a.ts" } }),
        tool({
          name: "bash",
          args: { command: "pnpm vitest run" },
          phase: "start",
        }),
      ],
      { running: true, now: 1000, timing: () => ({ start: 0, end: 100 }) },
    );
    expect(member(crew, "bob")).toMatchObject({
      status: "working",
      text: "Running tests",
    });
    expect(member(crew, "ada").status).toBe("done");
    expect(member(crew, "kern").status).toBe("idle");
  });

  it("fades a finished member back to idle while the run continues", () => {
    const tools = [tool({ name: "read", args: { path: "a.ts" } })];
    const timing = () => ({ start: 0, end: 1000 });
    expect(
      member(buildCrew(tools, { running: true, now: 2000, timing }), "ada")
        .status,
    ).toBe("done");
    expect(
      member(
        buildCrew(tools, {
          running: true,
          now: 1000 + DONE_HOLD_MS + 1,
          timing,
        }),
        "ada",
      ).status,
    ).toBe("idle");
  });

  it("marks failures and keeps results once the run ends", () => {
    const crew = buildCrew(
      [
        tool({
          name: "bash",
          args: { command: "npx jest" },
          result: "Tests: 1 failed, 11 passed, 12 total",
          isError: true,
        }),
        tool({ name: "edit", args: { path: "a.ts" } }),
      ],
      { running: false, now: 99_999, timing: () => ({ start: 0, end: 10 }) },
    );
    expect(member(crew, "bob")).toMatchObject({
      status: "error",
      text: "Failed 1 of 12 tests",
    });
    expect(member(crew, "linus").status).toBe("done");
    expect(member(crew, "kern")).toMatchObject({ status: "done" });
  });

  it("shows Kern thinking between tools", () => {
    const crew = buildCrew([], { running: true, now: 0 });
    expect(member(crew, "kern")).toMatchObject({
      status: "working",
      text: "Thinking…",
    });
    expect(
      member(buildCrew([], { running: true, writing: true }), "kern").text,
    ).toBe("Writing the response…");
  });

  it("spreads parallel sub-agent tasks over helpers, keeping each at one desk", () => {
    const sub = (results: unknown[], phase: ToolCall["phase"]) =>
      tool({
        callId: "sub",
        name: "subagent",
        phase,
        args: {
          tasks: [
            { agent: "scout", task: "Map the billing module" },
            { agent: "reviewer", task: "Review proration math" },
            { agent: "tester", task: "Write edge-case tests" },
          ],
        },
        result: { details: { results } },
      });
    const owners = (crew: ReturnType<typeof buildCrew>) =>
      Object.fromEntries(
        crew.members.flatMap((m) =>
          m.steps.filter((s) => s.via).map((s) => [s.via, m.id]),
        ),
      );
    const early = buildCrew([sub([{ exitCode: 0 }], "start")], {
      running: true,
      now: 0,
    });
    const late = buildCrew(
      [sub([{ exitCode: 0 }, { exitCode: 0 }, { exitCode: 1 }], "end")],
      { running: true, now: 0 },
    );
    expect(new Set(Object.values(owners(early))).size).toBe(3);
    expect(owners(late)).toEqual(owners(early));
    const byAgent = (crew: ReturnType<typeof buildCrew>, via: string) =>
      crew.members.find((m) => m.steps.some((s) => s.via === via))!;
    expect(byAgent(early, "scout").status).toBe("done");
    expect(byAgent(early, "tester")).toMatchObject({
      status: "working",
      text: "tester: Write edge-case tests",
    });
    expect(byAgent(late, "tester").status).toBe("error");
  });

  it("reads chain and single sub-agent shapes", () => {
    expect(
      subagentTasks(
        tool({
          name: "subagent",
          args: {
            chain: [
              { agent: "a", task: "x" },
              { agent: "b", task: "y" },
            ],
          },
        }),
      ).map((t) => t.agent),
    ).toEqual(["a", "b"]);
    expect(
      subagentTasks(
        tool({ name: "subagent", args: { agent: "solo", task: "z" } }),
      ),
    ).toEqual([{ agent: "solo", task: "z", state: undefined }]);
  });
});
