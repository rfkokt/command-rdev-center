import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "track_kanban_task",
    label: "Track Kanban task",
    description: "Create or update the current chat's Kanban task. Call with In Progress only when you decide the user requested actionable work worth tracking; do not call for questions or discussion. Call with Done only when the user explicitly accepts the completed work.",
    promptSnippet: "Track actionable work in the local Kanban",
    promptGuidelines: ["Use track_kanban_task when you decide a user request is actionable work worth tracking; do not ask permission and do not use language/keyword heuristics."],
    parameters: Type.Object({
      status: Type.Union([Type.Literal("In Progress"), Type.Literal("Done")]),
      description: Type.String({ description: "Concise task description" }),
    }),
    async execute(_id, input) {
      return { content: [{ type: "text", text: `Kanban task marked ${input.status}.` }], details: input };
    },
  });
}
