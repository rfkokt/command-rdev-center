import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);
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

export function formatTarget(cwd: string, path: unknown): string | undefined {
  if (typeof path !== "string" || !supported.has(extname(path).toLowerCase()))
    return;
  const file = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const location = relative(cwd, file);
  if (
    location === ".." ||
    location.startsWith(`..${sep}`) ||
    location === "memory.md" ||
    /(^|[/\\])(node_modules|dist|build|coverage|vendor)([/\\]|$)/.test(
      location,
    ) ||
    /\.min\.[^.]+$/.test(file)
  )
    return;
  return file;
}

export function createFormatBatch(cwd: string, fallback: string) {
  const pending = new Set<string>();
  let inFlight: Promise<{ changed: string[]; errors: string[] }> | undefined;
  return {
    touch(path: unknown) {
      const file = formatTarget(cwd, path);
      if (file) pending.add(file);
    },
    reset() {
      pending.clear();
    },
    async flush(
      signal?: AbortSignal,
    ): Promise<{ changed: string[]; errors: string[] }> {
      if (inFlight) {
        await inFlight;
        return this.flush(signal);
      }
      const files = [...pending];
      files.forEach((file) => pending.delete(file));
      inFlight = (async () => {
        const changed: string[] = [],
          errors: string[] = [];
        for (const file of files) {
          if (signal?.aborted) {
            pending.add(file);
            continue;
          }
          try {
            if (!(await stat(file)).isFile()) continue;
            let folder = dirname(file),
              prettier = fallback;
            while (folder === cwd || folder.startsWith(`${cwd}${sep}`)) {
              const local = join(
                folder,
                "node_modules/prettier/bin/prettier.cjs",
              );
              if (existsSync(local)) {
                prettier = local;
                break;
              }
              if (folder === cwd) break;
              folder = dirname(folder);
            }
            if (!prettier || !existsSync(prettier))
              throw new Error("Prettier unavailable");
            const before = await readFile(file);
            await execFileAsync(process.execPath, [prettier, "--write", file], {
              cwd: dirname(file),
              timeout: 15_000,
              maxBuffer: 256_000,
              signal,
            });
            if (!(await readFile(file)).equals(before))
              changed.push(relative(cwd, file));
          } catch (error) {
            // A deleted file needs no formatting. Other failures remain queued
            // so a warning cannot disappear before validation/settlement.
            if (
              (error as NodeJS.ErrnoException).code === "ENOENT" &&
              !existsSync(file)
            )
              continue;
            pending.add(file);
            errors.push(relative(cwd, file));
          }
        }
        return { changed, errors };
      })();
      try {
        return await inFlight;
      } finally {
        inFlight = undefined;
      }
    },
  };
}

export default function (pi: ExtensionAPI) {
  const cwd = process.env.CRC_PROJECT_CWD;
  if (!cwd) return;
  const batch = createFormatBatch(cwd, process.env.CRC_PRETTIER_PATH || "");
  let recoveryRequested = false;
  pi.registerTool({
    name: "format_changed_files",
    label: "Format changed files",
    description:
      "Flush queued formatting once before validation. Returns changed paths and failures; reopen formatted files before editing them again.",
    parameters: Type.Object({}),
    async execute(_id, _input, signal) {
      const result = await batch.flush(signal);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
        isError: result.errors.length > 0,
      };
    },
  });
  pi.on("before_agent_start", () => {
    recoveryRequested = false;
  });
  pi.on("session_start", () => batch.reset());
  pi.on("session_tree", () => batch.reset());
  pi.on("tool_result", (event) => {
    if (!event.isError && ["write", "edit"].includes(event.toolName))
      batch.touch(event.input.path);
  });
  // Batched edits remain stable until a command needs to inspect/check the working tree.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const result = await batch.flush(ctx.signal);
    if (result.errors.length)
      ctx.ui.notify(
        `Formatting failed: ${result.errors.join(", ")}`,
        "warning",
      );
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "completed" || ctx.signal?.aborted) return;
    const result = await batch.flush(ctx.signal);
    if (!result.changed.length && !result.errors.length) return;
    const content = `Formatting batch: ${JSON.stringify(result)}. Files changed after your last check must be revalidated. Report formatting failures as limitations.`;
    const shouldContinue = !recoveryRequested && event.context.canContinue;
    recoveryRequested = true;
    return {
      entries: [
        {
          type: "custom_message",
          customType: "kern-format",
          content,
          display: true,
        },
      ],
      continue: shouldContinue,
    };
  });
}
