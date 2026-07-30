import type { ChatMessage } from "../lib/rpc";

// Separated from ChatView.tsx so Vite React Fast Refresh stays valid:
// a module exporting a component must export only components. These helpers
// are pure / message-shaping utilities, not components.

export function formatTokens(tokens: number) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(tokens);
}

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export function shouldShowChanges(message: Pick<ChatMessage, "id" | "role">, lastAssistantId: string | undefined, fileCount: number) {
  return message.role === "assistant" && message.id === lastAssistantId && fileCount > 0;
}

export function preserveStreamedContent(streamed: string, completed: string) {
  if (!completed || streamed.endsWith(completed)) return streamed;
  if (!streamed) return completed;
  return `${streamed}\n\n${completed}`;
}

export function shouldSubmitCommand(input: string, command: { name: string }) {
  return input.trim() === `/${command.name}`;
}

export function insertSteerMessage(messages: ChatMessage[], message: ChatMessage) {
  let streamingIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].isStreaming) {
      streamingIndex = i;
      break;
    }
  }
  if (streamingIndex < 0) return [...messages, message];
  return [...messages.slice(0, streamingIndex), message, ...messages.slice(streamingIndex)];
}

export function shouldToastPiStderr(line: string) {
  const text = line.trim();
  return Boolean(text) && !text.startsWith("[crc-isolation ") && !text.startsWith("Ponytail loaded:");
}

export function appendAgentLog(messages: ChatMessage[], line: string): ChatMessage[] {
  return [...messages, { id: uid(), role: "system", text: `pi stderr: ${line}`, toolCalls: [], createdAt: Date.now() }];
}

export function settleAgentMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .filter((message) => !(message.role === "assistant" && message.isStreaming && !message.text && !message.thinking && message.toolCalls.length === 0))
    .map((message) => message.isStreaming ? { ...message, isStreaming: false } : message);
}

export function settleWithError(messages: ChatMessage[], error: string): ChatMessage[] {
  const text = `Agent error: ${error}`;
  let streamingIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].isStreaming) {
      streamingIndex = i;
      break;
    }
  }
  if (streamingIndex < 0) return [...messages, { id: uid(), role: "system", text, toolCalls: [] }];
  const next = [...messages];
  const streamed = next[streamingIndex].text;
  next[streamingIndex] = { ...next[streamingIndex], text: streamed ? `${streamed}\n\n${text}` : text, isStreaming: false };
  return next;
}

export function agentNotification(kind: "finished" | "follow-up", projectName: string, chatId?: string) {
  return {
    ...(kind === "finished"
      ? { title: "Agent selesai", body: `${projectName} siap ditinjau.`, sound: "Glass" }
      : { title: "Agent perlu jawaban", body: `${projectName} menunggu respons.`, sound: "Ping" }),
    ...(chatId ? { actionTypeId: "agent-finished", extra: { chatId } } : {}),
  };
}

export function tsvToMarkdown(text: string): string | null {
  const norm = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/, "");
  if (!norm.includes("\t")) return null;
  const rows: string[][] = [[]];
  let cell = "";
  let quoted = false;
  for (let i = 0; i <= norm.length; i++) {
    const char = norm[i] ?? "\n";
    if (char === '"' && quoted && norm[i + 1] === '"') { cell += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === "\t" && !quoted) { rows[rows.length - 1].push(cell); cell = ""; }
    else if (char === "\n" && !quoted) { rows[rows.length - 1].push(cell); cell = ""; if (i < norm.length) rows.push([]); }
    else cell += char;
  }
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c.trim() === "")) rows.pop();
  if (rows.length === 0) return null;
  const colCount = Math.max(...rows.map((r) => r.length));
  if (colCount <= 1) return null;
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, "\u2028").trim();
  const padded = rows.map((r) => {
    const c = r.slice();
    while (c.length < colCount) c.push("");
    return c.map(esc);
  });
  const header = padded[0];
  const sep = Array(colCount).fill("---");
  let md = `| ${header.join(" | ")} |\n| ${sep.join(" | ")} |`;
  for (let i = 1; i < padded.length; i++) md += `\n| ${padded[i].join(" | ")} |`;
  return md;
}
