import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, join } from "node:path";

const chatId = process.env.CRC_CHAT_ID || "";
const snapshotDir = process.env.CRC_TERMINAL_DIR || "";
const ANSI = /\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const execFileAsync = promisify(execFile);
const destructive = (command: string) => /\b(?:rm|rmdir|mkfs|dd|shutdown|reboot|poweroff|halt|kill|killall|pkill|chmod|chown|truncate|wipefs|userdel|deluser|drop\s+(?:database|table)|delete\s+from|truncate\s+table|git\s+reset\s+--hard|git\s+clean|docker\s+(?:rm|system\s+prune)|kubectl\s+delete|terraform\s+(?:destroy|apply)|systemctl\s+(?:stop|disable|restart)|launchctl\s+(?:unload|bootout))\b|\b(?:curl|wget)\b[^\n|;]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s*(?:POST|PUT|PATCH|DELETE))\b/i.test(command);

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
    name: "execute_terminal_command",
    label: "Execute terminal command",
    description: "Execute a non-destructive local shell, SSH, or device command and return its cleaned stdout/stderr directly. Destructive commands are held for host approval. Use this instead of write/read polling for agent work.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1, maxLength: 10000, description: "Exact shell command" }),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 120, description: "Timeout; defaults to 30 seconds" })),
    }),
    async execute(_id, input) {
      if (destructive(input.command)) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "approval_required", command: input.command }) }], details: { destructive: true, command: input.command } };
      }
      const timeout = Math.min(120, Math.max(1, input.timeoutSeconds || 30)) * 1000;
      try {
        const { stdout, stderr } = await execFileAsync(process.env.SHELL || "/bin/zsh", ["-lc", input.command], { cwd: process.cwd(), timeout, maxBuffer: 1024 * 1024, encoding: "utf8" });
        const output = clean(`${stdout}${stderr}`).trim();
        const urls = [...new Set(output.match(/https?:\/\/[^\s<>"']+/g) || [])];
        return { content: [{ type: "text", text: JSON.stringify({ status: urls.length ? "awaiting_user_action" : "completed", output, exitCode: 0, urls }) }], details: { output, exitCode: 0, urls } };
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
        const output = clean(`${failure.stdout || ""}${failure.stderr || ""}`).trim();
        const urls = [...new Set(output.match(/https?:\/\/[^\s<>"']+/g) || [])];
        return { content: [{ type: "text", text: JSON.stringify({ status: urls.length ? "awaiting_user_action" : failure.killed ? "timeout" : "failed", output, exitCode: typeof failure.code === "number" ? failure.code : -1, urls }) }], details: { output, exitCode: failure.code, urls }, isError: false };
      }
    },
  });

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
      const visible = output.slice(-maxChars) || "(terminal has no output yet)";
      const urls = [...new Set(visible.match(/https?:\/\/[^\s<>"']+/g) || [])];
      const handoff = urls.length
        ? `\n\nAuthentication/action URL detected. Return the relevant URL to the user as a clickable Markdown link, explain the required action briefly, and keep the terminal session alive. After the user completes it, read this pane again and continue.\n${urls.join("\n")}`
        : "";
      return { content: [{ type: "text", text: visible + handoff }], details: { pane, truncated: output.length > maxChars, urls } };
    },
  });

  pi.registerTool({
    name: "write_chat_terminal",
    label: "Request terminal input",
    description: "Send exact input to an active in-app terminal pane. Non-destructive commands run automatically; destructive commands are held for user approval by the host. Include a newline when the command should execute.",
    parameters: Type.Object({
      pane: Type.Optional(Type.String({ description: "Pane number; defaults to 0" })),
      data: Type.String({ minLength: 1, maxLength: 10000, description: "Exact terminal input, including \\n when Enter should be pressed" }),
    }),
    async execute(_id, input) {
      return { content: [{ type: "text", text: "Terminal input submitted to the host. Safe commands run immediately; read this pane again for output and finish the user's request in this same turn. Do not claim approval is pending unless the command is destructive." }], details: { pane: input.pane || "0", bytes: input.data.length } };
    },
  });
}
