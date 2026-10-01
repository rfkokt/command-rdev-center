// @vitest-environment jsdom

import { createElement } from "react";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import MarkdownMessage, {
  areMarkdownMessagePropsEqual,
  formatChatCode,
  hasMath,
} from "./MarkdownMessage";

describe("MarkdownMessage", () => {
  test("renders preserved spreadsheet newlines inside table cells", () => {
    const { container } = render(
      createElement(
        MarkdownMessage,
        null,
        "| Deskripsi |\n| --- |\n| Baris satu\u2028Baris dua |",
      ),
    );
    expect(container.querySelector("td br")).not.toBeNull();
  });

  test("adds a working copy control to fenced code blocks", async () => {
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    const { getByRole } = render(
      createElement(MarkdownMessage, null, "```ts\nconst answer = 42;\n```"),
    );
    fireEvent.click(getByRole("button", { name: "COPY" }));
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(await getByRole("button", { name: "COPIED" })).toBeTruthy();
    delete (document as { execCommand?: unknown }).execCommand;
  });

  test("defers Markdown parsing for oversized responses", () => {
    const { getByRole, container } = render(
      createElement(MarkdownMessage, null, "x".repeat(100_001)),
    );
    expect(getByRole("button", { name: /Large response/ })).toBeTruthy();
    expect(container.querySelector(".markdown-body")).toBeNull();
  });

  test("renders KaTeX math and sanitizes unsafe HTML", async () => {
    // KaTeX loads lazily via dynamic import only when math is detected.
    const { container } = render(
      createElement(
        MarkdownMessage,
        null,
        "$x^2$ <script>alert(1)</script><b>safe</b>",
      ),
    );
    await waitFor(() =>
      expect(container.querySelector(".katex")).not.toBeNull(),
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")?.textContent).toBe("safe");
  });

  test("offers Mermaid diagram preview", () => {
    const { getByRole } = render(
      createElement(MarkdownMessage, null, "```mermaid\ngraph TD; A-->B;\n```"),
    );
    expect(getByRole("button", { name: "PREVIEW DIAGRAM" })).toBeTruthy();
  });
});

describe("hasMath", () => {
  test("detects inline, display, and escaped math delimiters", () => {
    expect(hasMath("solve $x^2$ now")).toBe(true);
    expect(hasMath("$$\nx^2\n$$")).toBe(true);
    expect(hasMath("see \\(x+1\\) here")).toBe(true);
    expect(hasMath("see \\[x+1\\] here")).toBe(true);
  });

  test("ignores dollar signs inside code", () => {
    expect(hasMath("```js\nconst price = `$5`;\n```")).toBe(false);
    expect(hasMath("use `$HOME` here")).toBe(false);
    expect(hasMath("it costs $5 total")).toBe(false);
  });

  test("renders identically without math and without KaTeX loaded", () => {
    const { container } = render(
      createElement(MarkdownMessage, null, "plain **bold** text"),
    );
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("bold");
  });
});

describe("formatChatCode", () => {
  test("turns raw curl and JSON into readable fenced blocks", () => {
    expect(
      formatChatCode(`Run this:
curl -X 'POST' \\
  'https://example.test/items' \\
  -H 'accept: application/json'

{"ok":true,"items":[1,2]}`),
    ).toBe(`Run this:
\`\`\`bash
curl -X 'POST' \\
  'https://example.test/items' \\
  -H 'accept: application/json'
\`\`\`

\`\`\`json
{
  "ok": true,
  "items": [
    1,
    2
  ]
}
\`\`\``);
  });

  test("leaves existing fenced code untouched", () => {
    const markdown = "```bash\ncurl https://example.test\n```";
    expect(formatChatCode(markdown)).toBe(markdown);
  });
});

describe("memoization", () => {
  test("areMarkdownMessagePropsEqual compares text and streaming flag", () => {
    expect(
      areMarkdownMessagePropsEqual({ children: "a" }, { children: "a" }),
    ).toBe(true);
    // `isStreaming` defaults to false, so undefined and false are equivalent.
    expect(
      areMarkdownMessagePropsEqual(
        { children: "a", isStreaming: undefined },
        { children: "a", isStreaming: false },
      ),
    ).toBe(true);
    expect(
      areMarkdownMessagePropsEqual({ children: "a" }, { children: "b" }),
    ).toBe(false);
    expect(
      areMarkdownMessagePropsEqual(
        { children: "a", isStreaming: true },
        { children: "a", isStreaming: false },
      ),
    ).toBe(false);
  });

  test("default export is a memo component", () => {
    expect((MarkdownMessage as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for("react.memo"),
    );
  });

  test("rerender with identical props keeps rendered output", () => {
    const props = { isStreaming: false, children: "hello **world**" };
    const { container, rerender } = render(
      createElement(MarkdownMessage, props),
    );
    const html = container.innerHTML;
    rerender(createElement(MarkdownMessage, props));
    expect(container.innerHTML).toBe(html);
    expect(container.querySelector("strong")?.textContent).toBe("world");
  });
});
