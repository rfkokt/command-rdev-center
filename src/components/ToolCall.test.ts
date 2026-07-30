import { describe, expect, test } from "vitest";
import { isWebSearchTool } from "./ToolCall";

describe("isWebSearchTool", () => {
  test("distinguishes web research from ordinary tools", () => {
    expect(isWebSearchTool("functions.web_search")).toBe(true);
    expect(isWebSearchTool("source_check")).toBe(true);
    expect(isWebSearchTool("functions.fetch_content")).toBe(true);
    expect(isWebSearchTool("functions.read")).toBe(false);
    expect(isWebSearchTool("search_files")).toBe(false);
  });
});
