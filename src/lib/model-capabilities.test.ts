import { describe, expect, it } from "vitest";
import { imageSupport, modelInputs } from "./model-capabilities";

const inputs = modelInputs([
  { provider: "anthropic", id: "claude", input: ["text", "image"] },
  { provider: "deepseek", id: "v4", input: ["text"] },
  { provider: "kern-9router", id: "ar/gpt", input: ["text"] },
  { provider: "local", id: "bare" },
]);
const undeclared = new Set(["kern-9router/ar/gpt"]);
const pi = (model: string) =>
  imageSupport({
    harness: "pi",
    model,
    inputs,
    undeclared,
    harnessImage: null,
  });

describe("imageSupport", () => {
  it("trusts pi's declared input", () => {
    expect(pi("anthropic/claude")).toBe(true);
    expect(pi("deepseek/v4")).toBe(false);
  });

  it("treats models.json entries without input as unknown", () => {
    // pi reports ["text"] for it, but that is only pi's default.
    expect(pi("kern-9router/ar/gpt")).toBeNull();
  });

  it("is unknown for models pi has not described", () => {
    expect(pi("local/bare")).toBeNull();
    expect(pi("")).toBeNull();
  });

  it("asks ACP agents themselves", () => {
    const acp = (harnessImage: boolean | null) =>
      imageSupport({
        harness: "claude-code",
        model: "anthropic/claude",
        inputs,
        undeclared,
        harnessImage,
      });
    expect(acp(false)).toBe(false);
    expect(acp(true)).toBe(true);
    expect(acp(null)).toBeNull();
  });
});
