import { Children, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { slugifyHeading } from "../lib/deep-research";

export function formatChatCode(text: string) {
  const lines = text.split("\n");
  const output: string[] = [];
  let fenced = false;

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      output.push(line);
      index++;
      continue;
    }
    if (fenced) {
      output.push(line);
      index++;
      continue;
    }

    if (/^\s*curl(?:\s|$)/.test(line)) {
      const command = [line];
      while (command[command.length - 1]?.trimEnd().endsWith("\\") && index + command.length < lines.length) command.push(lines[index + command.length]);
      output.push("```bash", ...command, "```");
      index += command.length;
      continue;
    }

    if (/^\s*[{[]/.test(line)) {
      let jsonEnd = 0;
      for (let end = index + 1; end <= lines.length; end++) {
        const candidate = lines.slice(index, end).join("\n").trim();
        try {
          const parsed = JSON.parse(candidate);
          output.push("```json", JSON.stringify(parsed, null, 2), "```");
          jsonEnd = end;
          break;
        } catch { /* keep scanning until the JSON value is complete */ }
      }
      if (jsonEnd) {
        index = jsonEnd;
        continue;
      }
    }

    output.push(line);
    index++;
  }
  return output.join("\n");
}

function flattenText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(flattenText).join("");
  if (value && typeof value === "object" && "props" in (value as any)) {
    const props = (value as { props?: { children?: unknown } }).props;
    return flattenText(props?.children);
  }
  return "";
}

export default function MarkdownMessage({ children }: { children: string }) {
  const formatted = useMemo(() => formatChatCode(children), [children]);
  const seenRef = { current: {} as Record<string, number> };
  const getHeadingId = (text: string) => {
    const base = slugifyHeading(text);
    const count = seenRef.current[base] ?? 0;
    seenRef.current[base] = count + 1;
    return count === 0 ? base : `${base}-${count}`;
  };

  return <div className="markdown-body">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        input: ({ node: _node, ...props }) => <input {...props} disabled />,
        h2: ({ children: hChildren, ...props }) => {
          const text = flattenText(hChildren);
          const id = getHeadingId(text);
          return <h2 id={id} {...props}>{hChildren}</h2>;
        },
        h3: ({ children: hChildren, ...props }) => {
          const text = flattenText(hChildren);
          const id = getHeadingId(text);
          return <h3 id={id} {...props}>{hChildren}</h3>;
        },
        table: ({ children: tChildren, ...props }) => (
          <div className="md-table-wrapper">
            <table {...props}>{tChildren}</table>
          </div>
        ),
        td: ({ children: cellChildren, ...props }) => (
          <td {...props}>{Children.toArray(cellChildren).map((child, childIndex) =>
            typeof child === "string"
              ? child.split("\u2028").map((line, lineIndex) => <span key={`${childIndex}-${lineIndex}`}>{lineIndex > 0 && <br />}{line}</span>)
              : child
          )}</td>
        ),
      }}
    >{formatted}</ReactMarkdown>
  </div>;
}
