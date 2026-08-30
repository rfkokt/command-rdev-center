import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

const cwd = process.env.CRC_PROJECT_CWD || "";
const prettier = process.env.CRC_PRETTIER_PATH || "";
const supported = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

function target(input: Record<string, unknown>) {
  const path = input.path;
  if (typeof path !== "string" || !supported.has(extname(path).toLowerCase()))
    return;
  const file = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const location = relative(cwd, file);
  if (
    location.startsWith(`..${sep}`) ||
    location === ".." ||
    /(^|[/\\])(node_modules|dist|build|coverage|vendor)([/\\]|$)/.test(
      location,
    ) ||
    /\.min\.[^.]+$/.test(file)
  )
    return;
  return existsSync(file) && statSync(file).isFile() ? file : undefined;
}

function format(file: string) {
  if (!prettier || !existsSync(prettier)) return "Prettier unavailable";
  try {
    execFileSync(process.execPath, [prettier, "--write", file], {
      cwd: dirname(file),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return `Formatted ${file}`;
  } catch (error) {
    return `Prettier failed for ${file}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export default function (pi: ExtensionAPI) {
  if (!cwd) return;
  pi.on("tool_result", (event) => {
    if (event.isError || !["write", "edit"].includes(event.toolName)) return;
    const file = target(event.input as Record<string, unknown>);
    if (!file) return;
    const result = format(file);
    return { content: [...event.content, { type: "text", text: result }] };
  });
}
