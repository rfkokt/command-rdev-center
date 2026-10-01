import {
  Children,
  lazy,
  memo,
  Suspense,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { slugifyHeading } from "../lib/deep-research";

// Plugin element type, derived from ReactMarkdown's own props so we don't
// depend on unified's (transitive) type exports directly.
type RehypePlugin = Exclude<
  ComponentProps<typeof ReactMarkdown>["rehypePlugins"],
  null | undefined
>[number];

const SyntaxCodeBlock = lazy(() => import("./SyntaxCodeBlock"));

export function formatChatCode(text: string) {
  const lines = text.split("\n");
  const output: string[] = [];
  let fenced = false;

  for (let index = 0; index < lines.length; ) {
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
      while (
        command[command.length - 1]?.trimEnd().endsWith("\\") &&
        index + command.length < lines.length
      )
        command.push(lines[index + command.length]);
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
        } catch {
          /* keep scanning until the JSON value is complete */
        }
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
  if (value && typeof value === "object" && "props" in (value as any))
    return flattenText(
      (value as { props?: { children?: unknown } }).props?.children,
    );
  return "";
}

function CodeBlock({
  code,
  language,
  isStreaming,
}: {
  code: string;
  language: string;
  isStreaming: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText)
        await navigator.clipboard.writeText(code);
      else throw new Error("Clipboard API unavailable");
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = code;
      textarea.style.cssText = "position:fixed;opacity:0";
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="markdown-code-block">
      <header>
        <span>{language || "text"}</span>
        <button onClick={copy} disabled={isStreaming}>
          {copied ? "COPIED" : "COPY"}
        </button>
      </header>
      {isStreaming ? (
        <pre>
          <code>{code}</code>
        </pre>
      ) : (
        <Suspense
          fallback={
            <pre>
              <code>{code}</code>
            </pre>
          }
        >
          <SyntaxCodeBlock code={code} language={language} />
        </Suspense>
      )}
    </div>
  );
}

function MermaidBlock({
  code,
  isStreaming,
}: {
  code: string;
  isStreaming: boolean;
}) {
  const [preview, setPreview] = useState(false);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!preview || isStreaming) return;
    let cancelled = false;
    setSvg(null);
    setError(false);
    import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: "dark",
        });
        const id = `mermaid-${crypto.randomUUID()}`;
        const result = await mermaid.render(id, code);
        if (!cancelled) setSvg(result.svg);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code, isStreaming, preview]);

  if (!preview || isStreaming)
    return (
      <div className="markdown-mermaid">
        <CodeBlock code={code} language="mermaid" isStreaming={isStreaming} />
        <button onClick={() => setPreview(true)} disabled={isStreaming}>
          PREVIEW DIAGRAM
        </button>
      </div>
    );
  return (
    <div className="markdown-mermaid">
      <header>
        <span>mermaid</span>
        <button onClick={() => setPreview(false)}>SHOW SOURCE</button>
      </header>
      {error ? (
        <p>Unable to render Mermaid diagram.</p>
      ) : svg ? (
        <div
          className="mermaid-preview"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <p>Rendering diagram…</p>
      )}
    </div>
  );
}

const MAX_MARKDOWN_CHARS = 100_000;
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    code: [
      ...(defaultSchema.attributes?.code || []),
      ["className", /^language-|^math-/],
    ],
  },
  strip: [...(defaultSchema.strip || []), "iframe", "object", "style", "form"],
};

// Strip fenced code blocks and inline code spans so `$` in code never
// triggers a KaTeX load (remark-math doesn't parse math inside code either).
function stripCodeSegments(source: string): string {
  return source.replace(/```[\s\S]*?(?:```|$)/g, "").replace(/`[^`\n]*`/g, "");
}

// Generous math detection mirroring what remark-math parses ($…$, $$…$$,
// \(…\), \[…\]). Deliberately a superset: a false positive only costs one
// lazy chunk load (the plugin then finds no math nodes and output is
// unchanged), while a false negative would leave math unrendered.
const MATH_PATTERN =
  /\$\$[\s\S]+?\$\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]|\$[^$]+?\$/;

export function hasMath(source: string): boolean {
  return MATH_PATTERN.test(stripCodeSegments(source));
}

type MarkdownMessageProps = {
  children: string;
  isStreaming?: boolean;
};

function MarkdownMessage({
  children,
  isStreaming = false,
}: MarkdownMessageProps) {
  const [showLargeMessage, setShowLargeMessage] = useState(false);
  // ponytail: format is O(n^2)-ish scanning; skip it per-frame while streaming.
  const formatted = useMemo(
    () => (isStreaming ? children : formatChatCode(children)),
    [children, isStreaming],
  );
  // KaTeX is heavy: keep it out of the initial bundle and only load it (plus
  // its CSS) for messages that actually contain math. Mirrors the dynamic
  // mermaid import in MermaidBlock. Messages without math render through the
  // exact same pipeline as before, minus the no-op plugin.
  const [katexPlugin, setKatexPlugin] = useState<RehypePlugin | null>(null);
  const containsMath = useMemo(() => hasMath(formatted), [formatted]);
  useEffect(() => {
    if (!containsMath) {
      setKatexPlugin(null);
      return;
    }
    let cancelled = false;
    Promise.all([import("rehype-katex"), import("katex/dist/katex.min.css")])
      .then(([katexModule]) => {
        if (cancelled) return;
        // The package's index.d.ts re-export hides `default` from type
        // queries, but the runtime ESM module does export it (see
        // rehype-katex/index.js -> lib/index.js).
        const plugin = (katexModule as unknown as { default: RehypePlugin })
          .default;
        // Thunk form: the plugin itself is a function, which setState would
        // otherwise mistake for an updater.
        setKatexPlugin(() => plugin);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [containsMath]);
  const rehypePlugins = useMemo(
    (): ComponentProps<typeof ReactMarkdown>["rehypePlugins"] => [
      rehypeRaw,
      [rehypeSanitize, sanitizeSchema],
      ...(katexPlugin ? [katexPlugin] : []),
    ],
    [katexPlugin],
  );
  const components = useMemo<Components>(
    () => ({
      a: ({ node: _node, ...props }) => (
        <a {...props} target="_blank" rel="noreferrer" />
      ),
      input: ({ node: _node, ...props }) => <input {...props} disabled />,
      h2: ({ children: headingChildren, ...props }) => (
        <h2 id={slugifyHeading(flattenText(headingChildren))} {...props}>
          {headingChildren}
        </h2>
      ),
      h3: ({ children: headingChildren, ...props }) => (
        <h3 id={slugifyHeading(flattenText(headingChildren))} {...props}>
          {headingChildren}
        </h3>
      ),
      pre: ({ children: preChildren }) => <>{preChildren}</>,
      code: ({ className, children: codeChildren }) => {
        const code = String(codeChildren).replace(/\n$/, "");
        const language = className?.replace("language-", "") || "";
        // Math nodes render as code.language-math until the lazily-loaded
        // KaTeX plugin replaces them; keep them as plain inline code in the
        // meantime instead of a full code block (which would also nest a
        // <div> inside a <p> for inline math).
        if (className?.includes("language-math"))
          return <code className={className}>{codeChildren}</code>;
        if (!className?.includes("language-") && !code.includes("\n"))
          return <code className={className}>{codeChildren}</code>;
        return language === "mermaid" ? (
          <MermaidBlock code={code} isStreaming={isStreaming} />
        ) : (
          <CodeBlock
            code={code}
            language={language}
            isStreaming={isStreaming}
          />
        );
      },
      table: ({ children: tableChildren, ...props }) => (
        <div className="md-table-wrapper">
          <table {...props}>{tableChildren}</table>
        </div>
      ),
      td: ({ children: cellChildren, ...props }) => (
        <td {...props}>
          {Children.toArray(cellChildren).map((child, childIndex) =>
            typeof child === "string"
              ? child.split("\u2028").map((line, lineIndex) => (
                  <span key={`${childIndex}-${lineIndex}`}>
                    {lineIndex > 0 && <br />}
                    {line}
                  </span>
                ))
              : child,
          )}
        </td>
      ),
    }),
    [isStreaming],
  );

  if (formatted.length > MAX_MARKDOWN_CHARS && !showLargeMessage)
    return (
      <button
        className="markdown-large-message"
        onClick={() => setShowLargeMessage(true)}
      >
        Large response ({Math.ceil(formatted.length / 1000)} KB) — show as text
      </button>
    );
  if (formatted.length > MAX_MARKDOWN_CHARS)
    return <pre className="markdown-large-message-content">{formatted}</pre>;

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {formatted}
      </ReactMarkdown>
    </div>
  );
}

// The parent re-renders the whole message list on every stream frame; bail
// out unless the text or the streaming flag actually changed so idle sibling
// messages don't re-parse markdown + KaTeX every frame.
export function areMarkdownMessagePropsEqual(
  prev: MarkdownMessageProps,
  next: MarkdownMessageProps,
): boolean {
  return (
    prev.children === next.children &&
    (prev.isStreaming ?? false) === (next.isStreaming ?? false)
  );
}

export default memo(MarkdownMessage, areMarkdownMessagePropsEqual);
