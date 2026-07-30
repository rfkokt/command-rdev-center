// @vitest-environment jsdom

import { createElement } from "react";
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import MarkdownMessage, { formatChatCode } from "./MarkdownMessage";

describe("MarkdownMessage", () => {
  test("renders preserved spreadsheet newlines inside table cells", () => {
    const { container } = render(createElement(MarkdownMessage, null, "| Deskripsi |\n| --- |\n| Baris satu\u2028Baris dua |"));
    expect(container.querySelector("td br")).not.toBeNull();
  });
});

describe("formatChatCode", () => {
  test("turns raw curl and JSON into readable fenced blocks", () => {
    expect(formatChatCode(`Run this:
curl -X 'POST' \\
  'https://example.test/items' \\
  -H 'accept: application/json'

{"ok":true,"items":[1,2]}`)).toBe(`Run this:
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
