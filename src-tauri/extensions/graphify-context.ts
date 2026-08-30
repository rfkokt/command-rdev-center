import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_PROMPT_CHARS = 2_000;
const MAX_CONTEXT_CHARS = 12_000;

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const graphs = (
      process.env.CRC_GRAPH_JSONS ??
      process.env.CRC_GRAPH_JSON ??
      ""
    )
      .split("\n")
      .filter((graph) => graph && existsSync(graph));
    if (!graphs.length || !event.prompt.trim()) return;

    try {
      const contexts = await Promise.all(
        graphs.map(async (graph) => {
          const { stdout } = await execFileAsync(
            "graphify",
            [
              "query",
              event.prompt.slice(0, MAX_PROMPT_CHARS),
              "--graph",
              graph,
              "--budget",
              "1200",
            ],
            { timeout: 30_000, maxBuffer: 1_000_000 },
          );
          const context = stdout.trim();
          return context && context !== "No matching nodes found."
            ? `## ${basename(dirname(dirname(graph)))}\n${context}`
            : "";
        }),
      );
      const projectRoot = process.env.CRC_PROJECT_ROOT ?? "";
      const projectCwd = process.env.CRC_PROJECT_CWD ?? process.cwd();
      const context = contexts
        .filter(Boolean)
        .join("\n\n")
        .replaceAll(projectRoot, projectCwd)
        .slice(0, MAX_CONTEXT_CHARS);
      if (!context) return;

      return {
        message: {
          customType: "graphify-context",
          content: `Graphify context for this task (use this to navigate before reading/searching files):\n\n${context}\n\nWORKSPACE ROOT: Read and modify files only under ${projectCwd}. Graph sources may belong to nested repositories under this parent workspace.`,
          display: false,
        },
      };
    } catch (error) {
      console.error("Graphify context query failed:", error);
    }
  });
}
