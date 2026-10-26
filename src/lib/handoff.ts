import type { ChatMessage, ToolCall } from "./rpc";

/**
 * Context for a model or agent that takes over a chat mid-task — typically
 * because the current one hit its usage limit. The outgoing model can't be
 * asked for a summary (it is out of quota), so the handoff is built
 * deterministically from what the chat already holds:
 *
 * - `inline` goes into the new agent's system prompt / first-prompt preamble:
 *   the goal, every user request, a digest of the work done (files changed,
 *   commands and their outcome), the worktree state, and as much of the recent
 *   conversation as fits. Bounded, so taking over stays cheap.
 * - `full` is the whole transcript including tool calls, written to a file the
 *   agent can read on demand when the inline part is not enough.
 */
export type HandoffChange = {
  path: string;
  status: string;
  added: number;
  removed: number;
};

type Message = Pick<ChatMessage, "role" | "text"> & {
  toolCalls?: ToolCall[];
};

export const HANDOFF_INLINE_CHARS = 40_000;
const FULL_MAX_CHARS = 3_000_000;

const PATH_KEYS = ["path", "file_path", "filePath", "file", "filename"];
const EDIT_TOOLS =
  /^(edit|write|multi_?edit|notebook_?edit|apply_patch|str_replace|create_file)$/i;
const READ_TOOLS = /^(read|view|cat|open_file)$/i;
const COMMAND_TOOLS = /^(bash|shell|execute_terminal_command|run_check|exec)$/i;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)} […]` : text;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function toolPath(call: ToolCall): string | null {
  for (const key of PATH_KEYS) {
    const value = call.args?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function toolCommand(call: ToolCall): string | null {
  const value = call.args?.command ?? call.args?.cmd;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resultText(result: unknown, max = 1500): string {
  if (result == null) return "";
  if (typeof result === "string") return clip(result, max);
  const blocks =
    (result as { content?: unknown }).content ??
    (Array.isArray(result) ? result : null);
  if (Array.isArray(blocks)) {
    const text = blocks
      .map((block) =>
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text"
          ? String((block as { text?: unknown }).text ?? "")
          : block &&
              typeof block === "object" &&
              (block as { type?: unknown }).type === "image"
            ? "[image]"
            : "",
      )
      .filter(Boolean)
      .join("\n");
    if (text) return clip(text, max);
  }
  try {
    return clip(JSON.stringify(result), max);
  } catch {
    return "";
  }
}

/** Files changed, files read and commands run, newest commands last. */
export function workDigest(messages: Message[]) {
  const edited = new Map<string, number>();
  const read = new Set<string>();
  const commands: Array<{ command: string; failed: boolean }> = [];
  for (const message of messages)
    for (const call of message.toolCalls ?? []) {
      const name = call.name.replace(/^mcp__[^_]+__/, "");
      const path = toolPath(call);
      if (path && EDIT_TOOLS.test(name))
        edited.set(path, (edited.get(path) ?? 0) + 1);
      else if (path && READ_TOOLS.test(name)) read.add(path);
      const command = COMMAND_TOOLS.test(name) ? toolCommand(call) : null;
      if (command)
        commands.push({ command: oneLine(command), failed: !!call.isError });
    }
  return { edited, read, commands };
}

export function buildChatHandoff({
  messages,
  from,
  changes = [],
  fullPath,
  budget = HANDOFF_INLINE_CHARS,
}: {
  messages: Message[];
  from: string;
  changes?: HandoffChange[];
  /** Where the full transcript was saved, if it was. */
  fullPath?: string;
  budget?: number;
}): string | undefined {
  const turns = messages.filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      message.text.trim(),
  );
  const users = turns.filter((message) => message.role === "user");
  if (!users.length) return undefined;

  const sections: string[] = [];
  sections.push(
    "## Taking over this chat",
    `You are continuing a task another model (${from}) started in this chat; it stopped mid-task (often because it hit its usage limit). Below is what happened so far, reconstructed by the app. The files in the working directory are the source of truth: re-read files before editing and re-run checks before relying on earlier results. Do not redo work that is already done.`,
  );
  if (fullPath)
    sections.push(
      `Full transcript with tool calls and outputs: ${fullPath} — read it only if the summary below is not enough.`,
    );

  sections.push("### Goal (first request)", clip(users[0].text.trim(), 4000));

  if (users.length > 1) {
    const requests = users.slice(1).map((message, index, list) => {
      const text = message.text.trim();
      // The latest request matters most; earlier ones are context.
      return `${index + 2}. ${index === list.length - 1 ? clip(text, 3000) : clip(oneLine(text), 500)}`;
    });
    sections.push("### Later requests (in order)", requests.join("\n"));
  }

  const { edited, read, commands } = workDigest(messages);
  const work: string[] = [];
  if (edited.size)
    work.push(
      `Edited/created: ${[...edited.entries()].map(([path, count]) => (count > 1 ? `${path} (${count}×)` : path)).join(", ")}`,
    );
  if (read.size)
    work.push(
      `Read: ${[...read].slice(-40).join(", ")}${read.size > 40 ? ` (+${read.size - 40} more)` : ""}`,
    );
  if (commands.length) {
    const recent = commands.slice(-15);
    work.push(
      `Commands (last ${recent.length} of ${commands.length}):\n${recent.map((item) => `- ${item.failed ? "[failed] " : ""}${clip(item.command, 200)}`).join("\n")}`,
    );
  }
  if (work.length) sections.push("### Work done so far", work.join("\n"));

  if (changes.length)
    sections.push(
      "### Current uncommitted changes in the worktree",
      changes
        .slice(0, 80)
        .map(
          (file) =>
            `- ${file.status} ${file.path} (+${file.added}/-${file.removed})`,
        )
        .join("\n") +
        (changes.length > 80 ? `\n- … ${changes.length - 80} more` : ""),
    );

  const head = sections.join("\n\n");
  // Fill what is left with the most recent conversation, newest first.
  const room = Math.max(2000, budget - head.length - 200);
  const recent: string[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index--) {
    const message = turns[index];
    const line = `${message.role === "user" ? "User" : "Assistant"}: ${clip(message.text.trim(), message.role === "user" ? 3000 : 4000)}`;
    if (used + line.length > room && recent.length) break;
    recent.unshift(line);
    used += line.length + 2;
  }
  const dropped = turns.length - recent.length;
  return [
    head,
    `### Recent conversation${dropped ? ` (${dropped} older messages only in the full transcript)` : ""}`,
    recent.join("\n\n"),
  ].join("\n\n");
}

/** Every message, tool call and (clipped) tool output, for on-demand reading. */
export function buildFullTranscript(messages: Message[], from: string): string {
  const parts: string[] = [`# Chat transcript (handed over from ${from})`];
  let size = parts[0].length;
  for (const message of messages) {
    const lines = [`## ${message.role}`, message.text.trim()];
    for (const call of message.toolCalls ?? []) {
      let args = "";
      try {
        args = clip(JSON.stringify(call.args ?? {}), 800);
      } catch {}
      lines.push(
        `- tool ${call.name}${call.isError ? " (error)" : ""}: ${args}`,
        ...(call.result !== undefined
          ? [`  result: ${resultText(call.result).replace(/\n/g, "\n  ")}`]
          : []),
      );
    }
    const block = lines.filter(Boolean).join("\n");
    if (size + block.length > FULL_MAX_CHARS) {
      parts.push("[transcript truncated]");
      break;
    }
    parts.push(block);
    size += block.length + 2;
  }
  return parts.join("\n\n");
}

/**
 * Provider errors that mean "this model/account is out of quota or rate
 * limited", as opposed to a bug or a network blip.
 */
export function isUsageLimitError(text: string): boolean {
  return /usage limit|rate[ _-]?limit|quota|insufficient[_ ]?quota|credit balance|out of credits|billing|exceeded your (current )?(quota|limit)|you'?ve (hit|reached) your|limit (reached|exceeded)|too many requests|\b429\b|resource[_ ]exhausted|weekly limit|5-hour limit/i.test(
    text,
  );
}
