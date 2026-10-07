import type { ToolCall } from "../lib/rpc";
import { uid } from "./chat-utils";

export function buildPhase(tool: ToolCall) {
  if (tool.phase === "end" || !["bash", "functions.bash"].includes(tool.name))
    return null;
  const command = String(tool.args.command ?? "").toLowerCase();
  if (
    !/(npm|pnpm|yarn|bun|cargo|gradle|mvn|make).*(build|package|compile)|tauri build|vite build|tsc/.test(
      command,
    )
  )
    return null;
  if (command.includes("check:version")) return "Checking app version";
  if (command.includes("tsc")) return "Compiling TypeScript";
  if (command.includes("vite build")) return "Bundling frontend assets";
  if (command.includes("cargo") || command.includes("tauri build"))
    return "Compiling desktop application";
  return "Building project";
}

export function transcriptEntry(raw: string) {
  try {
    const event = JSON.parse(raw) as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "";
    const toolName =
      typeof event.toolName === "string"
        ? event.toolName
        : typeof (event.toolCall as Record<string, unknown> | undefined)
              ?.name === "string"
          ? String((event.toolCall as Record<string, unknown>).name)
          : "tool";
    if (type === "agent_start")
      return { id: uid(), type: "Agent", detail: "Started", at: Date.now() };
    if (type === "agent_end")
      return { id: uid(), type: "Agent", detail: "Finished", at: Date.now() };
    if (type === "agent_settled")
      return { id: uid(), type: "Agent", detail: "Ready", at: Date.now() };
    if (type === "tool_execution_start")
      return {
        id: uid(),
        type: "Tool",
        detail: `Running ${toolName}`,
        at: Date.now(),
      };
    if (type === "tool_execution_end")
      return {
        id: uid(),
        type: "Tool",
        detail: `Finished ${toolName}`,
        at: Date.now(),
      };
    if (type === "auto_retry_end")
      return {
        id: uid(),
        type: "Retry",
        detail: event.success === false ? "Failed" : "Completed",
        at: Date.now(),
      };
    if (type === "compaction_start" || type === "auto_compaction_start")
      return {
        id: uid(),
        type: "Context",
        detail: "Compaction started",
        at: Date.now(),
      };
    if (type === "compaction_end" || type === "auto_compaction_end")
      return {
        id: uid(),
        type: "Context",
        detail: event.errorMessage
          ? "Compaction failed"
          : event.aborted
            ? "Compaction canceled"
            : event.willRetry
              ? "Compacted · Resuming task"
              : "Compaction completed",
        at: Date.now(),
      };
    if (type !== "message_update") return null;

    const update = event.assistantMessageEvent as
      | Record<string, unknown>
      | undefined;
    if (!update || typeof update.type !== "string") return null;
    if (update.type === "thinking_delta")
      return { id: uid(), type: "Agent", detail: "Thinking", at: Date.now() };
    if (update.type === "toolcall_start") {
      const name =
        typeof (update.toolCall as Record<string, unknown> | undefined)
          ?.name === "string"
          ? String((update.toolCall as Record<string, unknown>).name)
          : typeof update.toolName === "string"
            ? update.toolName
            : "tool";
      return {
        id: uid(),
        type: "Tool",
        detail: `Calling ${name}`,
        at: Date.now(),
      };
    }
    if (update.type === "toolcall_end")
      return {
        id: uid(),
        type: "Tool",
        detail: `Finished ${toolName}`,
        at: Date.now(),
      };
    // Text is rendered in the assistant message and partial tool-call deltas
    // are implementation details, so neither belongs in a user-facing log.
    return null;
  } catch {
    return null;
  }
}

export function describeToolActivity(tool: ToolCall): string {
  const name = tool.name.replace(/^functions\./, "");
  const a = tool.args;
  if (name === "bash" || name === "functions.bash") {
    const cmd = String(a.command ?? "")
      .replace(/\s+/g, " ")
      .trim();
    return cmd.length > 60 ? cmd.slice(0, 57) + "…" : cmd || "Running command";
  }
  if (
    name === "edit" ||
    name === "write" ||
    name === "read" ||
    name === "view"
  ) {
    const p = String(a.path ?? a.file ?? a.target ?? "");
    const base = p.split("/").pop() || p;
    const verb =
      name === "edit" ? "Editing" : name === "write" ? "Writing" : "Reading";
    return base ? `${verb} ${base}` : `${verb} file`;
  }
  if (name === "search" || name === "grep" || name === "ripgrep") {
    const q = String(a.query ?? a.pattern ?? "").slice(0, 40);
    return q ? `Searching "${q}"` : "Searching codebase";
  }
  if (name === "web_search" || name === "fetch_content") {
    const q = String(a.query ?? a.url ?? "").slice(0, 40);
    return q ? `Web: ${q}` : "Searching web";
  }
  if (name === "api_contract_test" || name === "api_request") {
    const partial = tool.result as
      | { details?: { activity?: unknown }; activity?: unknown }
      | undefined;
    const activity = partial?.details?.activity ?? partial?.activity;
    if (typeof activity === "string" && activity) return activity;
    const method = String(a.method ?? "").toUpperCase();
    const path = String(a.path ?? "");
    const operation = String(a.operationId ?? "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .replace(/^./, (letter) => letter.toUpperCase());
    const target = path || operation;
    const bounded = target.length > 48 ? `${target.slice(0, 45)}…` : target;
    return name === "api_contract_test"
      ? `Swagger operation · ${bounded || "Resolving operation"}`
      : `${method || "API"} ${bounded || "request"}`;
  }
  if (name === "subagent" || name === "subagent_wait") {
    const task = String(a.task ?? a.description ?? "").slice(0, 50);
    return task || "Delegating task";
  }
  return name.replace(/_/g, " ");
}
