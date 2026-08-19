import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const chatId = process.env.CRC_CHAT_ID || "";
const snapshotDir = process.env.CRC_TERMINAL_DIR || "";
const ANSI = /\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

function paneId(file: string) {
  return basename(file, ".log").slice(`${chatId}__`.length);
}

async function panes() {
  if (!chatId || !snapshotDir) return [];
  return (await readdir(snapshotDir).catch(() => []))
    .filter((file) => file.startsWith(`${chatId}__`) && file.endsWith(".log"))
    .sort();
}

function clean(text: string) {
  return text.replace(ANSI, "").replace(/\r/g, "");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "list_chat_terminals",
    label: "List chat terminals",
    description: "List active in-app terminal panes belonging to this chat only.",
    parameters: Type.Object({}),
    async execute() {
      const files = await panes();
      const text = files.length ? files.map((file) => `- Pane ${paneId(file)}`).join("\n") : "No active terminal panes for this chat.";
      return { content: [{ type: "text", text }], details: { panes: files.map(paneId) } };
    },
  });

  pi.registerTool({
    name: "read_chat_terminal",
    label: "Read chat terminal",
    description: "Read recent output from one active in-app terminal pane in this chat. Use this to inspect build failures, stack traces, warnings, and process output. ANSI formatting is removed.",
    parameters: Type.Object({
      pane: Type.Optional(Type.String({ description: "Pane number from list_chat_terminals; defaults to 0" })),
      maxChars: Type.Optional(Type.Number({ minimum: 1000, maximum: 50000, description: "Maximum recent characters; defaults to 12000" })),
    }),
    async execute(_id, input) {
      const pane = input.pane || "0";
      if (!/^\d+$/.test(pane)) throw new Error("Invalid terminal pane");
      const file = `${chatId}__${pane}.log`;
      if (!(await panes()).includes(file)) throw new Error(`Terminal pane ${pane} is not active in this chat`);
      const output = clean(await readFile(join(snapshotDir, file), "utf8"));
      const maxChars = Math.min(50000, Math.max(1000, input.maxChars || 12000));
      return { content: [{ type: "text", text: output.slice(-maxChars) || "(terminal has no output yet)" }], details: { pane, truncated: output.length > maxChars } };
    },
  });

  pi.registerTool({
    name: "write_chat_terminal",
    label: "Request terminal input",
    description: "Request approval to send exact input to an active in-app terminal pane in this chat. The host always asks the user before writing. Include a newline when the command should execute.",
    parameters: Type.Object({
      pane: Type.Optional(Type.String({ description: "Pane number; defaults to 0" })),
      data: Type.String({ minLength: 1, maxLength: 10000, description: "Exact terminal input, including \\n when Enter should be pressed" }),
    }),
    async execute(_id, input) {
      return { content: [{ type: "text", text: "Terminal input submitted for user approval." }], details: { pane: input.pane || "0", bytes: input.data.length } };
    },
  });
}
