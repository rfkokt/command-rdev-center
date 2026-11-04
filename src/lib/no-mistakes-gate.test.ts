import { describe, expect, it } from "vitest";
import {
  askUserFindings,
  noMistakesDecisionPrompt,
  noMistakesGateKey,
  parseNoMistakesGate,
  toolResultText,
} from "./no-mistakes-gate";

const GATE = `run: 01M60N54XEZZYSGP2DXX8Z8201
gate: review
note: Review auto-fix is disabled by default (auto_fix.review: 0), so blocking and ask-user review findings park for your decision.
findings[3]{id,severity,file,line,action,description}:
  r1,warning,internal/pipeline/executor.go,,auto-fix,Error from os.Remove is ignored
  r2,error,cmd/no-mistakes/main.go,42,ask-user,"New --force flag, bypasses the \\"confirm\\" prompt"
  r3,info,src/a.ts,7,ask-user,Unquoted text, with a comma
help[2]:
  Run \`no-mistakes axi respond --action approve\` to accept this step and continue
  Run \`no-mistakes axi respond --action skip\` to skip this step`;

describe("parseNoMistakesGate", () => {
  it("parses gate findings from axi TOON output", () => {
    const gate = parseNoMistakesGate(GATE);
    expect(gate?.step).toBe("review");
    expect(gate?.findings).toHaveLength(3);
    expect(gate?.findings[1]).toEqual({
      id: "r2",
      severity: "error",
      file: "cmd/no-mistakes/main.go",
      line: "42",
      action: "ask-user",
      description: 'New --force flag, bypasses the "confirm" prompt',
    });
    expect(gate?.findings[2].description).toBe("Unquoted text, with a comma");
    expect(askUserFindings(gate!).map((finding) => finding.id)).toEqual([
      "r2",
      "r3",
    ]);
  });

  it("ignores output without a pending gate", () => {
    expect(parseNoMistakesGate("outcome: passed\nrun: abc")).toBeNull();
    expect(parseNoMistakesGate(`${GATE}\noutcome: passed`)).toBeNull();
    expect(parseNoMistakesGate("gate: test\nstatus: waiting")).toBeNull();
    expect(parseNoMistakesGate("echo gate: review")).toBeNull();
  });

  it("reads text from structured tool results", () => {
    expect(
      parseNoMistakesGate(
        toolResultText({ content: [{ type: "text", text: GATE }] }),
      )?.step,
    ).toBe("review");
  });

  it("keys gates by step and finding ids", () => {
    const gate = parseNoMistakesGate(GATE)!;
    expect(noMistakesGateKey(gate)).toBe("review:r1,r2,r3");
  });
});

describe("noMistakesDecisionPrompt", () => {
  const gate = parseNoMistakesGate(GATE)!;

  it("relays a fix selection with guidance and untouched findings", () => {
    const prompt = noMistakesDecisionPrompt(gate, {
      action: "fix",
      findingIds: ["r2"],
      instructions: "Keep --force but require a TTY",
    });
    expect(prompt).toContain("- Fix: r2");
    expect(prompt).toContain("- Leave as is (intended): r3");
    expect(prompt).toContain(
      "- Guidance for the fix: Keep --force but require a TTY",
    );
    expect(prompt).toContain("--action fix");
    expect(prompt).toContain("r1 (auto-fix)");
  });

  it("relays approve and skip decisions", () => {
    expect(noMistakesDecisionPrompt(gate, { action: "approve" })).toContain(
      "--action approve",
    );
    expect(noMistakesDecisionPrompt(gate, { action: "skip" })).toContain(
      "--action skip",
    );
  });
});
