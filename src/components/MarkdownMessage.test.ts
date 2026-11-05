// @vitest-environment jsdom

import { createElement, StrictMode } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import MarkdownMessage, {
  areMarkdownMessagePropsEqual,
  formatChatCode,
  hasMath,
} from "./MarkdownMessage";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("MarkdownMessage", () => {
  test.each([
    "/workspace/My%20Project/worker.py:2",
    "file:///workspace/My%20Project/worker.py#L2",
    "./worker.py#L2",
  ])(
    "opens local file link %s in a preview at the cited line",
    async (href) => {
      vi.mocked(invoke).mockResolvedValue("first line\nPDF worker\nlast line");
      const { getByRole, findByRole, queryByRole, getByText } = render(
        createElement(MarkdownMessage, {
          projectPath: "/workspace/My Project",
          children: `[Kode prosesnya](${href})`,
        }),
      );
      fireEvent.click(getByRole("link", { name: "Kode prosesnya" }));
      await findByRole("dialog");
      await waitFor(() => expect(getByText("PDF worker")).toBeTruthy());
      expect(invoke).toHaveBeenCalledWith("get_project_file_content", {
        projectPath: "/workspace/My Project",
        fileName: "worker.py",
      });
      expect(
        getByText("PDF worker").parentElement?.getAttribute("style"),
      ).toContain("background");
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(queryByRole("dialog")).toBeNull());
    },
  );

  test("shows a visible error when a linked file cannot be read", async () => {
    vi.mocked(invoke).mockRejectedValue("File not found");
    const { getByRole, findByRole } = render(
      createElement(MarkdownMessage, null, "[Missing](/workspace/missing.py)"),
    );
    fireEvent.click(getByRole("link", { name: "Missing" }));
    expect((await findByRole("alert")).textContent).toContain("File not found");
  });

  test("keeps web links and anchors while blocking unsafe protocols", () => {
    const { getByRole, container } = render(
      createElement(
        MarkdownMessage,
        null,
        '[Web](https://example.com/code.py#L2) [Section](#section) [Unsafe](javascript:alert) <a href="file://remote/share/file.py">Remote file</a>',
      ),
    );
    expect(getByRole("link", { name: "Web" }).getAttribute("target")).toBe(
      "_blank",
    );
    expect(
      getByRole("link", { name: "Section" }).getAttribute("target"),
    ).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector('a[href^="file://remote"]')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
  test("renders math after StrictMode replays effects", async () => {
    const { container } = render(
      createElement(
        StrictMode,
        null,
        createElement(MarkdownMessage, null, "$x^2$"),
      ),
    );
    await waitFor(() =>
      expect(container.querySelector(".katex")).not.toBeNull(),
    );
  });

  test("keeps loading math when streamed text changes", async () => {
    const { container, rerender } = render(
      createElement(MarkdownMessage, { isStreaming: true, children: "$x^2$" }),
    );
    rerender(
      createElement(MarkdownMessage, {
        isStreaming: true,
        children: "$x^2$ more text",
      }),
    );
    await waitFor(() =>
      expect(container.querySelector(".katex")).not.toBeNull(),
    );
  });

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
    fireEvent.click(getByRole("button", { name: "Copy" }));
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(await getByRole("button", { name: "Copied" })).toBeTruthy();
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
        { children: "a", projectPath: "/old" },
        { children: "a", projectPath: "/new" },
      ),
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
