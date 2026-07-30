import { Children } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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

export default function MarkdownMessage({ children }: { children: string }) {
  return <div className="markdown-body">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        input: ({ node: _node, ...props }) => <input {...props} disabled />,
        table: ({ children: tChildren, ...props }) => (
          <div className="md-table-wrapper">
            <table {...props}>{tChildren}</table>
          </div>
        ),
        td: ({ children: cellChildren, ...props }) => (
          <td {...props}>{Children.toArray(cellChildren).flatMap((child, childIndex) =>
            typeof child === "string"
              ? child.split("\u2028").flatMap((line, lineIndex) => lineIndex ? [<br key={`${childIndex}-${lineIndex}`} />, line] : [line])
              : [child]
          )}</td>
        ),
      }}
    >{formatChatCode(children)}</ReactMarkdown>
  </div>;
}
