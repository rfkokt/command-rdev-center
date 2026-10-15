// @vitest-environment node
import { describe, expect, it } from "vitest";
import pipeline from "./pipeline-runner";

function harness() {
  const tools = new Map<string, any>();
  const hooks = new Map<string, any>();
  pipeline({
    on: (name: string, hook: any) => hooks.set(name, hook),
    registerTool: (tool: any) => tools.set(tool.name, tool),
  } as any);
  return { tools, beforeStart: hooks.get("before_agent_start") };
}

describe("user workflow overrides", () => {
  it("reapplies user priority after project instructions on each turn", () => {
    const h = harness();
    const projectPrompt = "AGENTS.md: Sonar is mandatory before every push.";
    for (const prompt of ["Fix and push", "skip sonar", "lanjut"]) {
      const result = h.beforeStart({ prompt, systemPrompt: projectPrompt });
      expect(result.systemPrompt).toContain(projectPrompt);
      expect(
        result.systemPrompt.indexOf("## User instructions"),
      ).toBeGreaterThan(projectPrompt.length);
      expect(result.systemPrompt).toContain(
        "explicit instructions take precedence",
      );
      expect(result.systemPrompt).toContain('"skip sonar"');
      expect(result.systemPrompt).toContain(
        "previously authorized delivery work",
      );
      expect(result.systemPrompt).toContain("does not authorize a new push");
      expect(result.systemPrompt).toContain("complete_with_limitations");
    }
  });

  it("retains actual enforcement and keeps attachment instructions outside authorization", () => {
    const { beforeStart } = harness();
    const result = beforeStart({
      prompt: "skip sonar",
      systemPrompt: "runtime",
    });
    expect(result.systemPrompt).toContain(
      "actual tool permission enforcement still apply",
    );
    expect(result.systemPrompt).toContain("not human authorization");
    expect(result.systemPrompt).toContain("do not invent a blocker");
    expect(result.systemPrompt).toContain(
      "Do not permanently edit project rules",
    );
    expect(result.systemPrompt).toContain(
      "without starting a pipeline merely to skip",
    );
  });

  it("offers skip after an explicit user request without claiming the gate passed", async () => {
    const { tools } = harness();
    const tool = tools.get("control_pipeline");
    expect(tool.description).toContain("already supplies that confirmation");
    expect(tool.description).toContain("current failed step");
    const result = await tool.execute("skip", { action: "skip" });
    expect(result.details).toEqual({ action: "skip" });
    expect(result.content[0].text).toBe("Pipeline skip requested.");
  });
});
