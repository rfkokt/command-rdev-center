import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_PROMPT_CHARS = 2_000;
const MAX_CONTEXT_CHARS = 12_000;

export default function (pi: ExtensionAPI) {
  const cache = new Map<string, string>();
  let lastInjected = "";
  let taskQuery = "";
  const reset = () => {
    cache.clear();
    lastInjected = "";
    taskQuery = "";
  };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  // Compaction may discard the previous hidden orientation. Reinject cached
  // results on the next user prompt without querying the same graph again.
  pi.on("session_compact", () => {
    lastInjected = "";
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = event.prompt.trim();
    const graphs = (
      process.env.CRC_GRAPH_JSONS ??
      process.env.CRC_GRAPH_JSON ??
      ""
    )
      .split("\n")
      .filter((graph) => graph && existsSync(graph));
    if (!graphs.length || !prompt || ctx.signal?.aborted) return;
    // Short steering/follow-up requests retain the last substantive task query.
    const followUp =
      /^(?:continue|lanjut(?:kan)?|retry|coba lagi|teruskan|go on|oke lanjut)[.!\s]*$/i.test(
        prompt,
      );
    if (!taskQuery || !followUp) taskQuery = prompt.slice(0, MAX_PROMPT_CHARS);
    const query = taskQuery;
    const results = await Promise.allSettled(
      graphs.map(async (graph) => {
        const metadata = statSync(graph);
        const key = `${graph}:${metadata.mtimeMs}:${metadata.size}:${query}`;
        const cached = cache.get(key);
        if (cached !== undefined) return { key, content: cached };
        const { stdout } = await execFileAsync(
          "graphify",
          ["query", query, "--graph", graph, "--budget", "1200"],
          {
            timeout: 5_000,
            maxBuffer: 1_000_000,
            signal: ctx.signal,
          },
        );
        const raw = stdout.trim();
        const content =
          raw && raw !== "No matching nodes found."
            ? `## ${basename(dirname(dirname(graph)))}\nGraph: ${graph} (modified ${new Date(metadata.mtimeMs).toISOString()}; source may lag worktree edits)\n${raw}`
            : "";
        cache.set(key, content);
        while (cache.size > 16) cache.delete(cache.keys().next().value!);
        return { key, content };
      }),
    );
    if (ctx.signal?.aborted) return;
    const available = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const failures = results.filter(
      (result) => result.status === "rejected",
    ).length;
    if (failures)
      ctx.ui.notify(
        `Graphify: ${failures} graph query unavailable; use source search for missing context.`,
        "warning",
      );
    const signature = available.map((item) => item.key).join("\n");
    if (signature === lastInjected) return;
    const projectRoot = process.env.CRC_PROJECT_ROOT || "";
    const projectCwd = process.env.CRC_PROJECT_CWD || process.cwd();
    let context = available
      .map((item) => item.content)
      .filter(Boolean)
      .join("\n\n");
    if (projectRoot) context = context.replaceAll(projectRoot, projectCwd);
    if (!context) return;
    if (context.length > MAX_CONTEXT_CHARS)
      context = `${context.slice(0, MAX_CONTEXT_CHARS)}\n[Context truncated; query the relevant graph or inspect source for remaining results.]`;
    lastInjected = signature;
    return {
      message: {
        customType: "graphify-context",
        display: false,
        content: `Graphify orientation for this task; verify symbols against current source before editing:\n\n${context}\n\nWORKSPACE ROOT: Read and modify files only under ${projectCwd}. Graph sources may belong to nested repositories under this parent workspace.`,
      },
    };
  });
}
