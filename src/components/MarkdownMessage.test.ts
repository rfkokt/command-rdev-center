// @vitest-environment jsdom

import { createElement } from "react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import MarkdownMessage, { formatChatCode } from "./MarkdownMessage";

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

  test("renders KaTeX math and sanitizes unsafe HTML", () => {
    const { container } = render(
      createElement(
        MarkdownMessage,
        null,
        "$x^2$ <script>alert(1)</script><b>safe</b>",
      ),
    );
    expect(container.querySelector(".katex")).not.toBeNull();
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
