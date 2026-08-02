import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_PROMPT_CHARS = 2_000;
const MAX_CONTEXT_CHARS = 12_000;

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const graph = process.env.CRC_GRAPH_JSON;
    if (!graph || !existsSync(graph) || !event.prompt.trim()) return;

    try {
      const { stdout } = await execFileAsync(
        "graphify",
        ["query", event.prompt.slice(0, MAX_PROMPT_CHARS), "--graph", graph, "--budget", "1200"],
        {
          cwd: process.env.CRC_PROJECT_ROOT,
          timeout: 30_000,
          maxBuffer: 1_000_000,
        },
      );
      const projectRoot = process.env.CRC_PROJECT_ROOT ?? "";
      const projectCwd = process.env.CRC_PROJECT_CWD ?? process.cwd();
      const context = stdout
        .trim()
        .replaceAll(projectRoot, projectCwd)
        .slice(0, MAX_CONTEXT_CHARS);
      if (!context || context === "No matching nodes found.") return;

      return {
        message: {
          customType: "graphify-context",
          content: `Graphify context for this task (use this to navigate before reading/searching files):\n\n${context}\n\nWORKTREE ISOLATION: Read and modify files only under ${projectCwd}. Resolve graph source paths relative to that directory; never use the main checkout path.`,
          display: false,
        },
      };
    } catch (error) {
      console.error("Graphify context query failed:", error);
    }
  });
}
