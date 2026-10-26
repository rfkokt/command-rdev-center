import { describe, expect, test } from "vitest";
import {
  buildChatHandoff,
  buildFullTranscript,
  isUsageLimitError,
  workDigest,
} from "./handoff";
import type { ToolCall } from "./rpc";

const call = (
  name: string,
  args: Record<string, unknown>,
  isError = false,
): ToolCall => ({
  callId: Math.random().toString(36),
  name,
  args,
  isError,
  phase: "end",
});

const chat = [
  {
    role: "user" as const,
    text: "Add dark mode to the settings page",
    toolCalls: [],
  },
  {
    role: "assistant" as const,
    text: "Reading the settings page.",
    toolCalls: [
      call("read", { path: "src/Settings.tsx" }),
      call("edit", { path: "src/Settings.tsx", oldText: "a", newText: "b" }),
      call("Edit", { file_path: "src/theme.css" }),
      call("bash", { command: "pnpm test" }, true),
    ],
  },
  {
    role: "system" as const,
    text: "Agent error: usage limit reached",
    toolCalls: [],
  },
  { role: "user" as const, text: "also persist the choice", toolCalls: [] },
];

describe("handoff", () => {
  test("keeps the goal, every request, files changed, commands and worktree state", () => {
    const handoff = buildChatHandoff({
      messages: chat,
      from: "Claude Code (claude-opus-5-5)",
      changes: [
        { path: "src/Settings.tsx", status: "M", added: 12, removed: 3 },
      ],
      fullPath: "/data/handoffs/chat.md",
    })!;
    expect(handoff).toContain("Claude Code (claude-opus-5-5)");
    expect(handoff).toContain(
      "### Goal (first request)\n\nAdd dark mode to the settings page",
    );
    expect(handoff).toContain("2. also persist the choice");
    expect(handoff).toContain(
      "Edited/created: src/Settings.tsx, src/theme.css",
    );
    expect(handoff).toContain("Read: src/Settings.tsx");
    expect(handoff).toContain("- [failed] pnpm test");
    expect(handoff).toContain("- M src/Settings.tsx (+12/-3)");
    expect(handoff).toContain("/data/handoffs/chat.md");
    expect(handoff).not.toContain("Agent error");
  });

  test("stays within budget but never drops the goal", () => {
    const long = Array.from({ length: 200 }, (_, index) => ({
      role: index % 2 ? ("assistant" as const) : ("user" as const),
      text: `${index === 0 ? "THE GOAL " : ""}${"x".repeat(1500)} #${index}`,
      toolCalls: [],
    }));
    const handoff = buildChatHandoff({
      messages: long,
      from: "pi",
      budget: 20_000,
    })!;
    expect(handoff).toContain("THE GOAL");
    expect(handoff).toContain("#199");
    expect(handoff).toMatch(/older messages only in the full transcript/);
    expect(handoff.length).toBeLessThan(60_000);
  });

  test("nothing to hand over without a user message", () => {
    expect(
      buildChatHandoff({
        messages: [{ role: "assistant", text: "hi" }],
        from: "pi",
      }),
    ).toBeUndefined();
  });

  test("digest strips MCP prefixes and ignores tools without paths", () => {
    const digest = workDigest([
      {
        role: "assistant",
        text: "",
        toolCalls: [
          call("mcp__acp__Write", { file_path: "a.ts" }),
          call("web_search", { q: "x" }),
        ],
      },
    ]);
    expect([...digest.edited.keys()]).toEqual(["a.ts"]);
    expect(digest.commands).toEqual([]);
  });

  test("full transcript includes tool calls and clipped results", () => {
    const text = buildFullTranscript(
      [
        {
          role: "assistant",
          text: "done",
          toolCalls: [
            {
              ...call("bash", { command: "ls" }),
              result: { content: [{ type: "text", text: "a\nb" }] },
            },
          ],
        },
      ],
      "pi",
    );
    expect(text).toContain("tool bash");
    expect(text).toContain('"command":"ls"');
    expect(text).toContain("result: a\n  b");
  });

  test.each([
    "Claude AI usage limit reached|1761500000",
    "You've hit your limit · resets 3pm",
    "429 Too Many Requests",
    '{"type":"error","error":{"type":"rate_limit_error"}}',
    "insufficient_quota: You exceeded your current quota",
    "RESOURCE_EXHAUSTED",
  ])("detects usage limits: %s", (text) =>
    expect(isUsageLimitError(text)).toBe(true),
  );

  test.each([
    "ENOENT: no such file",
    "TypeError: cannot read x",
    "socket hang up",
  ])("ignores other errors: %s", (text) =>
    expect(isUsageLimitError(text)).toBe(false),
  );
});
