import { Children, lazy, Suspense, useEffect, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { slugifyHeading } from "../lib/deep-research";

const SyntaxCodeBlock = lazy(() => import("./SyntaxCodeBlock"));

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
  if (value && typeof value === "object" && "props" in (value as any)) return flattenText((value as { props?: { children?: unknown } }).props?.children);
  return "";
}

function CodeBlock({ code, language, isStreaming }: { code: string; language: string; isStreaming: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard.writeText(code).then(() => {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }).catch(() => undefined);

  return <div className="markdown-code-block">
    <header><span>{language || "text"}</span><button onClick={copy} disabled={isStreaming}>{copied ? "COPIED" : "COPY"}</button></header>
    {isStreaming ? <pre><code>{code}</code></pre> : <Suspense fallback={<pre><code>{code}</code></pre>}><SyntaxCodeBlock code={code} language={language} /></Suspense>}
  </div>;
}

function MermaidBlock({ code, isStreaming }: { code: string; isStreaming: boolean }) {
  const [preview, setPreview] = useState(false);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!preview || isStreaming) return;
    let cancelled = false;
    setSvg(null); setError(false);
    import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: "dark" });
      const id = `mermaid-${crypto.randomUUID()}`;
      const result = await mermaid.render(id, code);
      if (!cancelled) setSvg(result.svg);
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [code, isStreaming, preview]);

  if (!preview || isStreaming) return <div className="markdown-mermaid"><CodeBlock code={code} language="mermaid" isStreaming={isStreaming} /><button onClick={() => setPreview(true)} disabled={isStreaming}>PREVIEW DIAGRAM</button></div>;
  return <div className="markdown-mermaid"><header><span>mermaid</span><button onClick={() => setPreview(false)}>SHOW SOURCE</button></header>{error ? <p>Unable to render Mermaid diagram.</p> : svg ? <div className="mermaid-preview" dangerouslySetInnerHTML={{ __html: svg }} /> : <p>Rendering diagram…</p>}</div>;
}

const MAX_MARKDOWN_CHARS = 100_000;
const sanitizeSchema = {
  ...defaultSchema,
  attributes: { ...(defaultSchema.attributes ?? {}), code: [...(defaultSchema.attributes?.code || []), ["className", /^language-|^math-/]] },
  strip: [...(defaultSchema.strip || []), "iframe", "object", "style", "form"],
};

export default function MarkdownMessage({ children, isStreaming = false }: { children: string; isStreaming?: boolean }) {
  const [showLargeMessage, setShowLargeMessage] = useState(false);
  const formatted = useMemo(() => formatChatCode(children), [children]);
  const components = useMemo<Components>(() => ({
    a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
    input: ({ node: _node, ...props }) => <input {...props} disabled />,
    h2: ({ children: headingChildren, ...props }) => <h2 id={slugifyHeading(flattenText(headingChildren))} {...props}>{headingChildren}</h2>,
    h3: ({ children: headingChildren, ...props }) => <h3 id={slugifyHeading(flattenText(headingChildren))} {...props}>{headingChildren}</h3>,
    pre: ({ children: preChildren }) => <>{preChildren}</>,
    code: ({ className, children: codeChildren }) => {
      const code = String(codeChildren).replace(/\n$/, "");
      const language = className?.replace("language-", "") || "";
      if (!className?.includes("language-") && !code.includes("\n")) return <code className={className}>{codeChildren}</code>;
      return language === "mermaid" ? <MermaidBlock code={code} isStreaming={isStreaming} /> : <CodeBlock code={code} language={language} isStreaming={isStreaming} />;
    },
    table: ({ children: tableChildren, ...props }) => <div className="md-table-wrapper"><table {...props}>{tableChildren}</table></div>,
    td: ({ children: cellChildren, ...props }) => <td {...props}>{Children.toArray(cellChildren).map((child, childIndex) => typeof child === "string" ? child.split("\u2028").map((line, lineIndex) => <span key={`${childIndex}-${lineIndex}`}>{lineIndex > 0 && <br />}{line}</span>) : child)}</td>,
  }), [isStreaming]);

  if (formatted.length > MAX_MARKDOWN_CHARS && !showLargeMessage) return <button className="markdown-large-message" onClick={() => setShowLargeMessage(true)}>Large response ({Math.ceil(formatted.length / 1000)} KB) — show as text</button>;
  if (formatted.length > MAX_MARKDOWN_CHARS) return <pre className="markdown-large-message-content">{formatted}</pre>;

  return <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeKatex]} components={components}>{formatted}</ReactMarkdown></div>;
}
