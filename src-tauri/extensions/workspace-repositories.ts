import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

type Repository = { name: string; root: string; baseBranch: string };
const workspace = process.env.CRC_WORKSPACE_ROOT || "";
const session = process.env.CRC_PROJECT_CWD || "";
const slug = process.env.CRC_CHAT_ID || "chat";
const repositories: Repository[] = JSON.parse(
  process.env.CRC_WORKSPACE_REPOSITORIES || "[]",
);
const mutatingGit =
  /\bgit\b[\s\S]*\b(?:add|commit|reset|clean|checkout|switch|cherry-pick|merge|rebase|pull|push|worktree)\b/i;

function repositoryFor(path: string) {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(session, path);
  return repositories.find(
    (repo) =>
      absolute === join(session, repo.name) ||
      absolute.startsWith(`${join(session, repo.name)}${sep}`),
  );
}

function activate(repo: Repository) {
  const link = join(session, repo.name);
  if (!lstatSync(link).isSymbolicLink()) return link;
  const source = resolve(dirname(link), readlinkSync(link));
  if (source !== resolve(repo.root)) {
    const owner = execFileSync(
      "git",
      ["-C", source, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8" },
    ).trim();
    const expected = execFileSync(
      "git",
      [
        "-C",
        repo.root,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      { encoding: "utf8" },
    ).trim();
    if (owner !== expected)
      throw new Error(`Repository mapping mismatch for ${repo.name}`);
    return source;
  }
  const worktree = join(
    dirname(session),
    "repositories",
    repo.name,
    slug.replace(/[^a-zA-Z0-9_-]/g, "_"),
  );
  mkdirSync(dirname(worktree), { recursive: true });
  const branch = `crc/${slug.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  try {
    execFileSync(
      "git",
      [
        "-C",
        repo.root,
        "worktree",
        "add",
        worktree,
        "-b",
        branch,
        repo.baseBranch,
      ],
      { encoding: "utf8" },
    );
  } catch (error) {
    if (!lstatSafe(worktree))
      execFileSync(
        "git",
        ["-C", repo.root, "worktree", "add", worktree, branch],
        { encoding: "utf8" },
      );
  }
  const temporary = `${link}.source`;
  renameSync(link, temporary);
  try {
    symlinkSync(worktree, link);
    rmSync(temporary);
  } catch (error) {
    if (!lstatSafe(link)) renameSync(temporary, link);
    throw error;
  }
  return worktree;
}

function lstatSafe(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}
function inputPaths(input: Record<string, unknown>) {
  return [
    input.path,
    ...(Array.isArray(input.paths) ? input.paths : []),
  ].filter((value): value is string => typeof value === "string");
}

export default function (pi: ExtensionAPI) {
  if (!workspace || repositories.length === 0) return;
  pi.on("tool_call", (event) => {
    const input = event.input as Record<string, unknown>;
    if (["write", "edit"].includes(event.toolName)) {
      for (const path of inputPaths(input)) {
        const repo = repositoryFor(path);
        if (repo) activate(repo);
      }
    }
    if (
      event.toolName === "bash" &&
      typeof input.command === "string" &&
      mutatingGit.test(input.command)
    ) {
      const repo = repositories.find(
        (candidate) =>
          input.command!.includes(join(session, candidate.name)) ||
          input.command!.includes(candidate.root),
      );
      if (!repo)
        return {
          block: true,
          reason:
            "Git mutation requires explicit `git -C <workspace repository>` target.",
        };
      activate(repo);
      input.command = input.command
        .split(repo.root)
        .join(join(session, repo.name));
    }
  });
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nMULTI-REPOSITORY WORKSPACE:\n- Workspace container: ${workspace}\n- Session overlay: ${session}\n- Repositories: ${repositories.map((repo) => `${repo.name} (${repo.baseBranch})`).join(", ")}\n- You may edit multiple repositories. The first write lazily creates that repository's isolated worktree.\n- Every Git mutation must use git -C ${session}/<repository> ... . Never mutate the workspace container.`,
  }));
}
