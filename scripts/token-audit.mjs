#!/usr/bin/env node
// Where do Kern's tokens go? Reads pi session files (JSONL) and reports, per
// session and in total: model requests per user prompt, input / cache read /
// cache write / output tokens, cache hit rate, the size of the first request
// (system prompt + tools baseline), cache warming and compaction usage, and
// how many requests went to Kern's own bookkeeping tools.
//
// Usage: node scripts/token-audit.mjs [sessions-dir] [--days 7] [--top 15]
// Default dir: ~/.pi/agent/sessions. Nothing is sent anywhere.

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
const root =
  args.find(
    (arg, i) => !arg.startsWith("--") && !args[i - 1]?.startsWith("--"),
  ) ?? path.join(os.homedir(), ".pi/agent/sessions");
const since = Date.now() - days * 86_400_000;

// Kern's extensions: tools/messages that cost a full model round trip each.
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

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".jsonl")) {
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
  kernMessages: {},
  tools: {},
  models: {},
  continuations: 0,
});
const add = (a, u) => {
  a.input += u?.input ?? 0;
  a.cacheRead += u?.cacheRead ?? 0;
  a.cacheWrite += u?.cacheWrite ?? 0;
  a.output += u?.output ?? 0;
};

const sessions = [];
for (const file of walk(root)) {
  const s = blank();
  s.file = file;
  let lastRole = null;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session") s.cwd = entry.cwd;
    if (entry.type === "usage") {
      if (entry.kind === "cache_warm") s.warm += entry.usage?.totalTokens ?? 0;
      add(s, entry.usage);
      continue;
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      const u = entry.usage;
      s.compaction +=
        (u?.input ?? 0) +
        (u?.cacheRead ?? 0) +
        (u?.cacheWrite ?? 0) +
        (u?.output ?? 0);
      add(s, u);
      continue;
    }
    if (
      entry.type === "custom_message" &&
      KERN_MESSAGES.test(entry.customType ?? "")
    ) {
      s.kernMessages[entry.customType] =
        (s.kernMessages[entry.customType] ?? 0) + 1;
      // A hidden Kern message right before a model request = an extra turn.
      lastRole = "kern";
      continue;
    }
    if (entry.type !== "message") continue;
    const m = entry.message ?? {};
    if (m.role === "user") {
      s.prompts++;
      lastRole = "user";
    } else if (m.role === "assistant" && m.usage) {
      s.requests++;
      if (lastRole === "kern") s.continuations++;
      lastRole = "assistant";
      add(s, m.usage);
      const size =
        (m.usage.input ?? 0) +
        (m.usage.cacheRead ?? 0) +
        (m.usage.cacheWrite ?? 0);
      if (!s.firstRequest) s.firstRequest = size;
      s.maxRequest = Math.max(s.maxRequest, size);
      const model = `${m.provider ?? "?"}/${m.model ?? "?"}`;
      s.models[model] = (s.models[model] ?? 0) + 1;
      for (const block of Array.isArray(m.content) ? m.content : []) {
        if (block?.type !== "toolCall") continue;
        s.toolCalls++;
        s.tools[block.name] = (s.tools[block.name] ?? 0) + 1;
        if (KERN_TOOLS.has(block.name)) s.kernToolCalls++;
      }
    } else if (m.role === "toolResult") lastRole = "tool";
  }
  if (s.requests) sessions.push(s);
}

const total = blank();
for (const s of sessions) {
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
  for (const [k, v] of Object.entries(s.tools))
    total.tools[k] = (total.tools[k] ?? 0) + v;
  for (const [k, v] of Object.entries(s.kernMessages))
    total.kernMessages[k] = (total.kernMessages[k] ?? 0) + v;
  for (const [k, v] of Object.entries(s.models))
    total.models[k] = (total.models[k] ?? 0) + v;
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
    `No pi sessions with usage in ${root} from the last ${days} days.`,
  );
  console.log(
    "If Kern uses a custom sessionDir (pi settings.json), pass it as the first argument.",
  );
  process.exit(0);
}

console.log(
  `\nKern / pi token audit — ${sessions.length} sessions, last ${days} days, ${root}\n`,
);
console.log("TOTAL");
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
console.log(`  cache warming          ${k(total.warm)}`);
console.log(`  compaction/summaries   ${k(total.compaction)}`);
console.log(
  `  avg first request      ${k(Math.round(sessions.reduce((a, s) => a + s.firstRequest, 0) / sessions.length))}  (system prompt + tools + first message)`,
);
console.log(
  `  tool calls             ${total.toolCalls}, of which Kern bookkeeping tools ${total.kernToolCalls} (${pct(total.kernToolCalls, total.toolCalls)})`,
);
console.log(
  `  requests after a hidden Kern message (forced continuations) ${total.continuations}`,
);
console.log("\nModels");
for (const [name, n] of Object.entries(total.models).sort(
  (a, b) => b[1] - a[1],
))
  console.log(`  ${String(n).padStart(5)}  ${name}`);
console.log("\nTop tools (each call = one more full-context request)");
for (const [name, n] of Object.entries(total.tools)
  .sort((a, b) => b[1] - a[1])
  .slice(0, top))
  console.log(
    `  ${String(n).padStart(5)}  ${name}${KERN_TOOLS.has(name) ? "   <- Kern" : ""}`,
  );
if (Object.keys(total.kernMessages).length) {
  console.log("\nHidden Kern messages injected into context");
  for (const [name, n] of Object.entries(total.kernMessages).sort(
    (a, b) => b[1] - a[1],
  ))
    console.log(`  ${String(n).padStart(5)}  ${name}`);
}
console.log("\nHeaviest sessions");
for (const s of sessions.sort((a, b) => sent(b) - sent(a)).slice(0, 8))
  console.log(
    `  ${k(sent(s)).padStart(7)} sent · ${String(s.requests).padStart(4)} req / ${s.prompts} prompts · first ${k(s.firstRequest)} · peak ${k(s.maxRequest)} · hit ${pct(s.cacheRead, sent(s))} · ${s.cwd ?? path.basename(s.file)}`,
  );
console.log("");
