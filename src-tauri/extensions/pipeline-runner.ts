import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "run_pipeline",
    label: "Run configured pipeline",
    description:
      "Request the app-owned saved pipeline for this project. Use only when the user explicitly asks to run the pipeline. The host app executes saved commands; this tool never accepts commands.",
    promptGuidelines: [
      "Call run_pipeline only when the user explicitly asks to run the project's pipeline.",
    ],
    parameters: Type.Object({ confirm: Type.Literal(true) }),
    async execute(_id, input) {
      return {
        content: [{ type: "text", text: "Pipeline run requested." }],
        details: input,
      };
    },
  });
  pi.registerTool({
    name: "provide_pipeline_input",
    label: "Provide reviewed pipeline input",
    description:
      "Submit an AI commit proposal after inspecting the current worktree diff. The host app always asks the user before forwarding it.",
    parameters: Type.Object({
      message: Type.String({
        description: "One-line conventional commit message",
      }),
      paths: Type.Array(Type.String(), {
        minItems: 1,
        description: "Explicit relative modified file paths",
      }),
    }),
    async execute(_id, input) {
      return {
        content: [
          {
            type: "text",
            text: "Pipeline input proposal submitted for user review.",
          },
        ],
        details: input,
      };
    },
  });
  pi.registerTool({
    name: "control_pipeline",
    label: "Control pipeline",
    description:
      "Retry, skip, or cancel the active app-owned pipeline. Use retry after safely fixing an ai_fix failure; use skip or cancel only after user confirmation.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("retry"),
        Type.Literal("skip"),
        Type.Literal("cancel"),
      ]),
    }),
    async execute(_id, input) {
      return {
        content: [
          { type: "text", text: `Pipeline ${input.action} requested.` },
        ],
        details: input,
      };
    },
  });
}
