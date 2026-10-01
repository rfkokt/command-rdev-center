// @vitest-environment jsdom

import { createElement } from "react";
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import ThinkingBlock, { areThinkingBlockPropsEqual } from "./ThinkingBlock";

describe("ThinkingBlock", () => {
  test("renders thinking text inside a collapsible block", () => {
    const { container } = render(
      createElement(ThinkingBlock, {
        isStreaming: true,
        children: "reasoning here",
      }),
    );
    expect(container.querySelector("details.thinking-block")).not.toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe("reasoning here");
  });

  test("areThinkingBlockPropsEqual compares text and streaming flag", () => {
    expect(
      areThinkingBlockPropsEqual({ children: "a" }, { children: "a" }),
    ).toBe(true);
    expect(
      areThinkingBlockPropsEqual(
        { children: "a", isStreaming: undefined },
        { children: "a", isStreaming: false },
      ),
    ).toBe(true);
    expect(
      areThinkingBlockPropsEqual({ children: "a" }, { children: "b" }),
    ).toBe(false);
    expect(
      areThinkingBlockPropsEqual(
        { children: "a", isStreaming: true },
        { children: "a", isStreaming: false },
      ),
    ).toBe(false);
  });

  test("default export is a memo component", () => {
    expect((ThinkingBlock as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for("react.memo"),
    );
  });

  test("rerender with identical props keeps rendered output", () => {
    const props = { isStreaming: false, children: "same thought" };
    const { container, rerender } = render(createElement(ThinkingBlock, props));
    const html = container.innerHTML;
    rerender(createElement(ThinkingBlock, props));
    expect(container.innerHTML).toBe(html);
  });
});
