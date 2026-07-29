import { describe, expect, test } from "vitest";
import { formatChatCode } from "./MarkdownMessage";

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
