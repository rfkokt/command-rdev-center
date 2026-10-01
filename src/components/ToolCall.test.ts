// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";
import { createElement } from "react";
import ToolCallView, {
  activityKind,
  areToolCallPropsEqual,
  browserScreenshotRef,
  browserScreenshotRefFromText,
  getSubagentMeta,
  isSubagentTool,
  isWebSearchTool,
} from "./ToolCall";
import type { ToolCall as TC } from "../lib/rpc";

describe("isWebSearchTool", () => {
  test("distinguishes web research from ordinary tools", () => {
    expect(isWebSearchTool("functions.web_search")).toBe(true);
    expect(isWebSearchTool("source_check")).toBe(true);
    expect(isWebSearchTool("functions.fetch_content")).toBe(true);
    expect(isWebSearchTool("functions.read")).toBe(false);
    expect(isWebSearchTool("search_files")).toBe(false);
  });
});

describe("browserScreenshotRef", () => {
  test("extracts persisted artifact refs from assistant text", () => {
    expect(
      browserScreenshotRefFromText(
        "Artifact: browser-artifact:chat-global-1:8fdefd828991e2db423196317ccc71c8",
      ),
    ).toBe("browser-artifact:chat-global-1:8fdefd828991e2db423196317ccc71c8");
  });

  test("extracts restored tool-result content", () => {
    expect(
      browserScreenshotRef({
        callId: "restored",
        name: "browser_screenshot",
        args: {},
        result: [
          {
            type: "text",
            text: JSON.stringify({
              status: "ok",
              data: {
                artifactRef:
                  "browser-artifact:chat-global-1:8fdefd828991e2db423196317ccc71c8",
              },
            }),
          },
        ],
        phase: "end",
      }),
    ).toBe("browser-artifact:chat-global-1:8fdefd828991e2db423196317ccc71c8");
  });

  test("extracts completed browser screenshot artifacts", () => {
    expect(
      browserScreenshotRef({
        callId: "1",
        name: "browser_screenshot",
        args: {},
        result: {
          details: {
            data: { artifactRef: "browser-artifact:chat-a:0123456789abcdef" },
          },
        },
        phase: "end",
      }),
    ).toBe("browser-artifact:chat-a:0123456789abcdef");
  });
});

describe("isSubagentTool", () => {
  test("matches direct and namespaced subagent calls only", () => {
    expect(isSubagentTool("subagent")).toBe(true);
    expect(isSubagentTool("functions.subagent")).toBe(true);
    expect(isSubagentTool("subagent_wait")).toBe(true);
    expect(isSubagentTool("subagent_supervisor")).toBe(true);
    expect(isSubagentTool("functions.bash")).toBe(false);
  });
});

describe("activityKind", () => {
  test("classifies long-running activities without styling ordinary tools", () => {
    expect(activityKind("interactive_shell")).toBe("process");
    expect(activityKind("functions.index_and_search_cbm")).toBe("index");
    expect(activityKind("ralph_start")).toBe("loop");
    expect(activityKind("functions.read")).toBeNull();
    expect(activityKind("manage_todo_list")).toBeNull();
  });
});

describe("getSubagentMeta", () => {
  test("extracts counts from parallel and chain payloads", () => {
    expect(getSubagentMeta({ tasks: [{}, {}, {}] }).count).toBe(3);
    expect(getSubagentMeta({ tasks: [{}, {}] }).mode).toBe("PARALLEL");
    expect(getSubagentMeta({ chain: [{}, {}] }).count).toBe(2);
    expect(getSubagentMeta({ chain: [{}, {}] }).mode).toBe("CHAIN");
    expect(getSubagentMeta({ agent: "design" }).detail).toContain("DESIGN");
  });
});

const makeTc = (overrides: Partial<TC> = {}): TC => ({
  callId: "call-1",
  name: "functions.read",
  args: { path: "src/index.ts" },
  phase: "end",
  ...overrides,
});

describe("areToolCallPropsEqual", () => {
  test("treats field-identical tool calls as equal despite new identity", () => {
    expect(areToolCallPropsEqual({ tc: makeTc() }, { tc: makeTc() })).toBe(
      true,
    );
    // Same object identity is trivially equal.
    const tc = makeTc();
    expect(areToolCallPropsEqual({ tc }, { tc })).toBe(true);
  });

  test("detects phase, error, name, arg, and result changes", () => {
    const prev = { tc: makeTc() };
    expect(
      areToolCallPropsEqual(prev, { tc: makeTc({ phase: "delta" }) }),
    ).toBe(false);
    expect(areToolCallPropsEqual(prev, { tc: makeTc({ isError: true }) })).toBe(
      false,
    );
    expect(
      areToolCallPropsEqual(prev, { tc: makeTc({ name: "functions.bash" }) }),
    ).toBe(false);
    expect(
      areToolCallPropsEqual(prev, {
        tc: makeTc({ args: { path: "other.ts" } }),
      }),
    ).toBe(false);
    expect(
      areToolCallPropsEqual(prev, {
        tc: makeTc({ args: { path: "src/index.ts", extra: 1 } }),
      }),
    ).toBe(false);
  });

  test("compares result by reference so new payloads re-render", () => {
    const shared = { ok: true };
    expect(
      areToolCallPropsEqual(
        { tc: makeTc({ result: shared }) },
        { tc: makeTc({ result: shared }) },
      ),
    ).toBe(true);
    expect(
      areToolCallPropsEqual(
        { tc: makeTc({ result: { ok: true } }) },
        { tc: makeTc({ result: { ok: true } }) },
      ),
    ).toBe(false);
  });
});

describe("ToolCallView memoization", () => {
  test("default export is a memo component", () => {
    expect((ToolCallView as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for("react.memo"),
    );
  });

  test("rerender with the same tool call keeps rendered output", () => {
    const tc = makeTc({ result: "done" });
    const { container, rerender } = render(createElement(ToolCallView, { tc }));
    const html = container.innerHTML;
    rerender(createElement(ToolCallView, { tc }));
    expect(container.innerHTML).toBe(html);
    expect(container.querySelector("strong")?.textContent).toBe(
      "functions.read",
    );
  });
});
