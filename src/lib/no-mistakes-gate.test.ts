import { describe, expect, it } from "vitest";
import {
  askUserFindings,
  noMistakesDecisionPrompt,
  noMistakesGateKey,
  parseNoMistakesGate,
  readNoMistakesOutput,
  readNoMistakesToolResult,
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

const NESTED_GATE = `run:
  id: 01M6JF4T2HYJ6FNB00R6E33H5H
  branch: crc/command-rdev-center-179326255173
  status: running
  steps[9]{step,status,findings}:
    rebase,completed,0
    review,awaiting_approval,3
    test,pending,0
gate:
  step: review
  status: awaiting_approval
  risk: medium
  note: "Review auto-fix is disabled, so findings park for your decision."
  findings[3]{id,severity,file,action,description}:
    stale-gate,warning,src/components/ChatView.tsx,auto-fix,The gate state only gets set
    hidden-tab-modal,warning,src/components/ChatView.tsx,ask-user,"The dialog renders, even in hidden tabs"
    failed-send-dup,info,src/components/ChatView.tsx,no-op,Duplicate user message on retry
help[2]:
  Run \`no-mistakes axi respond --action approve\` to accept this step and continue
  Run \`no-mistakes axi respond --action skip\` to skip this step`;

describe("parseNoMistakesGate", () => {
  it("parses the nested gate layout from axi run/respond", () => {
    const gate = parseNoMistakesGate(NESTED_GATE);
    expect(gate?.step).toBe("review");
    expect(gate?.findings.map((finding) => finding.id)).toEqual([
      "stale-gate",
      "hidden-tab-modal",
      "failed-send-dup",
    ]);
    expect(gate?.findings[1]).toEqual({
      id: "hidden-tab-modal",
      severity: "warning",
      file: "src/components/ChatView.tsx",
      line: "",
      action: "ask-user",
      description: "The dialog renders, even in hidden tabs",
    });
    const indented = NESTED_GATE.split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    expect(readNoMistakesOutput(indented)).toBeNull();
  });

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

  it("tells no-mistakes output without a pending gate from other output", () => {
    expect(readNoMistakesOutput("outcome: passed\nrun: abc")).toEqual({
      gate: null,
    });
    expect(readNoMistakesOutput("run:\n  id: abc\n  outcome: passed")).toEqual({
      gate: null,
    });
    expect(readNoMistakesOutput("gate: test\nstatus: waiting")).toEqual({
      gate: null,
    });
    expect(
      readNoMistakesOutput("gate:\n  step: test\n  status: running"),
    ).toEqual({ gate: null });
    expect(readNoMistakesOutput("echo gate: review")).toBeNull();
    expect(readNoMistakesOutput("total 0\nREADME.md")).toBeNull();
  });

  it("ignores indented outcome keys in unrelated output", () => {
    expect(
      readNoMistakesOutput("jobs:\n  build:\n    outcome: success"),
    ).toBeNull();
    expect(
      readNoMistakesOutput("const x = {\n  outcome: passed,\n};"),
    ).toBeNull();
    expect(readNoMistakesOutput(`${GATE}\n  outcome: passed`)?.gate?.step).toBe(
      "review",
    );
  });
});

describe("readNoMistakesToolResult", () => {
  const result = { content: [{ type: "text", text: NESTED_GATE }] };

  it("reads results of no-mistakes axi commands", () => {
    for (const command of [
      "no-mistakes axi run --intent 'x'",
      "no-mistakes axi respond --action approve",
      "cd repo && no-mistakes axi status",
      "no-mistakes axi",
    ])
      expect(readNoMistakesToolResult({ command }, result)?.gate?.step).toBe(
        "review",
      );
  });

  it("leaves results of other commands untouched", () => {
    for (const command of [
      "cat src/lib/no-mistakes-gate.test.ts",
      "rg outcome: src",
      "no-mistakes status",
      "echo no-mistakes-axi",
    ])
      expect(readNoMistakesToolResult({ command }, result)).toBeNull();
    expect(readNoMistakesToolResult({}, result)).toBeNull();
    expect(readNoMistakesToolResult(undefined, result)).toBeNull();
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
