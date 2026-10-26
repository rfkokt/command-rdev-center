#!/usr/bin/env node
// Where do Kern's tokens go? Reads local agent session files (JSONL) and
// reports model requests per user prompt, input / cache read / cache write /
// output tokens, cache hit rate, the size of the first request (system prompt
// + tools baseline), cache warming and compaction usage, and how many calls
// went to Kern's own bookkeeping tools.
//
// Understands two formats:
//   - pi sessions (pi harness): ~/.pi/agent/sessions, or `sessionDir` from
//     ~/.pi/agent/settings.json
//   - Claude Code / claude-agent-acp sessions (Claude Code harness over ACP):
//     ~/.claude/projects
//
// Usage: node scripts/token-audit.mjs [dir ...] [--days 7] [--top 15]
// Nothing is sent anywhere.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const days = flag("--days", 7);
const top = flag("--top", 15);
const since = Date.now() - days * 86_400_000;
const home = os.homedir();

function defaultRoots() {
  const roots = [];
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(home, ".pi/agent/settings.json"), "utf8"),
    );
    if (typeof settings.sessionDir === "string" && settings.sessionDir.trim())
      roots.push(settings.sessionDir.replace(/^~/, home));
  } catch {}
  roots.push(path.join(home, ".pi"), path.join(home, ".claude/projects"));
  return roots;
}
const explicit = args.filter(
  (arg, i) => !arg.startsWith("--") && !args[i - 1]?.startsWith("--"),
);
const roots = [...new Set(explicit.length ? explicit : defaultRoots())];

// Kern's extensions: tools that cost a full model round trip each.
const KERN_TOOLS = new Set([
  "set_task_contract",
  "run_check",
  "report_task",
  "track_kanban_task",
  "list_project_tasks",
  "get_project_task",
  "format_changed_files",
  "recommend_global_skills",
  "report_recurring_error",
  "list_chat_terminals",
  "read_chat_terminal",
  "write_chat_terminal",
  "execute_terminal_command",
  "run_pipeline",
  "control_pipeline",
  "provide_pipeline_input",
]);
const KERN_MESSAGES = /^kern-|^crc-/;
const toolName = (name) => String(name ?? "").replace(/^mcp__[^_]+__/, "");

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "bin") continue;
      walk(full, out, depth + 1);
    } else if (entry.name.endsWith(".jsonl")) {
      try {
        if (fs.statSync(full).mtimeMs >= since) out.push(full);
      } catch {}
    }
  }
  return out;
}

const blank = () => ({
  prompts: 0,
  requests: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  firstRequest: 0,
  maxRequest: 0,
  warm: 0,
  compaction: 0,
  kernToolCalls: 0,
  toolCalls: 0,
  continuations: 0,
  kernMessages: {},
  tools: {},
  models: {},
});
const addUsage = (s, u) => {
  s.input += u.input;
  s.cacheRead += u.cacheRead;
  s.cacheWrite += u.cacheWrite;
  s.output += u.output;
};
const request = (s, u, model, toolNames) => {
  s.requests++;
  addUsage(s, u);
  const size = u.input + u.cacheRead + u.cacheWrite;
  if (!s.firstRequest) s.firstRequest = size;
  s.maxRequest = Math.max(s.maxRequest, size);
  s.models[model] = (s.models[model] ?? 0) + 1;
  for (const raw of toolNames) {
    const name = toolName(raw);
    s.toolCalls++;
    s.tools[name] = (s.tools[name] ?? 0) + 1;
    if (KERN_TOOLS.has(name)) s.kernToolCalls++;
  }
};
const piUsage = (u) => ({
  input: u?.input ?? 0,
  cacheRead: u?.cacheRead ?? 0,
  cacheWrite: u?.cacheWrite ?? 0,
  output: u?.output ?? 0,
});
const claudeUsage = (u) => ({
  input: u?.input_tokens ?? 0,
  cacheRead: u?.cache_read_input_tokens ?? 0,
  cacheWrite: u?.cache_creation_input_tokens ?? 0,
  output: u?.output_tokens ?? 0,
});

function parsePi(s, lines) {
  let lastRole = null;
  for (const entry of lines) {
    if (entry.type === "session") s.cwd = entry.cwd;
    if (entry.type === "usage") {
      const u = piUsage(entry.usage);
      if (entry.kind === "cache_warm")
        s.warm += u.input + u.cacheRead + u.cacheWrite + u.output;
      addUsage(s, u);
      continue;
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      const u = piUsage(entry.usage);
      s.compaction += u.input + u.cacheRead + u.cacheWrite + u.output;
      addUsage(s, u);
      continue;
    }
    if (entry.type === "custom_message") {
      if (KERN_MESSAGES.test(entry.customType ?? "")) {
        s.kernMessages[entry.customType] =
          (s.kernMessages[entry.customType] ?? 0) + 1;
        lastRole = "kern";
      }
      continue;
    }
    if (entry.type !== "message") continue;
    const m = entry.message ?? {};
    if (m.role === "user") {
      s.prompts++;
      lastRole = "user";
    } else if (m.role === "assistant" && m.usage) {
      if (lastRole === "kern") s.continuations++;
      lastRole = "assistant";
      request(
        s,
        piUsage(m.usage),
        `${m.provider ?? "?"}/${m.model ?? "?"}`,
        (Array.isArray(m.content) ? m.content : [])
          .filter((block) => block?.type === "toolCall")
          .map((block) => block.name),
      );
    } else if (m.role === "toolResult") lastRole = "tool";
  }
}

function parseClaude(s, lines) {
  // One API response is split over several lines sharing message.id.
  const responses = new Map();
  for (const entry of lines) {
    if (entry.cwd && !s.cwd) s.cwd = entry.cwd;
    const m = entry.message;
    if (entry.type === "user" && m) {
      const content = m.content;
      const isToolResult =
        Array.isArray(content) &&
        content.some((block) => block?.type === "tool_result");
      if (!isToolResult && !entry.isMeta && !entry.isCompactSummary)
        s.prompts++;
      continue;
    }
    if (entry.type !== "assistant" || !m?.usage) continue;
    const id = m.id ?? entry.uuid;
    const response = responses.get(id) ?? {
      usage: m.usage,
      model: m.model ?? "?",
      tools: [],
      sidechain: !!entry.isSidechain,
    };
    response.usage = m.usage; // last line carries the final output count
    for (const block of Array.isArray(m.content) ? m.content : [])
      if (block?.type === "tool_use") response.tools.push(block.name);
    responses.set(id, response);
  }
  for (const response of responses.values())
    request(
      s,
      claudeUsage(response.usage),
      `claude/${response.model}${response.sidechain ? " (subagent)" : ""}`,
      response.tools,
    );
}

const sessions = [];
const filesSeen = new Set();
for (const root of roots) {
  for (const file of walk(root)) {
    if (filesSeen.has(file)) continue;
    filesSeen.add(file);
    const lines = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {}
    }
    const s = blank();
    s.file = file;
    if (lines.some((entry) => entry.type === "session" && entry.version)) {
      s.kind = "pi";
      parsePi(s, lines);
    } else if (
      lines.some((entry) => entry.type === "assistant" && entry.message?.usage)
    ) {
      s.kind = "claude-code";
      parseClaude(s, lines);
    } else continue;
    if (s.requests) sessions.push(s);
  }
}

const k = (n) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(2)}M`
    : n >= 1e3
      ? `${(n / 1e3).toFixed(1)}k`
      : String(n);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "-");
const sent = (s) => s.input + s.cacheRead + s.cacheWrite;

if (!sessions.length) {
  console.log(
    `No sessions with token usage in the last ${days} days under:\n  ${roots.join("\n  ")}`,
  );
  console.log(
    "Pass the folder holding your session .jsonl files as an argument, or try --days 30.",
  );
  process.exit(0);
}

function report(label, group) {
  const total = blank();
  for (const s of group) {
    for (const key of [
      "prompts",
      "requests",
      "input",
      "cacheRead",
      "cacheWrite",
      "output",
      "warm",
      "compaction",
      "kernToolCalls",
      "toolCalls",
      "continuations",
    ])
      total[key] += s[key];
    for (const field of ["tools", "kernMessages", "models"])
      for (const [name, n] of Object.entries(s[field]))
        total[field][name] = (total[field][name] ?? 0) + n;
  }
  console.log(`\n=== ${label}: ${group.length} sessions, last ${days} days`);
  console.log(`  user prompts           ${total.prompts}`);
  console.log(
    `  model requests         ${total.requests}  (${(total.requests / Math.max(1, total.prompts)).toFixed(1)} per prompt)`,
  );
  console.log(
    `  tokens sent            ${k(sent(total))}  (fresh input ${k(total.input)}, cache read ${k(total.cacheRead)}, cache write ${k(total.cacheWrite)})`,
  );
  console.log(
    `  cache hit              ${pct(total.cacheRead, sent(total))} of tokens sent`,
  );
  console.log(`  output                 ${k(total.output)}`);
  if (total.warm) console.log(`  cache warming          ${k(total.warm)}`);
  if (total.compaction)
    console.log(`  compaction/summaries   ${k(total.compaction)}`);
  console.log(
    `  avg first request      ${k(Math.round(group.reduce((a, s) => a + s.firstRequest, 0) / group.length))}  (system prompt + tools + first message)`,
  );
  console.log(
    `  tool calls             ${total.toolCalls}, Kern bookkeeping tools ${total.kernToolCalls} (${pct(total.kernToolCalls, total.toolCalls)})`,
  );
  if (total.continuations)
    console.log(
      `  forced continuations   ${total.continuations} (request right after a hidden Kern message)`,
    );
  console.log("  models:");
  for (const [name, n] of Object.entries(total.models).sort(
    (a, b) => b[1] - a[1],
  ))
    console.log(`    ${String(n).padStart(5)}  ${name}`);
  console.log("  top tools (each call = one more full-context request):");
  for (const [name, n] of Object.entries(total.tools)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top))
    console.log(
      `    ${String(n).padStart(5)}  ${name}${KERN_TOOLS.has(name) ? "   <- Kern" : ""}`,
    );
  if (Object.keys(total.kernMessages).length) {
    console.log("  hidden Kern messages:");
    for (const [name, n] of Object.entries(total.kernMessages).sort(
      (a, b) => b[1] - a[1],
    ))
      console.log(`    ${String(n).padStart(5)}  ${name}`);
  }
  console.log("  heaviest sessions:");
  for (const s of [...group].sort((a, b) => sent(b) - sent(a)).slice(0, 6))
    console.log(
      `    ${k(sent(s)).padStart(7)} · ${String(s.requests).padStart(4)} req / ${s.prompts} prompts · first ${k(s.firstRequest)} · peak ${k(s.maxRequest)} · hit ${pct(s.cacheRead, sent(s))} · ${s.cwd ?? path.basename(s.file)}`,
    );
}

console.log(`Token audit — searched:\n  ${roots.join("\n  ")}`);
for (const kind of ["pi", "claude-code"]) {
  const group = sessions.filter((s) => s.kind === kind);
  if (group.length)
    report(
      kind === "pi"
        ? "pi harness"
        : "Claude Code / ACP (incl. terminal Claude Code)",
      group,
    );
}
console.log("");
