import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "report_recurring_error",
    label: "Draft recurring error report",
    description: "After the user explicitly agrees, draft a backlog task for a verified application error so it can be prevented later. The host shows the draft for final approval before saving it.",
    promptGuidelines: ["Only call after identifying a real application error and the user explicitly agrees to report it. Include a concrete root cause and prevention.", "Do not use this for ordinary command failures that were fixed during the current task unless the user asks to report them."],
    parameters: Type.Object({
      title: Type.String({ description: "Short error summary" }),
      rootCause: Type.String({ description: "Verified technical root cause" }),
      prevention: Type.String({ description: "Concrete change or check preventing recurrence" }),
    }),
    async execute(_id, input) {
      return { content: [{ type: "text", text: "Error report draft submitted for final review." }], details: input };
    },
  });
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
