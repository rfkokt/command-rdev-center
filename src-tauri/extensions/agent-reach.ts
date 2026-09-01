import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPublicIp, isYouTubeHost } from "./agent-reach-security";

const exec = promisify(execFile);
const options = {
  timeout: 60_000,
  maxBuffer: 2 * 1024 * 1024,
  encoding: "utf8" as const,
};
const run = async (file: string, args: string[]) => {
  const { stdout, stderr } = await exec(file, args, options);
  return `${stdout}${stderr}`.trim();
};
const result = (text: string, details: Record<string, unknown> = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});
const publicUrl = async (raw: string, youtubeOnly = false) => {
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new Error("Public HTTP(S) URL required");
  if (youtubeOnly && !isYouTubeHost(url.hostname))
    throw new Error("A public YouTube or youtu.be URL is required");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicIp(address))
  )
    throw new Error("URL resolves to a non-public address");
  return url;
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "agent_reach_status",
    label: "Agent Reach status",
    description:
      "Check optional Agent Reach public-channel availability. This is read-only and never installs or configures anything.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const text = await run("agent-reach", ["doctor", "--json"]);
        return result(text, { available: true });
      } catch (error) {
        return result(
          JSON.stringify({
            available: false,
            error: String(error),
            fallback: "Use built-in web tools",
          }),
          { available: false },
        );
      }
    },
  });

  pi.registerTool({
    name: "agent_reach_web_read",
    label: "Read public web page",
    description:
      "Read a public HTTP(S) page as Markdown through Jina Reader. Sends the URL to r.jina.ai.",
    parameters: Type.Object({
      url: Type.String({ minLength: 8, maxLength: 4000 }),
    }),
    async execute(_id, input) {
      const url = await publicUrl(input.url);
      // The process only connects to fixed r.jina.ai; the validated target is path data.
      return result(
        await run("curl", [
          "-fsS",
          "--max-redirs",
          "0",
          "--max-time",
          "45",
          `https://r.jina.ai/http://${url.host}${url.pathname}${url.search}`,
        ]),
        { url: url.toString(), provider: "jina" },
      );
    },
  });

  pi.registerTool({
    name: "agent_reach_github_search",
    label: "Search public GitHub",
    description: "Search public GitHub repositories using the official gh CLI.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    }),
    async execute(_id, input) {
      const limit = String(input.limit || 10);
      return result(
        await run("gh", [
          "search",
          "repos",
          input.query,
          "--sort",
          "stars",
          "--limit",
          limit,
          "--json",
          "nameWithOwner,description,url,stargazersCount",
        ]),
        { channel: "github" },
      );
    },
  });

  pi.registerTool({
    name: "agent_reach_youtube_search",
    label: "Search public YouTube",
    description:
      "Search public YouTube videos using yt-dlp without cookies or login.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
    }),
    async execute(_id, input) {
      const limit = Math.floor(input.limit || 5);
      return result(
        await run("yt-dlp", ["--dump-json", `ytsearch${limit}:${input.query}`]),
        { channel: "youtube" },
      );
    },
  });

  pi.registerTool({
    name: "agent_reach_youtube_transcript",
    label: "Read public YouTube transcript",
    description:
      "Fetch available public YouTube subtitles using yt-dlp. Does not use cookies or transcribe audio.",
    parameters: Type.Object({
      url: Type.String({ minLength: 8, maxLength: 4000 }),
    }),
    async execute(_id, input) {
      const url = await publicUrl(input.url, true);
      const dir = await mkdtemp(join(tmpdir(), "crc-agent-reach-"));
      try {
        await run("yt-dlp", [
          "--write-sub",
          "--write-auto-sub",
          "--sub-lang",
          "zh-Hans,zh,en",
          "--skip-download",
          "--no-playlist",
          "-o",
          join(dir, "subtitle"),
          url.toString(),
        ]);
        const files = (await readdir(dir)).filter((file) =>
          file.endsWith(".vtt"),
        );
        const text = (
          await Promise.all(
            files.map((file) => readFile(join(dir, file), "utf8")),
          )
        ).join("\n");
        return result(text || "No public subtitles were returned.", {
          channel: "youtube",
          url: url.toString(),
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  });

  pi.registerTool({
    name: "agent_reach_rss_read",
    label: "Read public RSS feed",
    description:
      "Read a public RSS/Atom feed through Jina Reader after resolving its public host.",
    parameters: Type.Object({
      url: Type.String({ minLength: 8, maxLength: 4000 }),
    }),
    async execute(_id, input) {
      const url = await publicUrl(input.url);
      return result(
        await run("curl", [
          "-fsS",
          "--max-redirs",
          "0",
          "--max-time",
          "45",
          `https://r.jina.ai/http://${url.host}${url.pathname}${url.search}`,
        ]),
        { channel: "rss", url: url.toString(), provider: "jina" },
      );
    },
  });

  pi.registerTool({
    name: "agent_reach_exa_search",
    label: "Search public web with Exa",
    description:
      "Search the public web through the optional Agent Reach Exa mcporter configuration.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
    }),
    async execute(_id, input) {
      return result(
        await run("mcporter", [
          "call",
          "exa.web_search_exa",
          `query=${input.query}`,
          `numResults=${Math.floor(input.limit || 5)}`,
        ]),
        { channel: "exa" },
      );
    },
  });
}
