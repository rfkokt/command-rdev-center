import { describe, expect, test } from "vitest";
import { activityKind, getSubagentMeta, isSubagentTool, isWebSearchTool } from "./ToolCall";

describe("isWebSearchTool", () => {
  test("distinguishes web research from ordinary tools", () => {
    expect(isWebSearchTool("functions.web_search")).toBe(true);
    expect(isWebSearchTool("source_check")).toBe(true);
    expect(isWebSearchTool("functions.fetch_content")).toBe(true);
    expect(isWebSearchTool("functions.read")).toBe(false);
    expect(isWebSearchTool("search_files")).toBe(false);
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
