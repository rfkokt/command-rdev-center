import { describe, expect, it } from "vitest";
import { runtimePrompt, type PromptEngine } from "./prompt-engines";

const engine = (enabled: boolean, mode: "auto" | "review"): PromptEngine => ({
  version: 1,
  id: "x",
  name: "X",
  icon: "X",
  description: "",
  system_prompt: "FORMAT AS JSON",
  starter_message: "Start",
  model: "",
  thinking: "",
  research: { enabled, mode, instructions: "Prefer primary sources." },
  created_at: 1,
  updated_at: 1,
});

describe("runtimePrompt", () => {
  it("does not alter engines without research", () =>
    expect(runtimePrompt(engine(false, "auto"))).toBe("FORMAT AS JSON"));
  it("preserves output instructions while adding source review", () => {
    const prompt = runtimePrompt(engine(true, "review"));
    expect(prompt).toContain("FORMAT AS JSON");
    expect(prompt).toContain("ask the user to approve or remove sources");
    expect(prompt).toContain("Prefer primary sources.");
  });
});
