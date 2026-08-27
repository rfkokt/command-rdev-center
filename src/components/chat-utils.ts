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

export function appendBoundedText(current: string, delta: string, maxLength: number) {
  return (current + delta).slice(-maxLength);
}

export function appendStreamingText(current: string, incoming: string, maxLength = 200_000) {
  if (!incoming || current.endsWith(incoming)) return current;
  if (!current || incoming.startsWith(current)) return incoming.slice(-maxLength);
  const limit = Math.min(current.length, incoming.length);
  let overlap = limit;
  while (overlap > 0 && !current.endsWith(incoming.slice(0, overlap))) overlap--;
  return (current + incoming.slice(overlap)).slice(-maxLength);
}

export function recentItems<T>(items: T[], maxItems: number) {
  return items.slice(-maxItems);
}

export function preserveStreamedContent(streamed: string, completed: string) {
  if (!completed || streamed.endsWith(completed)) return streamed;
  if (!streamed) return completed;
  const words = (text: string) => new Set(text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean));
  const left = words(streamed);
  const right = words(completed);
  const overlap = [...left].filter((word) => right.has(word)).length;
  if (overlap / Math.max(1, Math.min(left.size, right.size)) >= 0.8) return completed;
  return `${streamed}\n\n${completed}`;
}

export type TaskIntent = { kind: "list" } | { kind: "detail"; taskNo: string };

export function projectTaskIntent(input: string): TaskIntent | null {
  const text = input.toLowerCase().replace(/[#?.,!]/g, " ").replace(/\s+/g, " ").trim();
  if (!/\b(task|tugas|point|poin)\b/.test(text)) return null;
  const number = text.match(/\b(?:task|tugas|point|poin)(?:\s+(?:nomor|no))?\s+(\d+)\b/)?.[1];
  if (number && /\b(lihat|detail|cek|check|show|buka|apa|what|isi)\b/.test(text)) return { kind: "detail", taskNo: number };
  if (/\b(ada|list|daftar|available|tersedia|punya|what|apa)\b/.test(text)) return { kind: "list" };
  return null;
}

export function shouldSubmitCommand(input: string, command: { name: string }) {
  return input.trim() === `/${command.name}`;
}

export function filePickerKey(key: string, selectedIdx: number, count: number) {
  if (key === "Escape") return { close: true };
  if (!count) return null;
  if (key === "ArrowDown") return { select: (selectedIdx + 1) % count };
  if (key === "ArrowUp") return { select: (selectedIdx - 1 + count) % count };
  if (key === "Enter" || key === "Tab") return { pick: selectedIdx };
  return null;
}

export function ensureAssistantTurn(messages: ChatMessage[], create: () => ChatMessage): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && last.isStreaming) return messages;
  return [...messages, create()];
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

/**
 * Turn raw provider error strings (often nested JSON like
 * `402: {"message":"[provider/model] [402]: {\"error\":{\"code\":...}} (reset after 1m 40s)"}`)
 * into a readable summary. Falls back to the raw string if it can't be parsed.
 */
export function formatAgentError(raw: string): string {
  const original = raw.trim();
  if (!original) return "Unknown agent error";

  // Provider errors arrive as a loosely-structured string (not strict JSON): an HTTP prefix,
  // a provider/model bracket, and one or more nested "error" objects whose quotes are no longer
  // escaped relative to the outer text. So we regex-scan the raw string instead of JSON.parse-ing it.
  const statusMatch = original.match(/^(\d{3}):\s*/);
  const httpStatus = statusMatch?.[1];

  // Grab every "key":"value" pair across the whole string (values must not contain unescaped quotes).
  const pairs: Array<{ key: string; value: string }> = [];
  const pairRegex = /"([a-zA-Z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = pairRegex.exec(original))) {
    // unescape common JSON escapes so display is clean
    const value = m[2].replace(/\\(.)/g, "$1");
    pairs.push({ key: m[1], value });
  }

  const code = pairs.find((p) => p.key === "code")?.value ?? "";
  const type = pairs.find((p) => p.key === "type")?.value ?? "";
  // Prefer the cleanest message: the shortest "message" value with no embedded braces/JSON.
  const messages = pairs.filter((p) => p.key === "message");
  const cleanMessage =
    messages
      .filter((p) => !p.value.includes("{") && !p.value.includes("["))
      .sort((a, b) => a.value.length - b.value.length)[0]?.value ?? "";
  const headline = cleanMessage || messages[0]?.value || original;

  const bracketMatch = original.match(/\[([^\]/\s]+\/([^\]/\s]+))\]/);
  const model = bracketMatch?.[2];
  const resetMatch = original.match(/\(reset after ([^)]+)\)/i);

  const meta: string[] = [];
  if (httpStatus) meta.push(`HTTP ${httpStatus}`);
  if (code) meta.push(code);
  if (type && type !== code) meta.push(type);
  if (model) meta.push(model);
  const metaLine = meta.length ? `\n\n${meta.join(" · ")}` : "";
  const retryLine = resetMatch ? `\nRetry available in ${resetMatch[1]}.` : "";
  return `${headline}${metaLine}${retryLine}`;
}

export function shouldOfferRestart(text: string) {
  return /agent error:.*unknown session|agent process stopped unexpectedly/i.test(text);
}

export function clearRestartErrors(messages: ChatMessage[]) {
  return messages.filter((message) => message.role !== "system" || !shouldOfferRestart(message.text));
}

export function settleWithError(messages: ChatMessage[], error: string): ChatMessage[] {
  const text = `Agent error: ${formatAgentError(error)}`;
  let streamingIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].isStreaming) {
      streamingIndex = i;
      break;
    }
  }
  if (streamingIndex < 0) {
    if (messages.some((message) => message.role === "system" && message.text === text)) return messages;
    return [...messages, { id: uid(), role: "system", text, toolCalls: [] }];
  }
  const next = [...messages];
  const streamed = next[streamingIndex].text;
  next[streamingIndex] = { ...next[streamingIndex], text: streamed ? `${streamed}\n\n${text}` : text, isStreaming: false };
  return next;
}

export function agentNotification(kind: "finished" | "follow-up", projectName: string, chatId?: string, response?: string) {
  const preview = response?.replace(/\s+/g, " ").trim().slice(0, 240);
  return {
    ...(kind === "finished"
      ? { title: "Agent selesai", body: preview ? `${projectName}: ${preview}` : `${projectName} siap ditinjau.`, sound: "Glass" }
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
